// 2026-10-17 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Add C1 post-update UI recovery, DWM freeze resilience, and idempotent external project registration with auto-trust policy":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/9
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {rootKey, fields, identity} from './catalog.mjs';
function workspaceKey(value) {
	if ('string' !== typeof value || !value) {
		throw Error('Unknown working directory');
	}
	if (value.startsWith('file:')) {
		value = fileURLToPath(value);
	}
	if (value.startsWith('\\\\?\\UNC\\')) {
		value = '\\\\' + value.slice(8);
	}
	else if (value.startsWith('\\\\?\\')) {
		value = value.slice(4);
	}
	return rootKey(value);
}
function hasConversations(message) {
	const r = Error(message);
	r.code = 'PROJECT_HAS_CONVERSATIONS';
	return r;
}
async function readUnlinked(file) {
	for (let current = path.resolve(file); ; current = path.dirname(current)) {
		if ((await fs.lstat(current)).isSymbolicLink()) {
			throw Error('Symlinked project creation evidence preserved');
		}
		if (path.dirname(current) === current) {
			break;
		}
	}
	return (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
}
// 2026-10-31 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Integrate with universal dmitry-ai/harness, format codebase per P.md/P.ES6.md/P.Bash.md, and link source files to GitHub Issues":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/16
export async function initializationState(root, {primary, policyFile} = {}) {
	let r = null;
	try {
		r = JSON.parse(await readUnlinked(path.join(root, 'ꘖ', 'project.json')));
	}
	catch (error) {
		if ('ENOENT' !== error.code) {
			throw error;
		}
	}
	if (!r) {
		if (!primary) {
			const policy = JSON.parse(await readUnlinked(policyFile ?? fileURLToPath(new URL('./trust-policy.json', import.meta.url))));
			primary = path.dirname(policy.upworkRuntime);
		}
		const agents = path.join(root, '.agents');
		for (const kind of ['rules', 'skills', 'agents']) {
			const manifest = JSON.parse(await readUnlinked(path.join(agents, kind + '.json')));
			const allowed = new Set([workspaceKey(path.resolve(primary, kind))]);
			if (!Array.isArray(manifest.entries) || !manifest.entries.some(entry => 'string' === typeof entry?.path &&
				allowed.has(workspaceKey(path.resolve(agents, entry.path))))) {
				throw Error('Shared manifests of legacy /upwork-init are not confirmed');
			}
		}
		const rule = await readUnlinked(path.join(agents, 'rules', '90-project.md'));
		const kb = await readUnlinked(path.join(root, 'KB', 'Project.md'));
		const ids = text => [...text.matchAll(/https?:\/\/(?:www\.)?upwork\.com\/jobs\/[^\s`"<>]*?(~[A-Za-z0-9]+)/g)].map(m => m[1]);
		const ruleIds = new Set(ids(rule));
		const current = /^#\s*2\.\s*[^\n]*\n([\s\S]*?)(?=^#\s|(?![\s\S]))/im.exec(kb);
		const job = current ? ids(current[1])[0] : null;
		if (1 !== ruleIds.size || !job || !ruleIds.has(job)) {
			throw Error('Legacy project rule and current KB job do not match');
		}
		if (!/^~\d+$/.test(job)) {
			throw Error('Unsupported historical ID preserved without cleanup');
		}
		r = {initialized: true, job_id: job, initialization_basis: 'legacy-manifests-rule-and-kb'};
	}
	return r;
}
export async function checkAge(root, marker, now = Date.now()) {
	let created;
	if (!marker.created_at) {
		created = (await fs.stat(root)).birthtimeMs;
	}
	else {
		if ('string' !== typeof marker.created_at || !/(?:Z|[+-]\d{2}:\d{2})$/.test(marker.created_at)) {
			throw Error('Unknown created_at time zone');
		}
		created = Date.parse(marker.created_at);
	}
	if (!Number.isFinite(created) || 0 >= created || 72 * 3600 * 1000 >= now - created) {
		throw Error('Project is not older than 72 hours yet');
	}
}
export function pruneProject(state, id) {
	const byId = new Map(state.folders.map(f => [f.id, f]));
	const affected = new Set();
	let folder = state.projectFolderMap[id];
	while (folder) {
		if (affected.has(folder) || !byId.has(folder)) {
			throw Error('Invalid Folders branch');
		}
		affected.add(folder);
		folder = byId.get(folder).parentId;
	}
	delete state.projectFolderMap[id];
	const r = [];
	while (true) {
		const empty = [...affected].filter(id => byId.has(id) && !Object.values(state.projectFolderMap).includes(id) && ![...byId.values()].some(f => f.parentId === id));
		if (!empty.length) {
			break;
		}
		for (const id of empty) {
			byId.delete(id);
			r.push(id);
		}
	}
	state.folders = state.folders.filter(f => byId.has(f.id));
	delete state.projects[id];
	state.projectOrder = state.projectOrder.filter(x => x !== id);
	state.conflicts = state.conflicts.filter(c => c.projectId !== id);
	state.operations = state.operations.filter(o => o.projectId !== id);
	for (const profile of Object.values(state.profiles)) {
		delete profile.bindings[id];
		profile.collapsedFolderIds = profile.collapsedFolderIds.filter(id => byId.has(id));
		for (const [alias, target] of Object.entries(profile.folderAliases ?? {})) {
			if (!byId.has(target)) {
				delete profile.folderAliases[alias];
			}
		}
	}
	return r;
}
export async function checkConversations(profiles, root, bindings) {
	const {DatabaseSync} = await import('node:sqlite');
	const key = workspaceKey(root);
	const r = {};
	for (const profile of profiles) {
		const databases = (await fs.readdir(profile.home)).filter(name => /^state_.*\.sqlite$/.test(name));
		if (!databases.length) {
			throw Error('Codex history is unavailable for ' + profile.id);
		}
		const found = new Set();
		for (const name of databases) {
			const file = path.join(profile.home, name);
			if ((await fs.lstat(file)).isSymbolicLink()) {
				throw Error('Symlinked Codex database preserved');
			}
			const db = new DatabaseSync(file, {readOnly: true});
			try {
				for (const row of db.prepare('SELECT id,project_id,cwd FROM threads').all()) {
					if ('string' !== typeof row.cwd || !row.cwd) {
						throw Error('Unknown cwd format in Codex history');
					}
					const cwd = workspaceKey(row.cwd);
					if (row.project_id === bindings[profile.id] || cwd === key || cwd.startsWith(key + '/') || cwd.startsWith(key + '\\')) {
						found.add(row.id);
					}
				}
			}
			finally {
				db.close();
			}
		}
		r[profile.id] = found.size;
	}
	if (Object.values(r).some(Boolean)) {
		throw hasConversations('Project has Codex conversations: ' + JSON.stringify(r));
	}
	return r;
}
export async function checkHistories(profiles, root, bindings, antigravity) {
	const counts = await checkConversations(profiles, root, bindings);
	if ('string' !== typeof antigravity?.database || !Array.isArray(antigravity.projectIds)) {
		throw Error('Antigravity history is not specified');
	}
	const {DatabaseSync} = await import('node:sqlite');
	const key = workspaceKey(root);
	const db = new DatabaseSync(antigravity.database, {readOnly: true});
	let count = 0;
	try {
		for (const row of db.prepare('SELECT project_id,workspace_uris FROM conversation_summaries').all()) {
			const uris = row.workspace_uris ? JSON.parse(row.workspace_uris) : [];
			if (!Array.isArray(uris)) {
				throw Error('Unknown Antigravity working directory format');
			}
			const belongs = uri => {
				if ('string' !== typeof uri || !uri) {
					throw Error('Unknown Antigravity working directory');
				}
				const cwd = workspaceKey(uri);
				return cwd === key || cwd.startsWith(key + '/') || cwd.startsWith(key + '\\');
			};
			if (antigravity.projectIds.includes(row.project_id) || uris.some(belongs)) {
				count++;
			}
		}
	}
	finally {
		db.close();
	}
	if (count) {
		throw hasConversations('Project has Antigravity conversations: ' + count);
	}
	return {...counts, antigravity: count};
}
export function validateRequest(state, profiles, spec) {
	if (!spec || 'string' !== typeof spec.sharedId || !Array.isArray(spec.rootPaths) || 1 !== spec.rootPaths.length) {
		throw Error('Invalid cleanup request');
	}
	const r = state.projects[spec.sharedId] ?? null;
	if (r) {
		if (identity(r) !== identity(spec)) {
			throw Error('Project roots changed before cleanup');
		}
		if (Object.keys(state.profiles).sort().join() !== profiles.map(p => p.id).sort().join()) {
			throw Error('Incomplete cleanup profile list');
		}
		if (state.conflicts.some(c => c.projectId === r.id) || state.operations.some(o => o.projectId === r.id)) {
			throw Error('Project has a conflict or pending operation');
		}
		for (const profile of profiles) {
			if (state.profiles[profile.id].bindings[r.id]?.desktopId !== spec.bindings?.[profile.id]) {
				throw Error('Project bindings changed before cleanup');
			}
		}
	}
	return r;
}
async function restoreCleanup(sync, spec) {
	const clients = sync.profiles.map(profile => sync.getClients().find(c => c.profile.id === profile.id && c.installed && c.sharedReady && !c.cdp.closed));
	const offline = clients.some(c => !c);
	const snapshots = await Promise.all(clients.map(c => c ? c.cdp.evaluate('window.__codexSharedDesktop.read()', 10000) : null));
	await sync.store.transact(state => {
		const project = validateRequest(state, sync.profiles, spec);
		if (project?.cleanupHold) {
			delete project.deleted;
			if (!offline) {
				delete project.cleanupHold;
			}
			let source = null;
			for (let i = 0; i < clients.length; i++) {
				if (clients[i]) {
					const profile = clients[i].profile.id;
					const binding = state.profiles[profile].bindings[project.id];
					if (snapshots[i][binding.desktopId]) {
						source ??= profile;
					}
					else {
						binding.lastSeen = null;
						binding.known = false;
						binding.missing = false;
					}
				}
			}
			if (source) {
				project.registrationSource = source;
			}
		}
	});
	return offline
		? {complete: false, status: 'preserved-partial', message: 'Open both Codex profiles to recover interrupted cleanup'}
		: {complete: true, status: 'preserved', restoration_requested: true};
}
export async function cleanupProject(sync, spec, {check = checkHistories} = {}) {
	if (sync.cleaning) {
		throw Error('Cleanup is already in progress');
	}
	sync.cleaning = true;
	let held = false;
	let prior = null;
	let r;
	try {
		await Promise.all([...sync.runners.values()].filter(runner => runner.running).map(runner => runner.promise));
		const {store, profiles} = sync;
		let project = validateRequest(store.state, profiles, spec);
		if (!project) {
			r = {complete: true, already_absent: true, removed_folders: []};
		}
		else {
			prior = {deleted: project.deleted, cleanupHold: project.cleanupHold};
			if (true === spec.preserve) {
				r = await restoreCleanup(sync, spec);
			}
			else {
				const clients = profiles.map(profile => sync.getClients().find(c => c.profile.id === profile.id && c.installed && c.sharedReady && !c.cdp.closed));
				const offline = profiles.filter((_, i) => !clients[i]).map(p => p.id);
				if (offline.length) {
					r = {
						complete: false,
						status: 'pending',
						offline_profiles: offline,
						message: 'Open the specified Codex profiles and retry /upwork-cleanup'
					};
				}
				else {
					const root = spec.rootPaths[0];
					const marker = await initializationState(root, {policyFile: sync.trustPolicy?.file});
					if (true !== marker.initialized || !/^~\d+$/.test(marker.job_id)) {
						throw Error('Project creation via /upwork-init is not confirmed');
					}
					await checkAge(root, marker);
					await check(profiles, root, spec.bindings, spec.antigravity);
					const expected = fields(project);
					const removed = [];
					for (const client of clients) {
						const snapshot = await client.cdp.evaluate('window.__codexSharedDesktop.read()', 10000);
						const native = snapshot[spec.bindings[client.profile.id]];
						if (native && identity(native) !== identity(project)) {
							throw Error('Native roots changed before cleanup');
						}
						if (native && JSON.stringify(fields(native)) !== JSON.stringify(expected)) {
							throw Error('Native project changed before cleanup');
						}
						for (const value of Object.values(snapshot)) {
							if (value.id !== spec.bindings[client.profile.id] && identity(value) === identity(project)) {
								throw Error('Ambiguous native registration');
							}
						}
						if (true === spec.commit && native) {
							throw Error('Native project is still present before cleanup commit');
						}
					}
					if (true !== spec.commit) {
						await store.transact(state => {
							project = validateRequest(state, profiles, spec);
							project.deleted = true;
							project.cleanupHold = true;
						});
					}
					held = true !== spec.commit;
					for (const client of true === spec.commit ? [] : clients) {
						await check(profiles, root, spec.bindings, spec.antigravity);
						const id = spec.bindings[client.profile.id];
						const reply = await client.cdp.evaluate('window.__codexSharedDesktop.remove(' + JSON.stringify(id) + ',' + JSON.stringify(expected) + ')', 10000);
						if (true !== reply?.removed) {
							throw Error('App did not confirm project deletion');
						}
						removed.push(client.profile.id);
					}
					await check(profiles, root, spec.bindings, spec.antigravity);
					for (const client of clients) {
						const snapshot = await client.cdp.evaluate('window.__codexSharedDesktop.read()', 10000);
						if (snapshot[spec.bindings[client.profile.id]]) {
							throw Error('Project is still present in Codex');
						}
					}
					if (true === spec.deferCommit) {
						r = {complete: true, awaiting_commit: true, metadata_removed: false, removed_profiles: removed, removed_folders: []};
					}
					else {
						const {result: folders} = await store.transact(state => {
							const current = validateRequest(state, profiles, spec);
							if (JSON.stringify(fields(current)) !== JSON.stringify(expected)) {
								throw Error('Shared project changed during cleanup');
							}
							return pruneProject(state, spec.sharedId);
						});
						r = {complete: true, removed_profiles: removed, metadata_removed: true, removed_folders: folders};
					}
				}
			}
		}
		return r;
	}
	catch (error) {
		if (held || prior?.cleanupHold) {
			await restoreCleanup(sync, spec);
		}
		throw error;
	}
	finally {
		sync.cleaning = false;
		await sync.notify();
		sync.wakeAll();
	}
}
