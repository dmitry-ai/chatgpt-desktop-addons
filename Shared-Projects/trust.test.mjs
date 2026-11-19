// 2026-11-19 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Support path registry template expansion in Shared-Projects TrustPolicy":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/18
// 2026-10-17 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Add C1 post-update UI recovery, DWM freeze resilience, and idempotent external project registration with auto-trust policy":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/9
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {TrustPolicy, ensureTrustedRoots, expandPathTemplate} from './trust.mjs';
import {stateDirectory} from './catalog.mjs';
import {findMessageBusImport, configRequest} from './desktop.mjs';
const root = 'C:\\work\\upwork\\code\\proposals\\daily\\2026\\10\\16\\1 - a.b';
const configFile = 'C:\\Users\\test\\.codex\\config.toml';
const policy = {policy: 'upwork-daily', roots: [root], configFile};
function connection({projects = {}, userProjects = {}, status = 'ok', apply = true, file = configFile} = {}) {
	const calls = [];
	const config = {projects: structuredClone(projects)};
	const request = async (method, params) => {
		calls.push({method, params: structuredClone(params)});
		let r;
		if ('config/read' === method) {
			r = structuredClone({config, layers: [{name: {type: 'user', file}, version: 'revision-one', config: {projects: userProjects}}]});
		}
		else {
			assert.equal(method, 'config/batchWrite');
			if (apply) {
				config.projects[root] = {trust_level: 'trusted'};
			}
			r = {status};
		}
		return r;
	};
	return {request, calls, config};
}
test('exact trust uses atomic versioned config API and verifies effective result', async () => {
	const c = connection({projects: {'C:\\work\\upwork\\code': {trust_level: 'trusted'}}});
	const result = await ensureTrustedRoots(c.request, policy);
	assert.equal(result.status, 'verified');
	assert.equal(result.written, true);
	assert.deepEqual(c.calls.map(x => x.method), ['config/read', 'config/batchWrite', 'config/read']);
	assert.deepEqual(c.calls[1].params, {
		edits: [{keyPath: 'projects.' + JSON.stringify(root) + '.trust_level', value: 'trusted', mergeStrategy: 'replace'}],
		filePath: configFile,
		expectedVersion: 'revision-one',
		reloadUserConfig: true
	});
});
test('an already trusted exact key is read without rewriting config', async () => {
	const c = connection({projects: {[root]: {trust_level: 'trusted'}}});
	const result = await ensureTrustedRoots(c.request, policy);
	assert.equal(result.written, false);
	assert.equal(c.calls.length, 2);
});
test('effective or overridden explicit untrusted aliases stop before writes', async () => {
	for (const input of [
		{projects: {[root.toLowerCase()]: {trust_level: 'untrusted'}}},
		{projects: {[root]: {trust_level: 'trusted'}}, userProjects: {[root.toLowerCase()]: {trust_level: 'untrusted'}}}
	]) {
		const c = connection(input);
		await assert.rejects(ensureTrustedRoots(c.request, policy), /^Error: UNTRUSTED_PROJECT:/);
		assert.deepEqual(c.calls.map(x => x.method), ['config/read']);
	}
});
test('overridden and unverifiable writes do not grant registration', async () => {
	for (const [input, pattern] of [
		[{status: 'overridden'}, /TRUST_OVERRIDDEN/],
		[{apply: false}, /TRUST_UNVERIFIED/],
		[{file: 'C:\\other\\config.toml'}, /TRUST_PROFILE_MISMATCH/]
	]) {
		const c = connection(input);
		await assert.rejects(ensureTrustedRoots(c.request, policy), pattern);
	}
});
test('a lost config acknowledgement is safely recovered by the next exact read', async () => {
	const c = connection();
	let fail = true;
	const request = async (method, params) => {
		const r = await c.request(method, params);
		if ('config/batchWrite' === method && fail) {
			fail = false;
			throw Error('transport disconnected after write');
		}
		return r;
	};
	await assert.rejects(ensureTrustedRoots(request, policy), /disconnected/);
	assert.equal((await ensureTrustedRoots(request, policy)).written, false);
	assert.equal(c.calls.filter(x => 'config/batchWrite' === x.method).length, 1);
});
test('native message discovery follows renamed imports and rejects ambiguity', () => {
	const source = 'import{busExport as bus}from`./shared.js`;bus.subscribe(`shared-object-updated`,x=>x);bus.dispatchMessage(x,y)';
	assert.deepEqual(findMessageBusImport(source), {name: 'busExport', url: './shared.js'});
	const splitSource = 'import{SIt as Ti}from"./app-shared.js";Ti.subscribe(`mcp-notification`,x=>x);Ti.dispatchMessage(x,y)';
	assert.deepEqual(findMessageBusImport(splitSource), {name: 'SIt', url: './app-shared.js'});
	assert.throws(() => findMessageBusImport(source + ';other.subscribe(`shared-object-updated`,x=>x)'), /ambiguous/);
});
test('config requests correlate the exact local response and remove their subscription', async () => {
	let handler;
	let removed = 0;
	const bus = {
		subscribe(type, fn) {
			assert.equal(type, 'mcp-response');
			handler = fn;
			return () => removed++;
		},
		dispatchMessage(type, message) {
			assert.equal(type, 'mcp-request');
			handler({hostId: 'C2', message: {id: message.request.id, result: {wrong: true}}});
			handler({hostId: 'local', message: {id: 'other', result: {wrong: true}}});
			handler({hostId: 'local', message: {id: message.request.id, result: {config: {projects: {}}}}});
		}
	};
	assert.deepEqual(await configRequest(bus, 'config/read', {}), {config: {projects: {}}});
	assert.equal(removed, 1);
	assert.throws(() => configRequest(bus, 'turn/start', {}), /Unsupported/);
});
test('policy scope comes from runtime and rejects traversal, non-directories and links escaping daily', async t => {
	const testRoot = path.join(stateDirectory, 'tests');
	await fs.mkdir(testRoot, {recursive: true});
	const dir = await fs.mkdtemp(path.join(testRoot, 'trust-'));
	t.after(async () => {
		assert.ok(path.resolve(dir).startsWith(path.resolve(testRoot) + path.sep));
		await fs.rm(dir, {recursive: true, force: true});
		await fs.rmdir(testRoot).catch(() => {});
	});
	const daily = path.join(dir, 'daily');
	const inside = path.join(daily, '2026', '10', '16', 'one');
	const outside = path.join(dir, 'outside');
	await fs.mkdir(inside, {recursive: true});
	await fs.mkdir(outside);
	await fs.writeFile(path.join(daily, 'file'), 'x');
	const runtime = path.join(dir, 'runtime.json');
	const policyFile = path.join(dir, 'policy.json');
	await fs.writeFile(runtime, JSON.stringify({workspace_root: dir, daily_root: 'daily'}));
	await fs.writeFile(policyFile, JSON.stringify({upworkRuntime: runtime}));
	const service = new TrustPolicy(policyFile);
	const spec = {trustPolicy: 'upwork-daily', rootPaths: [inside]};
	assert.deepEqual(await service.prepare(spec), spec);
	for (const root of [daily, outside, path.join(daily, '..', 'outside'), path.join(daily, 'file')]) {
		await assert.rejects(service.prepare({...spec, rootPaths: [root]}), /TRUST_POLICY/);
	}
	const link = path.join(daily, 'escape');
	await fs.symlink(outside, link, 'win32' === process.platform ? 'junction' : 'dir');
	await assert.rejects(service.prepare({...spec, rootPaths: [link]}), /TRUST_POLICY/);
	await assert.rejects(service.prepare({...spec, trustPolicy: 'arbitrary'}), /TRUST_POLICY/);
	assert.deepEqual(await service.prepare({rootPaths: [outside]}), {rootPaths: [outside]});
	const pathsFile = path.join(dir, 'paths.json');
	await fs.writeFile(pathsFile, JSON.stringify({version: 1, variables: {BASE_DIR: dir.replaceAll('\\', '/'), UPWORK_ROOT: '${BASE_DIR}', UPWORK_DAILY_REL: 'daily'}}));
	await fs.writeFile(runtime, JSON.stringify({paths_registry: 'paths.json', workspace_root: '${UPWORK_ROOT}', daily_root: '${UPWORK_DAILY_REL}'}));
	assert.deepEqual(await service.prepare(spec), spec);
});
test('expandPathTemplate preserves UNC prefixes, escapes, Apache prefix concatenation, and literal $ in env values', () => {
	const vars = {
		WORK_ROOT: 'C:/work',
		DF_CLIENTS: '${WORK_ROOT}/clients/',
		UNC_BASE: '//fileserver/share/',
		LIT_A: '$${LITERAL}',
		LIT_B: '${LIT_A}/sub'
	};
	const env = {WEIRD_ENV: 'C:\\Users\\a${INJECT}%PCT%'};
	assert.equal(expandPathTemplate('${DF_CLIENTS}smokeday.com/m/2026-10-26/code', vars, {env}), 'C:/work/clients/smokeday.com/m/2026-10-26/code');
	assert.equal(expandPathTemplate('${UNC_BASE}upwork//daily/', vars, {env}), '//fileserver/share/upwork/daily');
	assert.equal(expandPathTemplate('%WEIRD_ENV%/tail', vars, {env}), 'C:/Users/a${INJECT}%PCT%/tail');
	assert.equal(expandPathTemplate('${ENV:WEIRD_ENV}/tail', vars, {env}), 'C:/Users/a${INJECT}%PCT%/tail');
	assert.equal(expandPathTemplate('${LIT_B}/100%%', vars, {env}), '${LITERAL}/sub/100%');
	assert.ok(expandPathTemplate('%LOCALAPPDATA%/Codex', {}, {env: {}}).endsWith('/AppData/Local/Codex'));
	assert.throws(() => expandPathTemplate('${A}', {A: '${B}', B: '${A}'}, {env}), /TRUST_POLICY/);
	assert.throws(() => expandPathTemplate('C:/work/${UNCLOSED', vars, {env}), /TRUST_POLICY/);
});
