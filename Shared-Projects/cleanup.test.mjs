// 2026-10-17 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Add C1 post-update UI recovery, DWM freeze resilience, and idempotent external project registration with auto-trust policy":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/9
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {migrateSeeds, validateCatalog, planOperation, fields, observeProjects, projectState} from './catalog.mjs';
import {cleanupProject, pruneProject, checkConversations, checkHistories, checkAge, initializationState} from './cleanup.mjs';
async function fixture(t) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upwork-cleanup-'));
	t.after(async () => {
		assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
		assert.ok(path.basename(dir).startsWith('upwork-cleanup-'));
		await fs.rm(dir, {recursive: true, force: true});
	});
	const root = path.join(dir, 'daily', 'one');
	await fs.mkdir(path.join(root, 'ꘖ'), {recursive: true});
	await fs.writeFile(path.join(root, 'ꘖ', 'project.json'), JSON.stringify({initialized: true, job_id: '~123456', created_at: new Date(Date.now() - 73 * 3600 * 1000).toISOString()}));
	const profiles = ['C1', 'C2'].map(id => ({id, home: path.join(dir, id)}));
	const native = Object.fromEntries(profiles.map(p => [p.id, {[p.id + '-native']: {id: p.id + '-native', name: 'Unused', rootPaths: [root]}}]));
	const state = migrateSeeds(profiles.map(p => ({
		...p,
		projects: native[p.id],
		folders: {
			schemaVersion: 1,
			revision: 0,
			folders: [{id: 'upwork', name: 'Upwork', parentId: null}, {id: 'day', name: '15', parentId: 'upwork'}, {id: 'unrelated', name: 'Keep', parentId: null}],
			projectFolderMap: {[p.id + '-native']: 'day'},
			collapsedFolderIds: ['day', 'unrelated']
		}
	})));
	const sharedId = Object.keys(state.projects)[0];
	const spec = {sharedId, rootPaths: [root], bindings: {C1: 'C1-native', C2: 'C2-native'}};
	const store = {
		state,
		async transact(action) {
			const next = structuredClone(this.state);
			const result = await action(next);
			validateCatalog(next);
			this.state = next;
			return {result, state: structuredClone(next)};
		}
	};
	const removed = [];
	let fail = null;
	const clients = profiles.map(profile => {
		const sandbox = {
			window: {
				__codexSharedDesktop: {
					read: () => structuredClone(native[profile.id]),
					remove: (id, expected) => {
						if (fail === profile.id) {
							throw Error('Native removal interrupted');
						}
						assert.equal(JSON.stringify(fields(native[profile.id][id] ?? expected)), JSON.stringify(expected));
						delete native[profile.id][id];
						removed.push(profile.id);
						return {removed: true};
					}
				}
			}
		};
		return {profile, installed: true, sharedReady: true, cdp: {closed: false, evaluate: async expression => vm.runInNewContext(expression, sandbox)}};
	});
	const sync = {store, profiles, runners: new Map(), getClients: () => clients, notify: async () => {}, wakeAll() {}};
	return {
		dir,
		root,
		profiles,
		native,
		spec,
		store,
		clients,
		sync,
		removed,
		setFail: value => {
			fail = value;
		}
	};
}
test('native removal in both profiles purges metadata and newly empty ancestors only', async t => {
	const f = await fixture(t);
	const before = await fs.readFile(path.join(f.root, 'ꘖ', 'project.json'));
	const result = await cleanupProject(f.sync, f.spec, {check: async () => ({C1: 0, C2: 0})});
	assert.equal(result.complete, true);
	assert.deepEqual(f.removed, ['C1', 'C2']);
	assert.deepEqual(Object.keys(f.store.state.projects), []);
	assert.deepEqual(f.store.state.projectOrder, []);
	assert.deepEqual(f.store.state.projectFolderMap, {});
	assert.deepEqual(new Set(result.removed_folders), new Set(['day', 'upwork']));
	assert.deepEqual(f.store.state.folders.map(x => x.id), ['unrelated']);
	for (const profile of Object.values(f.store.state.profiles)) {
		assert.deepEqual(profile.bindings, {});
		assert.deepEqual(profile.collapsedFolderIds, ['unrelated']);
	}
	assert.deepEqual(await fs.readFile(path.join(f.root, 'ꘖ', 'project.json')), before);
	const again = await cleanupProject(f.sync, f.spec, {
		check: async () => {
			throw Error('Should not run');
		}
	});
	assert.equal(again.already_absent, true);
});
test('offline profile is pending without catalogue mutation or delayed native deletion', async t => {
	const f = await fixture(t);
	const before = structuredClone(f.store.state);
	f.clients[0].cdp.closed = true;
	const result = await cleanupProject(f.sync, f.spec, {
		check: async () => {
			throw Error('Should not run');
		}
	});
	assert.equal(result.complete, false);
	assert.deepEqual(result.offline_profiles, ['C1']);
	assert.deepEqual(f.store.state, before);
	assert.deepEqual(f.removed, []);
});
test('conversation discovered during recheck stops removal', async t => {
	const f = await fixture(t);
	let calls = 0;
	await assert.rejects(cleanupProject(f.sync, f.spec, {
		check: async () => {
			if (2 === ++calls) {
				throw Error('Conversation exists');
			}
		}
	}), /Conversation exists/);
	assert.deepEqual(f.removed, []);
	assert.equal(f.store.state.projects[f.spec.sharedId].cleanupHold, undefined);
	assert.equal(f.store.state.projects[f.spec.sharedId].deleted, undefined);
	assert.equal(planOperation(f.store.state, 'C1', f.native.C1), null);
});
test('partial native failure is held across restart and safely completed by the same IDs', async t => {
	const f = await fixture(t);
	f.setFail('C2');
	const evaluate = f.clients[1].cdp.evaluate;
	f.clients[1].cdp.evaluate = async expression => {
		if (expression.includes('.remove(')) {
			f.clients[1].cdp.closed = true;
		}
		return evaluate(expression);
	};
	await assert.rejects(cleanupProject(f.sync, f.spec, {check: async () => {}}), /interrupted/);
	assert.deepEqual(f.removed, ['C1']);
	assert.equal(f.store.state.projects[f.spec.sharedId].cleanupHold, true);
	assert.equal(planOperation(f.store.state, 'C1', f.native.C1), null);
	f.setFail(null);
	f.clients[1].cdp.closed = false;
	f.clients[1].cdp.evaluate = evaluate;
	const result = await cleanupProject(f.sync, f.spec, {check: async () => {}});
	assert.equal(result.complete, true);
	assert.deepEqual(f.store.state.projects, {});
});
test('offline partial preservation survives a collector and completes after reopening', async t => {
	const f = await fixture(t);
	const id = f.spec.sharedId;
	delete f.native.C1['C1-native'];
	f.store.state.projects[id].deleted = true;
	f.store.state.projects[id].cleanupHold = true;
	f.clients[1].cdp.closed = true;
	const partial = await cleanupProject(f.sync, {...f.spec, preserve: true});
	assert.equal(partial.complete, false);
	observeProjects(f.store.state, 'C1', {});
	assert.deepEqual(f.store.state.conflicts, []);
	f.clients[1].cdp.closed = false;
	const complete = await cleanupProject(f.sync, {...f.spec, preserve: true});
	assert.equal(complete.complete, true);
	assert.equal(f.store.state.projects[id].cleanupHold, undefined);
	assert.equal(planOperation(f.store.state, 'C1', {}).type, 'upsert');
});
test('native PROJECT_CHANGED with no deletion restores visible catalogue state', async t => {
	const f = await fixture(t);
	const evaluate = f.clients[0].cdp.evaluate;
	f.clients[0].cdp.evaluate = async expression => {
		if (expression.includes('.remove(')) {
			f.native.C1['C1-native'].name = 'Manual rename';
			throw Error('PROJECT_CHANGED');
		}
		return evaluate(expression);
	};
	await assert.rejects(cleanupProject(f.sync, f.spec, {check: async () => {}}), /PROJECT_CHANGED/);
	const project = f.store.state.projects[f.spec.sharedId];
	assert.equal(project.deleted, undefined);
	assert.equal(project.cleanupHold, undefined);
	assert.deepEqual(f.removed, []);
	assert.ok(0 < Object.keys(projectState(f.store.state, 'C1').projectFolderMap).length);
});
test('two-phase cleanup retains reversible metadata until the producer commits both systems', async t => {
	const f = await fixture(t);
	const first = await cleanupProject(f.sync, {...f.spec, deferCommit: true}, {check: async () => {}});
	assert.equal(first.awaiting_commit, true);
	assert.equal(first.metadata_removed, false);
	assert.equal(f.store.state.projects[f.spec.sharedId].cleanupHold, true);
	const second = await cleanupProject(f.sync, {...f.spec, commit: true}, {check: async () => {}});
	assert.equal(second.metadata_removed, true);
	assert.deepEqual(f.store.state.projects, {});
});
test('changed bindings or roots preserve every native registration', async t => {
	const f = await fixture(t);
	const before = structuredClone(f.store.state);
	await assert.rejects(cleanupProject(f.sync, {...f.spec, bindings: {C1: 'wrong', C2: 'C2-native'}}, {check: async () => {}}), /Project bindings/);
	await assert.rejects(cleanupProject(f.sync, {...f.spec, rootPaths: [f.dir]}, {check: async () => {}}), /Project roots/);
	assert.deepEqual(f.store.state, before);
	assert.deepEqual(f.removed, []);
});
test('shared sibling project and folder survive pruning', async t => {
	const f = await fixture(t);
	const state = f.store.state;
	state.projects.keep = {id: 'keep', name: 'Kept', rootPaths: [f.dir]};
	state.projectOrder.push('keep');
	state.projectFolderMap.keep = 'day';
	for (const profile of Object.values(state.profiles)) {
		profile.bindings.keep = {desktopId: 'kept', known: true, lastSeen: fields(state.projects.keep)};
	}
	assert.deepEqual(pruneProject(state, f.spec.sharedId), []);
	assert.deepEqual(Object.keys(state.projects), ['keep']);
	assert.ok(state.folders.some(x => 'day' === x.id));
	validateCatalog(state);
});
test('real readonly SQLite guard includes archived chats, native IDs and descendant workspaces', async t => {
	const f = await fixture(t);
	const {DatabaseSync} = await import('node:sqlite');
	for (const profile of f.profiles) {
		await fs.mkdir(profile.home);
		const db = new DatabaseSync(path.join(profile.home, 'state_5.sqlite'));
		db.exec('CREATE TABLE threads (id TEXT,project_id TEXT,cwd TEXT,archived INTEGER)');
		db.close();
	}
	assert.deepEqual(await checkConversations(f.profiles, f.root, f.spec.bindings), {C1: 0, C2: 0});
	const file = path.join(f.profiles[0].home, 'state_5.sqlite');
	const db = new DatabaseSync(file);
	db.prepare('INSERT INTO threads VALUES (?,?,?,?)').run('archived', 'C1-native', f.dir, 1);
	db.close();
	await assert.rejects(checkConversations(f.profiles, f.root, f.spec.bindings), /has Codex conversations/);
	const next = new DatabaseSync(file);
	next.exec('DELETE FROM threads');
	next.prepare('INSERT INTO threads VALUES (?,?,?,?)').run('child', 'other', path.join(f.root, 'result'), 0);
	next.close();
	await assert.rejects(checkConversations(f.profiles, f.root, f.spec.bindings), /has Codex conversations/);
	const extended = new DatabaseSync(file);
	extended.exec('DELETE FROM threads');
	extended.prepare('INSERT INTO threads VALUES (?,?,?,?)').run('extended', null, '\\\\?\\' + f.root, 0);
	extended.close();
	await assert.rejects(checkConversations(f.profiles, f.root, f.spec.bindings), /has Codex conversations/);
});
test('Antigravity history is checked inside native Codex cleanup', async t => {
	const f = await fixture(t);
	const {DatabaseSync} = await import('node:sqlite');
	for (const profile of f.profiles) {
		await fs.mkdir(profile.home);
		const db = new DatabaseSync(path.join(profile.home, 'state_5.sqlite'));
		db.exec('CREATE TABLE threads (id TEXT,project_id TEXT,cwd TEXT)');
		db.close();
	}
	const file = path.join(f.dir, 'ag.db');
	const db = new DatabaseSync(file);
	db.exec('CREATE TABLE conversation_summaries (project_id TEXT,workspace_uris TEXT)');
	db.prepare('INSERT INTO conversation_summaries VALUES (?,?)').run('ag-native', '[]');
	db.close();
	f.spec.antigravity = {database: file, projectIds: ['ag-native']};
	await assert.rejects(cleanupProject(f.sync, f.spec), /Antigravity conversations/);
	assert.deepEqual(f.removed, []);
	assert.equal(f.store.state.projects[f.spec.sharedId].deleted, undefined);
});
test('new conversation after partial deletion restores visibility and missing binding without duplicating IDs', async t => {
	const f = await fixture(t);
	let count = 0;
	const check = async () => {
		if (3 === ++count) {
			const error = Error('Conversation arrived');
			error.code = 'PROJECT_HAS_CONVERSATIONS';
			throw error;
		}
	};
	await assert.rejects(cleanupProject(f.sync, f.spec, {check}), /Conversation arrived/);
	const project = f.store.state.projects[f.spec.sharedId];
	assert.equal(project.deleted, undefined);
	assert.equal(project.cleanupHold, undefined);
	assert.equal(project.registrationSource, 'C2');
	assert.equal(f.store.state.profiles.C1.bindings[f.spec.sharedId].known, false);
	const operation = planOperation(f.store.state, 'C1', f.native.C1);
	assert.equal(operation.type, 'upsert');
	assert.equal(operation.desktopId, 'C1-native');
	assert.deepEqual(Object.keys(f.store.state.projects), [f.spec.sharedId]);
});
test('helper itself enforces strictly more than 72 hours and preserves recent legacy copies', async t => {
	const f = await fixture(t);
	const now = Date.now();
	await assert.rejects(checkAge(f.root, {created_at: new Date(now - 72 * 3600 * 1000).toISOString()}, now), /72 hours/);
	await checkAge(f.root, {created_at: new Date(now - 72 * 3600 * 1000 - 1).toISOString()}, now);
	await assert.rejects(checkAge(f.root, {request_date: '2020-01-01'}, now), /72 hours/);
	await fs.writeFile(path.join(f.root, 'ꘖ', 'project.json'), JSON.stringify({initialized: true, job_id: '~123456', created_at: new Date(now).toISOString()}));
	await assert.rejects(cleanupProject(f.sync, f.spec, {check: async () => {}}), /72 hours/);
	assert.deepEqual(f.removed, []);
});
async function legacyFixture(t) {
	const f = await fixture(t);
	const primary = path.join(f.dir, 'shared', '.agents');
	await fs.unlink(path.join(f.root, 'ꘖ', 'project.json'));
	const agents = path.join(f.root, '.agents');
	await fs.mkdir(path.join(agents, 'rules'), {recursive: true});
	await fs.mkdir(path.join(f.root, 'KB'));
	for (const kind of ['rules', 'skills', 'agents']) {
		await fs.writeFile(path.join(agents, kind + '.json'), JSON.stringify({entries: [{path: path.join(primary, kind)}]}));
	}
	await fs.writeFile(path.join(agents, 'rules', '90-project.md'), 'Target job: `https://upwork.com/jobs/~123456`.\n');
	await fs.writeFile(path.join(f.root, 'KB', 'Project.md'), '# 1. Client\nClient\n# 2. Current Client Project\nhttps://upwork.com/jobs/~123456\n');
	const policy = path.join(f.dir, 'trust-policy.json');
	await fs.writeFile(policy, JSON.stringify({upworkRuntime: path.join(primary, 'runtime.json')}));
	f.sync.trustPolicy = {file: policy};
	return {...f, primary};
}
test('legacy initialization is verified without creating a marker and still passes native cleanup guards', async t => {
	const f = await legacyFixture(t);
	const state = await initializationState(f.root, {primary: f.primary});
	assert.equal(state.initialized, true);
	assert.equal(state.job_id, '~123456');
	t.mock.method(Date, 'now', () => new Date().getTime() + 4 * 24 * 3600 * 1000);
	const result = await cleanupProject(f.sync, f.spec, {check: async () => {}});
	assert.equal(result.complete, true);
	assert.deepEqual(f.removed, ['C1', 'C2']);
	await assert.rejects(fs.stat(path.join(f.root, 'ꘖ', 'project.json')), {code: 'ENOENT'});
});
test('legacy ownership mismatch or changed current-job evidence cannot dispatch deletion', async t => {
	const f = await legacyFixture(t);
	const before = structuredClone(f.store.state);
	await fs.writeFile(path.join(f.root, 'KB', 'Project.md'), '# 2. Current Client Project\nhttps://upwork.com/jobs/~999999\n');
	await assert.rejects(cleanupProject(f.sync, f.spec, {check: async () => {}}), /do not match/);
	assert.deepEqual(f.removed, []);
	assert.deepEqual(f.store.state, before);
	await fs.writeFile(path.join(f.root, '.agents', 'skills.json'), JSON.stringify({entries: [{path: path.join(f.dir, 'foreign')}]}));
	await assert.rejects(initializationState(f.root, {primary: f.primary}), /manifests/);
});
test('different historical hexadecimal IDs never collapse into a matching numeric prefix', async t => {
	const f = await legacyFixture(t);
	const first = '~01d46772b31197f41a';
	const second = '~01d9f93da4952d012b';
	await fs.writeFile(path.join(f.root, '.agents', 'rules', '90-project.md'), 'Target job: https://upwork.com/jobs/' + first + '\n');
	for (const current of [second, first]) {
		await fs.writeFile(path.join(f.root, 'KB', 'Project.md'), '# 2. Current Client Project\nhttps://upwork.com/jobs/' + current + '\n');
		await assert.rejects(cleanupProject(f.sync, f.spec, {check: async () => {}}));
		assert.deepEqual(f.removed, []);
		assert.equal(f.store.state.projects[f.spec.sharedId].deleted, undefined);
	}
});
