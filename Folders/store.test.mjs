// 2026-10-15 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Implement sidebar project folder hierarchy (Folders), context menus, compact panel styling (CSS), and background CDP injection daemon (UI)":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/6
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {emptyState, applyOperation, FolderStore, validate} from './store.mjs';
async function cleanup(dir) {
	const resolved = path.resolve(dir);
	assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
	assert(path.basename(resolved).startsWith('codex-'));
	await fs.rm(resolved, {recursive: true, force: true});
}
function sample() {
	let r = emptyState();
	for (const [id, name, parentId] of [['a', 'Upwork', null], ['b', 'Proposals', 'a'], ['c', '2026', 'b']]) {
		r = applyOperation(r, {type: 'create', id, name, parentId});
	}
	return r;
}
test('tree rejects cycles and missing parents without changing the previous value', () => {
	const s = sample();
	const before = JSON.stringify(s);
	assert.throws(() => applyOperation(s, {type: 'move', id: 'a', parentId: 'c'}), /Cannot move/);
	assert.throws(() => applyOperation(s, {type: 'move', id: 'b', parentId: 'missing'}), /not found/);
	assert.equal(JSON.stringify(s), before);
});
test('duplicate names are rejected only among siblings', () => {
	const s = sample();
	assert.throws(() => applyOperation(s, {type: 'create', id: 'x', name: 'UPWORK', parentId: null}), /already exists/);
	const next = applyOperation(s, {type: 'create', id: 'x', name: 'Upwork', parentId: 'b'});
	assert.equal(next.folders.length, 4);
});
test('folder deletion lifts children and projects without changing project IDs', () => {
	let s = sample();
	s = applyOperation(s, {type: 'assign', projectKey: 'local:project:stable-id', folderId: 'b'});
	s = applyOperation(s, {type: 'collapse', id: 'b', collapsed: true});
	s = applyOperation(s, {type: 'remove', id: 'b'});
	assert.equal(s.folders.find(f => 'c' === f.id).parentId, 'a');
	assert.equal(s.projectFolderMap['local:project:stable-id'], 'a');
	assert.deepEqual(s.collapsedFolderIds, []);
	s = applyOperation(s, {type: 'remove', id: 'a'});
	assert.equal(s.projectFolderMap['local:project:stable-id'], undefined);
	assert.equal(s.folders.find(f => 'c' === f.id).parentId, null);
});
test('rename plus move is atomic when the final tree would conflict', () => {
	let s = sample();
	s = applyOperation(s, {type: 'create', id: 'd', name: '2026', parentId: null});
	assert.throws(() => applyOperation(s, {type: 'edit', id: 'b', name: '2026', parentId: null}), /already exists/);
	assert.equal(s.folders.find(f => 'b' === f.id).name, 'Proposals');
});
test('parallel window operations are serialized and survive restart', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-folders-test-'));
	try {
		const file = path.join(dir, 'ui-folders.json');
		const store = new FolderStore(file);
		await store.load();
		const operations = [];
		for (let i = 0; 20 > i; i++) {
			operations.push(store.operate({type: 'create', id: 'f' + i, name: 'Folder ' + i, parentId: null}));
			if (0 === i % 3) {
				operations.push(store.reload());
			}
		}
		await Promise.all(operations);
		const reopened = new FolderStore(file);
		const state = await reopened.load();
		assert.equal(state.folders.length, 20);
		assert.equal(state.revision, 20);
		assert.equal(validate(JSON.parse(await fs.readFile(file + '.bak', 'utf8'))).revision, 19);
		await assert.rejects(store.operate({type: 'move', id: 'f0', parentId: 'f0'}));
		assert.equal((await reopened.load()).revision, 20);
	}
	finally {
		await cleanup(dir);
	}
});
test('separate profile stores do not exchange assignments', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-profiles-test-'));
	try {
		const a = new FolderStore(path.join(dir, 'C1', 'ui-folders.json'));
		const b = new FolderStore(path.join(dir, 'C2', 'ui-folders.json'));
		await a.load();
		await b.load();
		await a.operate({type: 'create', id: 'a', name: 'Private', parentId: null});
		await a.operate({type: 'assign', projectKey: 'local:project:uuid', folderId: 'a'});
		assert.deepEqual((await b.load()).folders, []);
		assert.deepEqual(b.state.projectFolderMap, {});
	}
	finally {
		await cleanup(dir);
	}
});
test('malformed manual edits retain the last good in-memory tree', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-config-test-'));
	try {
		const file = path.join(dir, 'ui-folders.json');
		const store = new FolderStore(file);
		await store.load();
		await store.operate({type: 'create', id: 'a', name: 'Good', parentId: null});
		await fs.writeFile(file, '{"folders":');
		await assert.rejects(store.load());
		assert.equal(store.state.folders[0].name, 'Good');
	}
	finally {
		await cleanup(dir);
	}
});
