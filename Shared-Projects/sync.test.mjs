// 2026-10-17 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Add C1 post-update UI recovery, DWM freeze resilience, and idempotent external project registration with auto-trust policy":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/9
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {CatalogStore, migrateSeeds, stateDirectory, ensureProject, selectRegistrationSources} from './catalog.mjs';
import {TrustPolicy} from './trust.mjs';
import {ProjectSynchronizer} from './sync.mjs';
test('desktop initialization is retried promptly without declaring its project service unsupported', async () => {
	let ready = false;
	let calls = 0;
	const client = {
		profile: {id: 'C2'},
		cdp: {
			closed: false,
			evaluate: async () => {
				calls++;
				if (!ready) {
					throw Error('DESKTOP_STARTING: project service is initializing');
				}
				return {appVersion: 'new', url: 'app://-/assets/app-initial-new.js', exportName: 'projects'};
			}
		}
	};
	const synchronizer = new ProjectSynchronizer({store: {}, profiles: [client.profile], getClients: () => [client], notify: async () => {}, log: async () => {}});
	const started = Date.now();
	await synchronizer.attach(client);
	assert.equal(client.sharedReady, false);
	assert.equal(synchronizer.health.get('C2').state, 'initializing');
	assert.ok(2000 > client.sharedRetryAt - started);
	ready = true;
	client.sharedRetryAt = 0;
	await synchronizer.attach(client);
	assert.equal(client.sharedReady, true);
	assert.equal(calls, 2);
	assert.equal(synchronizer.health.get('C2').state, 'connected');
});
test('both closed profiles keep an idempotent durable producer request across helper restarts', async t => {
	const root = path.join(stateDirectory, 'tests');
	await fs.mkdir(root, {recursive: true});
	const dir = await fs.mkdtemp(path.join(root, 'offline-'));
	t.after(async () => {
		assert.ok(path.resolve(dir).startsWith(path.resolve(root) + path.sep));
		await fs.rm(dir, {recursive: true, force: true});
		await fs.rmdir(root).catch(() => {});
	});
	const workspace = path.join(dir, 'daily', 'one');
	await fs.mkdir(workspace, {recursive: true});
	const runtime = path.join(dir, 'runtime.json');
	const policyFile = path.join(dir, 'policy.json');
	const file = path.join(dir, 'catalog.json');
	await fs.writeFile(runtime, JSON.stringify({workspace_root: dir, daily_root: 'daily'}));
	await fs.writeFile(policyFile, JSON.stringify({upworkRuntime: runtime}));
	const profiles = ['C1', 'C2'].map(id => ({id, home: path.join(dir, id)}));
	await fs.writeFile(file, JSON.stringify(migrateSeeds(profiles.map(p => ({...p, projects: {}})))));
	const make = async () => {
		const store = new CatalogStore(file);
		await store.load([]);
		return new ProjectSynchronizer({store, profiles, getClients: () => [], notify: async () => {}, log: async () => {}, trustPolicy: new TrustPolicy(policyFile)});
	};
	const spec = {name: 'Offline', rootPaths: [workspace], folderPath: ['Upwork'], trustPolicy: 'upwork-daily'};
	const first = await make();
	const receipt = await first.ensureProject('C2', spec);
	await first.stop();
	assert.equal(receipt.complete, false);
	assert.equal(receipt.status, 'pending');
	assert.equal(first.status().C1.state, 'offline');
	const after = await make();
	const again = await after.ensureProject('C2', spec);
	await after.stop();
	assert.equal(again.shared_id, receipt.shared_id);
	assert.deepEqual(again.profiles, receipt.profiles);
	assert.equal(Object.keys(after.store.state.projects).length, 1);
	assert.equal(after.store.state.operations.length, 0);
	assert.equal(after.status().C2.pending, 1);
});
test('synchronizer never publishes an unstarted source plan before accepting it', async () => {
	const state = migrateSeeds(['C1', 'C2'].map(id => ({id, projects: {}})));
	const {shared_id: id} = ensureProject(state, 'C2', {name: 'Atomic source', rootPaths: ['C:\\daily\\one'], folderPath: ['Upwork'], trustPolicy: 'upwork-daily'});
	let retargeted = false;
	const dispatches = [];
	const store = {
		state,
		async transact(action) {
			const next = structuredClone(this.state);
			const result = await action(next);
			this.state = next;
			if (this.state.operations.some(op => 'C2' === op.profile && !op.startedAt)) {
				selectRegistrationSources(this.state, ['C1']);
				retargeted = true;
			}
			return {state: structuredClone(this.state), result: structuredClone(result)};
		}
	};
	const sandbox = {
		window: {
			__codexSharedDesktop: {
				drainEvents: () => [],
				read: () => ({}),
				retainOperations: () => {},
				startOperation: op => {
					dispatches.push({profile: op.profile, source: store.state.projects[id].registrationSource, started: !!op.startedAt});
					return {state: 'pending'};
				}
			}
		}
	};
	const profiles = ['C1', 'C2'].map(id => ({id, home: 'C:\\profiles\\' + id}));
	const client = {
		profile: profiles[1],
		installed: true,
		sharedReady: true,
		sharedInfo: {appVersion: 'isolated'},
		cdp: {closed: false, evaluate: async expression => vm.runInNewContext(expression, sandbox)}
	};
	const synchronizer = new ProjectSynchronizer({store, profiles, getClients: () => [client], notify: async () => {}, log: async () => {}, trustPolicy: {operation: async () => null}});
	await synchronizer.run('C2');
	await synchronizer.stop();
	assert.equal(retargeted, false, 'No externally visible unstarted plan may cross the transaction boundary');
	assert.deepEqual(dispatches, [{profile: 'C2', source: 'C2', started: true}]);
});
test('ensureProject awaits connected profile sync and report closes timed-out CDP clients', async () => {
	const state = migrateSeeds(['C1', 'C2'].map(id => ({id, projects: {}})));
	const store = {
		state,
		async transact(action) {
			const next = structuredClone(this.state);
			const result = await action(next);
			this.state = next;
			return {state: structuredClone(this.state), result: structuredClone(result)};
		}
	};
	const native = {};
	let closed = 0;
	const sandbox = {
		window: {
			__codexSharedDesktop: {
				drainEvents: () => [],
				read: () => structuredClone(native),
				retainOperations: () => {},
				forgetOperation: () => {},
				startOperation: op => {
					native[op.desktopId] = {id: op.desktopId, ...op.value};
					return {state: 'done', result: native[op.desktopId]};
				}
			}
		}
	};
	const profiles = ['C1', 'C2'].map(id => ({id, home: 'C:\\profiles\\' + id}));
	const client = {
		profile: profiles[1],
		installed: true,
		sharedReady: true,
		sharedInfo: {appVersion: 'isolated'},
		cdp: {
			closed: false,
			close() {
				closed++;
				this.closed = true;
			},
			evaluate: async expression => vm.runInNewContext(expression, sandbox)
		}
	};
	const synchronizer = new ProjectSynchronizer({
		store,
		profiles,
		getClients: () => [client],
		notify: async () => {},
		log: async () => {},
		trustPolicy: {prepare: async s => s, operation: async () => null}
	});
	const receipt = await synchronizer.ensureProject('C2', {name: 'Synced immediately', rootPaths: ['C:\\daily\\two'], folderPath: ['Upwork'], trustPolicy: 'upwork-daily'});
	assert.equal(receipt.complete, true);
	assert.equal(receipt.status, 'registered');
	assert.equal(receipt.accounts.C2.state, 'connected');
	await synchronizer.report('C2', Error('Runtime.evaluate timed out'));
	await synchronizer.stop();
	assert.equal(closed, 1);
	assert.equal(client.cdp.closed, true);
});
