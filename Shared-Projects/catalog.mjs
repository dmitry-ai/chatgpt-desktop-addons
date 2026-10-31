// 2026-10-15 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Synchronize workspace projects and folder catalog between C1 and C2 with trust-free replica restore (Shared-Projects)":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/7
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {applyOperation, validate as validateFolders, emptyState} from '../Folders/store.mjs';
import {backupProfiles} from './backup.mjs';
export const stateDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'state');
export const catalogFile = path.join(stateDirectory, 'catalog.json');
const clone = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const fields = p => ({name: p.name, rootPaths: [...p.rootPaths]});
const local = p => p && !p.cloudBacked && !p.chatGptBacking && !p.chatGptBackingCreation && !p.retiredChatGptBacking;
export function rootKey(root) {
	return /^[a-z]:[\\/]|^[\\/]{2}[^\\/]/i.test(root)
		? path.win32.normalize(root).replace(/[\\/]+$/, '').toLowerCase()
		: path.posix.normalize(root).replace(/\/$/, '');
}
export const identity = p => JSON.stringify(p.rootPaths.map(rootKey));
const nativeKey = id => 'local:project:' + id;
function validProject(p) {
	return p &&
		'string' === typeof p.id &&
		p.id &&
		'string' === typeof p.name &&
		p.name.trim() &&
		Array.isArray(p.rootPaths) &&
		p.rootPaths.length &&
		p.rootPaths.every(r => 'string' === typeof r && r && (path.win32.isAbsolute(r) || path.posix.isAbsolute(r)));
}
function conflict(state, value) {
	const key = JSON.stringify([value.kind, value.projectId, value.profile, value.field]);
	const existing = state.conflicts.find(c => c.key === key);
	if (existing) {
		Object.assign(existing, value);
	}
	else {
		state.conflicts.push({id: randomUUID(), key, createdAt: new Date().toISOString(), ...value});
	}
}
function ensureBindings(state) {
	for (const profile of Object.values(state.profiles)) {
		for (const project of Object.values(state.projects)) {
			if (!project.deleted && !profile.bindings[project.id]) {
				profile.bindings[project.id] = {desktopId: randomUUID(), lastSeen: null, known: false};
			}
		}
	}
}
function logicalForNative(state, profile, key) {
	let r = null;
	if (key.startsWith('shared:') && state.projects[key.slice(7)]) {
		r = key.slice(7);
	}
	else {
		for (const [id, binding] of Object.entries(state.profiles[profile].bindings)) {
			if (!r && (key === binding.desktopId || key.endsWith(':' + binding.desktopId))) {
				r = id;
			}
		}
	}
	if (!r) {
		throw Error('Project is not mapped across profiles yet');
	}
	return r;
}
export function validateCatalog(state) {
	if (
		1 !== state?.schemaVersion ||
		!Number.isSafeInteger(state.revision) ||
		0 > state.revision ||
		!state.projects ||
		!state.profiles ||
		!Array.isArray(state.projectOrder) ||
		!Array.isArray(state.conflicts) ||
		!Array.isArray(state.operations)
	) {
		throw Error('Invalid shared catalog format');
	}
	for (const [id, p] of Object.entries(state.projects)) {
		if (id !== p.id || !validProject(p)) {
			throw Error('Invalid shared project');
		}
		if (undefined !== p.trustPolicy && 'upwork-daily' !== p.trustPolicy) {
			throw Error('Unknown project trust policy');
		}
	}
	if (new Set(state.projectOrder).size !== state.projectOrder.length || state.projectOrder.some(id => !state.projects[id])) {
		throw Error('Invalid shared project order');
	}
	validateFolders({schemaVersion: 1, revision: state.revision, folders: state.folders, projectFolderMap: state.projectFolderMap, collapsedFolderIds: []});
	for (const id of Object.keys(state.projectFolderMap)) {
		if (!state.projects[id]) {
			throw Error('Folder references an unknown project');
		}
	}
	for (const profile of Object.values(state.profiles)) {
		if (!profile.bindings || !Array.isArray(profile.collapsedFolderIds)) {
			throw Error('Invalid profile bindings');
		}
		if (undefined !== profile.pauseReason && 'string' !== typeof profile.pauseReason) {
			throw Error('Invalid pause reason');
		}
		const ids = new Set();
		for (const [id, b] of Object.entries(profile.bindings)) {
			if (!state.projects[id] || 'string' !== typeof b.desktopId || !b.desktopId || ids.has(b.desktopId)) {
				throw Error('Duplicate or unknown project binding');
			}
			ids.add(b.desktopId);
			if (null !== b.lastSeen && (!b.lastSeen || 'string' !== typeof b.lastSeen.name || !Array.isArray(b.lastSeen.rootPaths))) {
				throw Error('Invalid profile project state');
			}
		}
		if (profile.collapsedFolderIds.some(id => !state.folders.some(f => f.id === id))) {
			throw Error('Unknown collapsed folder');
		}
	}
	for (const op of state.operations) {
		if (!state.projects[op.projectId] || !state.profiles[op.profile] || !['upsert', 'remove'].includes(op.type)) {
			throw Error('Invalid pending operation');
		}
	}
	return state;
}
export function migrateSeeds(seeds) {
	const state = {
		schemaVersion: 1,
		revision: 1,
		createdAt: new Date().toISOString(),
		projects: {},
		projectOrder: [],
		folders: [],
		projectFolderMap: {},
		profiles: {},
		conflicts: [],
		operations: [],
		migration: {profiles: seeds.map(s => s.id)}
	};
	const folderPaths = new Map();
	for (const seed of seeds) {
		const oldFolders = validateFolders(seed.folders ?? emptyState());
		const profile = state.profiles[seed.id] = {bindings: {}, collapsedFolderIds: [], folderAliases: {}};
		const projects = Object.values(seed.projects ?? {}).filter(local);
		const byId = new Map(projects.map(p => [p.id, p]));
		const ordered = [...new Set([...(seed.order ?? []), ...byId.keys()])].map(id => byId.get(id)).filter(Boolean);
		for (const p of ordered) {
			if (!validProject(p)) {
				throw Error('Invalid source project ' + p.id);
			}
			const matches = Object.values(state.projects).filter(q => identity(q) === identity(p) && !profile.bindings[q.id]);
			if (1 < matches.length) {
				throw Error('Ambiguous project match for ' + p.name);
			}
			let shared = matches[0];
			if (!shared) {
				shared = {id: randomUUID(), ...fields(p)};
				state.projects[shared.id] = shared;
				state.projectOrder.push(shared.id);
			}
			else if (shared.name !== p.name) {
				conflict(state, {kind: 'field', projectId: shared.id, profile: seed.id, field: 'name', baseValue: shared.name, sharedValue: shared.name, localValue: p.name});
			}
			profile.bindings[shared.id] = {desktopId: p.id, lastSeen: fields(p), known: true};
		}
		const oldById = new Map(oldFolders.folders.map(f => [f.id, f]));
		const folderPath = id => {
			const f = oldById.get(id);
			return [...(null === f.parentId ? [] : folderPath(f.parentId)), f.name.normalize('NFKC').toLocaleLowerCase('en-US')];
		};
		const visit = id => {
			let r = profile.folderAliases[id];
			if (!r) {
				const old = oldById.get(id);
				const parentId = null === old.parentId ? null : visit(old.parentId);
				const key = JSON.stringify(folderPath(id));
				let shared = folderPaths.get(key);
				if (!shared) {
					shared = {id: state.folders.some(f => f.id === id) ? randomUUID() : id, name: old.name, parentId};
					state.folders.push(shared);
					folderPaths.set(key, shared);
				}
				profile.folderAliases[id] = shared.id;
				r = shared.id;
			}
			return r;
		};
		for (const f of oldFolders.folders) {
			visit(f.id);
		}
		profile.collapsedFolderIds = oldFolders.collapsedFolderIds.map(id => profile.folderAliases[id]);
		for (const [key, oldFolder] of Object.entries(oldFolders.projectFolderMap)) {
			const match = Object.entries(profile.bindings).find(([, b]) => key === b.desktopId || key.endsWith(':' + b.desktopId));
			if (match) {
				const id = match[0];
				const folder = profile.folderAliases[oldFolder];
				if (!state.projectFolderMap[id] || state.projectFolderMap[id] === folder) {
					state.projectFolderMap[id] = folder;
				}
				else {
					conflict(state, {kind: 'folder', projectId: id, profile: seed.id, field: 'folder', sharedValue: state.projectFolderMap[id], localValue: folder});
				}
			}
		}
	}
	ensureBindings(state);
	return validateCatalog(state);
}
export function observeProjects(state, profileId, snapshot, event = null) {
	const profile = state.profiles[profileId];
	if (!profile) {
		throw Error('Unknown profile');
	}
	const projects = Object.values(snapshot).filter(local);
	for (const p of projects) {
		if (!validProject(p)) {
			throw Error('Incomplete project service response');
		}
	}
	for (const op of [...state.operations]) {
		if (op.profile === profileId && 'remove' === op.type && !snapshot[op.desktopId]) {
			acknowledge(state, op, {removed: true});
		}
	}
	const explicitRemoved = new Set('removeLocal' === event?.method ? Object.keys(event.before ?? {}).filter(id => !event.after?.[id]) : []);
	const bindingByDesktop = new Map(Object.entries(profile.bindings).map(([id, b]) => [b.desktopId, {id, b}]));
	for (const desktopId of explicitRemoved) {
		const found = bindingByDesktop.get(desktopId);
		if (found) {
			const p = state.projects[found.id];
			p.deleted = true;
			found.b.lastSeen = null;
			found.b.missing = false;
			state.conflicts = state.conflicts.filter(c => !('missing' === c.kind && c.projectId === p.id && c.profile === profileId));
		}
	}
	for (const p of projects) {
		let found = bindingByDesktop.get(p.id);
		if (!found) {
			const matches = Object.values(state.projects).filter(q => !q.deleted && identity(q) === identity(p));
			const free = matches.filter(q => !profile.bindings[q.id] || (!snapshot[profile.bindings[q.id].desktopId] && !profile.bindings[q.id].known));
			const migrated = event ? [] : matches.filter(q => profile.bindings[q.id]?.known && !snapshot[profile.bindings[q.id].desktopId]);
			let shared = 1 === free.length ? free[0] : 1 === migrated.length ? migrated[0] : null;
			if (!shared) {
				shared = {id: randomUUID(), ...fields(p)};
				state.projects[shared.id] = shared;
				state.projectOrder.push(shared.id);
			}
			const b = profile.bindings[shared.id] = {desktopId: p.id, lastSeen: fields(p), known: true};
			found = {id: shared.id, b};
			bindingByDesktop.set(p.id, found);
			state.conflicts = state.conflicts.filter(c => !('missing' === c.kind && c.projectId === shared.id && c.profile === profileId));
			if (shared.name !== p.name) {
				conflict(state, {kind: 'field', projectId: shared.id, profile: profileId, field: 'name', baseValue: shared.name, sharedValue: shared.name, localValue: p.name});
			}
		}
		const shared = state.projects[found.id];
		const binding = found.b;
		const observed = fields(p);
		const pending = state.operations.find(o => o.profile === profileId && o.projectId === shared.id && 'upsert' === o.type);
		if (pending && equal(observed, pending.value)) {
			binding.lastSeen = observed;
			binding.known = true;
			binding.missing = false;
			state.operations = state.operations.filter(o => o.id !== pending.id);
		}
		else {
			let skipDeleted = false;
			if (shared.deleted) {
				const restored = event && ['upsertLocal', 'createLocal'].includes(event.method) && !event.before?.[p.id];
				if (!restored) {
					skipDeleted = true;
				}
				else {
					delete shared.deleted;
					Object.assign(shared, observed);
				}
			}
			if (!skipDeleted) {
				if (null !== binding.lastSeen) {
					for (const key of ['name', 'rootPaths']) {
						if (!equal(observed[key], binding.lastSeen[key])) {
							if (equal(shared[key], binding.lastSeen[key]) || equal(shared[key], observed[key])) {
								shared[key] = clone(observed[key]);
							}
							else {
								conflict(state, {kind: 'field', projectId: shared.id, profile: profileId, field: key, baseValue: clone(binding.lastSeen[key]), sharedValue: clone(shared[key]), localValue: clone(observed[key])});
							}
						}
					}
				}
				binding.lastSeen = observed;
				binding.known = true;
				binding.missing = false;
				state.conflicts = state.conflicts.filter(c => !('missing' === c.kind && c.projectId === shared.id && c.profile === profileId));
			}
		}
	}
	for (const [id, b] of Object.entries(profile.bindings)) {
		if (b.known && !snapshot[b.desktopId] && !state.projects[id].deleted && !state.projects[id].cleanupHold && null !== b.lastSeen) {
			b.missing = true;
			conflict(state, {kind: 'missing', projectId: id, profile: profileId, field: 'presence', sharedValue: true, localValue: false});
		}
	}
	if ('setProjectOrder' === event?.method && Array.isArray(event.args?.[0])) {
		const ids = event.args[0].map(native => bindingByDesktop.get(native)?.id).filter(Boolean);
		if (ids.length) {
			const included = new Set(ids);
			const old = state.projectOrder;
			let i = 0;
			state.projectOrder = old.map(id => included.has(id) ? ids[i++] : id);
			for (const id of ids) {
				if (!state.projectOrder.includes(id)) {
					state.projectOrder.push(id);
				}
			}
		}
	}
	ensureBindings(state);
	return state;
}
export function planOperation(state, profileId, snapshot) {
	const profile = state.profiles[profileId];
	let r = null;
	if (!profile.pauseReason) {
		state.operations = state.operations.filter(op => {
			let keep = true;
			if (op.profile === profileId && !op.startedAt) {
				const p = state.projects[op.projectId];
				const b = profile.bindings[op.projectId];
				const actual = snapshot[b.desktopId];
				keep = p.deleted ? 'remove' === op.type && !!actual : 'upsert' === op.type && equal(op.value, fields(p)) && (!actual || !equal(fields(actual), fields(p)));
			}
			return keep;
		});
		const started = state.operations.find(op => op.profile === profileId && op.startedAt);
		if (started) {
			r = clone(started);
		}
		else {
			for (const id of state.projectOrder) {
				if (!r) {
					const p = state.projects[id];
					const b = profile.bindings[id];
					if (b && !p.cleanupHold && !b.registrationBlock && !state.conflicts.some(c => c.projectId === id)) {
						const actual = snapshot[b.desktopId];
						let sourceReady = true;
						if (!actual && p.registrationSource && p.registrationSource !== profileId) {
							const source = state.profiles[p.registrationSource]?.bindings[id];
							if (!source?.known || source.missing || !source.lastSeen || !equal(source.lastSeen.rootPaths.map(rootKey), p.rootPaths.map(rootKey))) {
								sourceReady = false;
							}
						}
						if (
							sourceReady &&
							!(p.deleted && !actual) &&
							!(!p.deleted && actual && equal(fields(actual), fields(p))) &&
							!(!p.deleted && b.missing)
						) {
							const type = p.deleted ? 'remove' : 'upsert';
							const value = p.deleted ? null : fields(p);
							let op = state.operations.find(o => o.profile === profileId && o.projectId === id);
							if (!op || op.type !== type || !equal(op.value, value)) {
								state.operations = state.operations.filter(o => !(o.profile === profileId && o.projectId === id));
								op = {
									id: randomUUID(),
									profile: profileId,
									projectId: id,
									desktopId: b.desktopId,
									type,
									value,
									expected: actual ? fields(actual) : null,
									createdAt: new Date().toISOString()
								};
								state.operations.push(op);
							}
							op.expected = actual ? fields(actual) : null;
							const approvedBy = !actual && !p.deleted
								? Object.entries(state.profiles).find(([other, q]) => {
									const source = q.bindings[id];
									return other !== profileId && source?.known && !source.missing && source.lastSeen &&
										equal(source.lastSeen.rootPaths.map(rootKey), p.rootPaths.map(rootKey));
								})?.[0]
								: null;
							op.registration = approvedBy ? 'restore' : 'sync';
							op.approvedBy = approvedBy ?? null;
							r = clone(op);
						}
					}
				}
			}
		}
	}
	return r;
}
export function acknowledge(state, operation, result) {
	const op = state.operations.find(o => o.id === operation.id);
	if (op) {
		const b = state.profiles[op.profile].bindings[op.projectId];
		b.lastSeen = 'remove' === op.type ? null : fields(result);
		b.known = 'remove' !== op.type;
		b.missing = false;
		if (result.trust) {
			b.trust = clone(result.trust);
		}
		delete b.registrationBlock;
		state.operations = state.operations.filter(o => o.id !== op.id);
	}
}
export function markStarted(state, id) {
	const op = state.operations.find(o => o.id === id);
	let r = null;
	if (op) {
		op.startedAt ??= new Date().toISOString();
		r = clone(op);
	}
	return r;
}
export function failOperation(state, id, error, {pause = false, registrationBlock = null} = {}) {
	const op = state.operations.find(o => o.id === id);
	if (op) {
		state.operations = state.operations.filter(o => o.id !== id);
		if (pause) {
			state.profiles[op.profile].pauseReason = String(error);
		}
		if (registrationBlock) {
			state.profiles[op.profile].bindings[op.projectId].registrationBlock = {status: registrationBlock, error: String(error)};
		}
	}
}
export function resumeSync(state) {
	for (const p of Object.values(state.profiles)) {
		delete p.pauseReason;
		for (const b of Object.values(p.bindings)) {
			delete b.registrationBlock;
		}
	}
}
export function pendingCount(state, profileId) {
	let r = 0;
	for (const p of Object.values(state.projects)) {
		const b = state.profiles[profileId].bindings[p.id];
		if (b && (p.deleted ? null !== b.lastSeen : !equal(b.lastSeen, fields(p)))) {
			r++;
		}
	}
	return r;
}
export function resolveConflict(state, id, choice) {
	const c = state.conflicts.find(c => c.id === id);
	if (!c || !['shared', 'local'].includes(choice)) {
		throw Error('Conflict or resolution choice not found');
	}
	if (state.operations.some(o => o.projectId === c.projectId && o.startedAt)) {
		throw Error('Complete the pending operation in the app first');
	}
	const p = state.projects[c.projectId];
	const b = state.profiles[c.profile].bindings[c.projectId];
	if ('missing' === c.kind) {
		if ('local' === choice) {
			p.deleted = true;
		}
		else {
			b.lastSeen = null;
			b.known = false;
			b.missing = false;
		}
	}
	else if ('folder' === c.kind) {
		const target = 'local' === choice ? c.localValue : c.sharedValue;
		if (!target) {
			delete state.projectFolderMap[p.id];
		}
		else {
			state.projectFolderMap[p.id] = target;
		}
	}
	else {
		p[c.field] = clone('local' === choice ? c.localValue : c.sharedValue);
	}
	state.conflicts = state.conflicts.filter(other => other.projectId !== c.projectId || other.field !== c.field);
	state.operations = state.operations.filter(o => o.projectId !== c.projectId);
}
export function folderOperation(state, profileId, operation) {
	if ('resolve-conflict' === operation.type) {
		resolveConflict(state, operation.id, operation.choice);
	}
	else {
		const profile = state.profiles[profileId];
		const op = {...operation};
		if ('assign' === op.type) {
			op.projectKey = logicalForNative(state, profileId, op.projectKey);
		}
		const next = applyOperation({
			schemaVersion: 1,
			revision: state.revision,
			folders: state.folders,
			projectFolderMap: state.projectFolderMap,
			collapsedFolderIds: profile.collapsedFolderIds
		}, op);
		state.folders = next.folders;
		state.projectFolderMap = next.projectFolderMap;
		profile.collapsedFolderIds = next.collapsedFolderIds;
		for (const p of Object.values(state.profiles)) {
			p.collapsedFolderIds = p.collapsedFolderIds.filter(id => state.folders.some(f => f.id === id));
		}
	}
}
export function assignCreatedProject(state, profileId, snapshot, projectId, folderId) {
	if (!state.profiles[profileId] || !state.folders.some(f => f.id === folderId)) {
		throw Error('Folder has already been deleted');
	}
	if (!snapshot[projectId] || !local(snapshot[projectId])) {
		throw Error('Created local project not found');
	}
	observeProjects(state, profileId, snapshot);
	folderOperation(state, profileId, {type: 'assign', projectKey: nativeKey(projectId), folderId});
	const ancestors = new Set();
	let folder = state.folders.find(f => f.id === folderId);
	while (folder) {
		ancestors.add(folder.id);
		folder = state.folders.find(f => f.id === folder.parentId);
	}
	state.profiles[profileId].collapsedFolderIds = state.profiles[profileId].collapsedFolderIds.filter(id => !ancestors.has(id));
}
// 2026-10-17 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Add C1 post-update UI recovery, DWM freeze resilience, and idempotent external project registration with auto-trust policy":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/9
export function selectRegistrationSources(state, availableProfiles) {
	const available = availableProfiles.filter(id => state.profiles[id]);
	if (available.length) {
		for (const project of Object.values(state.projects)) {
			if (!project.deleted && project.trustPolicy && project.registrationSource && !available.includes(project.registrationSource) && !state.operations.some(op => op.projectId === project.id && op.startedAt)) {
				const registered = Object.values(state.profiles).some(p => {
					const b = p.bindings[project.id];
					return b?.known && !b.missing && b.lastSeen && identity(b.lastSeen) === identity(project);
				});
				if (!registered) {
					project.registrationSource = available[0];
				}
			}
		}
	}
}
export function ensureProject(state, profileId, spec, {availableProfiles = []} = {}) {
	if (!state.profiles[profileId]) {
		throw Error('Unknown source profile');
	}
	if (
		!spec ||
		!validProject({id: 'validation', ...spec}) ||
		!Array.isArray(spec.folderPath) ||
		!spec.folderPath.length ||
		spec.folderPath.some(name => 'string' !== typeof name || !name.trim() || 160 < name.length)
	) {
		throw Error('Invalid project registration request');
	}
	if (undefined !== spec.trustPolicy && 'upwork-daily' !== spec.trustPolicy) {
		throw Error('Unknown project trust policy');
	}
	const matches = Object.values(state.projects).filter(p => !p.deleted && identity(p) === identity(spec));
	if (1 < matches.length) {
		throw Error('Ambiguous project working directory match');
	}
	let project = matches[0];
	if (project && state.conflicts.some(c => c.projectId === project.id)) {
		throw Error('Resolve the shared project conflict first');
	}
	if (!project) {
		project = {id: randomUUID(), ...fields(spec), registrationSource: profileId};
		state.projects[project.id] = project;
		state.projectOrder.push(project.id);
		ensureBindings(state);
	}
	if (spec.trustPolicy) {
		project.trustPolicy = spec.trustPolicy;
	}
	selectRegistrationSources(state, availableProfiles);
	let parentId = null;
	for (const name of spec.folderPath) {
		const folderMatches = state.folders.filter(f => f.parentId === parentId && f.name.normalize('NFKC').toLocaleLowerCase('en-US') === name.normalize('NFKC').toLocaleLowerCase('en-US'));
		if (1 < folderMatches.length) {
			throw Error('Ambiguous folder branch');
		}
		let folder = folderMatches[0];
		if (!folder) {
			folder = {id: randomUUID(), name, parentId};
			folderOperation(state, profileId, {type: 'create', ...folder});
		}
		parentId = folder.id;
	}
	folderOperation(state, profileId, {type: 'assign', projectKey: 'shared:' + project.id, folderId: parentId});
	return registrationReceipt(state, project.id, profileId);
}
export function registrationReceipt(state, id, profileId) {
	const project = state.projects[id];
	if (!project || project.deleted || !state.profiles[profileId]) {
		throw Error('Shared project or profile not found');
	}
	const folderId = state.projectFolderMap[id];
	const branch = [];
	let folder = state.folders.find(f => f.id === folderId);
	while (folder) {
		branch.unshift(folder.name);
		folder = state.folders.find(f => f.id === folder.parentId);
	}
	const profiles = Object.fromEntries(Object.entries(state.profiles).map(([name, p]) => {
		const binding = p.bindings[id];
		const ready = !!(binding?.known && !binding.missing && equal(binding.lastSeen, fields(project)));
		return [name, {
			project_id: binding?.desktopId ?? null,
			ready,
			pause_reason: p.pauseReason ?? null,
			registration_block: binding?.registrationBlock ?? null,
			trust: binding?.trust ?? null
		}];
	}));
	return {
		shared_id: id,
		project_name: project.name,
		root_paths: [...project.rootPaths],
		folder_id: folderId,
		folder_path: branch.join(' / '),
		profiles,
		complete: profiles[profileId].ready,
		status: profiles[profileId].ready ? 'registered' : profiles[profileId].registration_block?.status ?? 'pending',
		registration_source: project.registrationSource ?? null,
		trust_policy: project.trustPolicy ?? null,
		conflicts: state.conflicts.filter(c => c.projectId === id)
	};
}
export function projectState(state, profileId, status = {}) {
	const profile = state.profiles[profileId];
	const map = {};
	const order = [];
	for (const id of state.projectOrder) {
		const p = state.projects[id];
		const b = profile.bindings[id];
		if (b && !p.deleted) {
			for (const key of [nativeKey(b.desktopId), 'codex:project:' + b.desktopId, 'local:' + b.desktopId, 'codex:' + b.desktopId]) {
				if (state.projectFolderMap[id]) {
					map[key] = state.projectFolderMap[id];
				}
				order.push(key);
			}
		}
	}
	return {
		schemaVersion: 1,
		revision: state.revision,
		folders: clone(state.folders),
		projectFolderMap: map,
		collapsedFolderIds: clone(profile.collapsedFolderIds),
		projectOrder: order,
		sync: {
			...status,
			shared: true,
			conflicts: state.conflicts.map(c => ({...c, projectName: state.projects[c.projectId]?.name})),
			profiles: Object.keys(state.profiles).map(id => ({id, pending: pendingCount(state, id)}))
		}
	};
}
async function readSeeds(profiles) {
	return Promise.all(profiles.map(async profile => {
		const global = JSON.parse(await fs.readFile(path.join(profile.home, '.codex-global-state.json'), 'utf8'));
		let folders;
		try {
			folders = JSON.parse(await fs.readFile(path.join(profile.home, 'ui-folders.json'), 'utf8'));
		}
		catch (e) {
			if ('ENOENT' !== e.code) {
				throw e;
			}
			folders = emptyState();
		}
		return {id: profile.id, projects: global['local-projects'] ?? {}, order: global['project-order'] ?? [], folders};
	}));
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class CatalogStore {
	constructor(file = catalogFile) {
		this.file = file;
		this.state = null;
		this.queue = Promise.resolve();
	}
	async load(profiles) {
		try {
			this.state = validateCatalog(JSON.parse(await fs.readFile(this.file, 'utf8')));
		}
		catch (error) {
			if ('ENOENT' !== error.code) {
				throw error;
			}
			const seeds = await readSeeds(profiles);
			const state = migrateSeeds(seeds);
			const backup = path.join(path.dirname(this.file), 'backups', 'migration-' + new Date().toISOString().replace(/[:.]/g, '-'));
			await backupProfiles(profiles, backup);
			if (digest(seeds) !== digest(await readSeeds(profiles))) {
				throw Error('Projects or folders changed during migration preparation. Restart the companion.');
			}
			state.migration.backup = backup;
			state.migration.inputDigest = digest(seeds);
			await this.write(state, false);
			this.state = state;
			await fs.writeFile(path.join(backup, 'migration-plan.json'), JSON.stringify({
				projects: Object.values(state.projects).map(p => ({
					name: p.name,
					rootPaths: p.rootPaths,
					profiles: Object.fromEntries(Object.entries(state.profiles).map(([id, q]) => [id, q.bindings[p.id]]))
				})),
				folders: state.folders
			}, null, 2) + '\n');
		}
		return clone(this.state);
	}
	async write(state, backup = true) {
		validateCatalog(state);
		await fs.mkdir(path.dirname(this.file), {recursive: true});
		if (backup && this.state) {
			await fs.writeFile(this.file + '.bak', JSON.stringify(this.state, null, 2) + '\n');
		}
		const temp = this.file + '.' + process.pid + '.tmp';
		try {
			await fs.writeFile(temp, JSON.stringify(state, null, 2) + '\n');
			await fs.rename(temp, this.file);
		}
		finally {
			await fs.rm(temp, {force: true});
		}
	}
	transact(action) {
		const r = this.queue.then(async () => {
			const current = validateCatalog(JSON.parse(await fs.readFile(this.file, 'utf8')));
			const next = clone(current);
			const result = await action(next);
			if (equal(current, next)) {
				this.state = current;
			}
			else {
				next.revision = current.revision + 1;
				this.state = current;
				await this.write(next);
				this.state = next;
			}
			return {state: clone(this.state), result};
		});
		this.queue = r.catch(() => {});
		return r;
	}
}
