// 2026-10-15 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Implement sidebar project folder hierarchy (Folders), context menus, compact panel styling (CSS), and background CDP injection daemon (UI)":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/6
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export const emptyState = () => ({
	schemaVersion: 1,
	revision: 0,
	folders: [],
	projectFolderMap: {},
	collapsedFolderIds: []
});
const sameName = name => name.normalize('NFKC').toLocaleLowerCase('en-US');
export function validate(state) {
	if (
		1 !== state?.schemaVersion ||
		!Number.isSafeInteger(state.revision) ||
		0 > state.revision ||
		!Array.isArray(state.folders) ||
		!state.projectFolderMap ||
		Array.isArray(state.projectFolderMap) ||
		'object' !== typeof state.projectFolderMap ||
		!Array.isArray(state.collapsedFolderIds)
	) {
		throw Error('Invalid ui-folders.json format');
	}
	const ids = new Map();
	const names = new Set();
	for (const folder of state.folders) {
		if (
			'string' !== typeof folder.id ||
			!folder.id ||
			ids.has(folder.id) ||
			'string' !== typeof folder.name ||
			!folder.name.trim() ||
			160 < folder.name.length ||
			(null !== folder.parentId && 'string' !== typeof folder.parentId)
		) {
			throw Error('Invalid folder');
		}
		const key = JSON.stringify([folder.parentId, sameName(folder.name.trim())]);
		if (names.has(key)) {
			throw Error('A folder with this name already exists in this location');
		}
		ids.set(folder.id, folder);
		names.add(key);
	}
	for (const folder of state.folders) {
		const visited = new Set([folder.id]);
		let id = folder.parentId;
		while (null !== id) {
			if (!ids.has(id)) {
				throw Error('Parent folder not found');
			}
			if (visited.has(id)) {
				throw Error('Cannot move a folder into itself or its subfolder');
			}
			visited.add(id);
			id = ids.get(id).parentId;
		}
	}
	for (const [key, id] of Object.entries(state.projectFolderMap)) {
		if (!key || 'string' !== typeof id || !ids.has(id)) {
			throw Error('Invalid project binding');
		}
	}
	if (state.collapsedFolderIds.some(id => !ids.has(id))) {
		throw Error('Invalid collapsed folder state');
	}
	return state;
}
export function applyOperation(previous, operation) {
	const state = structuredClone(validate(previous));
	const folder = () => {
		const r = state.folders.find(f => f.id === operation.id);
		if (!r) {
			throw Error('Folder has already been deleted');
		}
		return r;
	};
	switch (operation.type) {
		case 'create':
			state.folders.push({
				id: operation.id ?? randomUUID(),
				name: String(operation.name ?? '').trim(),
				parentId: operation.parentId ?? null
			});
			break;
		case 'rename':
			folder().name = String(operation.name ?? '').trim();
			break;
		case 'edit': {
			const f = folder();
			f.name = String(operation.name ?? '').trim();
			f.parentId = operation.parentId ?? null;
			break;
		}
		case 'move':
			folder().parentId = operation.parentId ?? null;
			break;
		case 'remove': {
			const value = folder();
			state.folders = state.folders
				.filter(f => f.id !== value.id)
				.map(f => f.parentId === value.id ? {...f, parentId: value.parentId} : f);
			for (const [key, id] of Object.entries(state.projectFolderMap)) {
				if (id === value.id) {
					if (null === value.parentId) {
						delete state.projectFolderMap[key];
					}
					else {
						state.projectFolderMap[key] = value.parentId;
					}
				}
			}
			state.collapsedFolderIds = state.collapsedFolderIds.filter(id => id !== value.id);
			break;
		}
		case 'assign':
			if ('string' !== typeof operation.projectKey || !operation.projectKey || 700 < operation.projectKey.length) {
				throw Error('Project is not specified');
			}
			if (null == operation.folderId) {
				delete state.projectFolderMap[operation.projectKey];
			}
			else {
				state.projectFolderMap[operation.projectKey] = operation.folderId;
			}
			break;
		case 'collapse': {
			folder();
			const ids = new Set(state.collapsedFolderIds);
			operation.collapsed ? ids.add(operation.id) : ids.delete(operation.id);
			state.collapsedFolderIds = [...ids];
			break;
		}
		default:
			throw Error('Unknown folder operation');
	}
	state.revision++;
	return validate(state);
}
export class FolderStore {
	constructor(file) {
		this.file = file;
		this.state = null;
		this.queue = Promise.resolve();
	}
	async load() {
		try {
			this.state = validate(JSON.parse(await fs.readFile(this.file, 'utf8')));
		}
		catch (error) {
			if ('ENOENT' !== error.code) {
				throw error;
			}
			this.state = emptyState();
			await this.write(this.state, false);
		}
		return structuredClone(this.state);
	}
	async write(state, backup = true) {
		await fs.mkdir(path.dirname(this.file), {recursive: true});
		if (backup && this.state) {
			await fs.writeFile(this.file + '.bak', JSON.stringify(this.state, null, 2) + '\n');
		}
		const temp = this.file + '.' + process.pid + '.tmp';
		try {
			await fs.writeFile(temp, JSON.stringify(state, null, 2) + '\n', {flag: 'w'});
			await fs.rename(temp, this.file);
		}
		finally {
			await fs.rm(temp, {force: true});
		}
	}
	operate(operation) {
		const r = this.queue.then(async () => {
			const latest = validate(JSON.parse(await fs.readFile(this.file, 'utf8')));
			const next = applyOperation(latest, operation);
			this.state = latest;
			await this.write(next);
			this.state = next;
			return structuredClone(next);
		});
		this.queue = r.catch(() => {});
		return r;
	}
	reload() {
		const r = this.queue.then(() => this.load());
		this.queue = r.catch(() => {});
		return r;
	}
}
