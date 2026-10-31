// 2026-10-15 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Synchronize workspace projects and folder catalog between C1 and C2 with trust-free replica restore (Shared-Projects)":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/7
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {CDP} from '../UI/cdp.mjs';
import {profiles} from '../UI/paths.mjs';
import {stateDirectory} from './catalog.mjs';
const command = process.argv[2] ?? 'status';
if (!['start', 'status', 'forget'].includes(command)) {
	throw Error('Expected start, status or forget');
}
const profile = profiles.find(p => 'C1' === p.id);
const targets = await (await fetch('http://127.0.0.1:' + profile.port + '/json/list')).json();
const target = targets.find(t => 'page' === t.type && 'app://-/index.html' === t.url);
if (!target) {
	throw Error('C1 window unavailable');
}
const c = await CDP.open(target.webSocketDebuggerUrl);
try {
	const item = {id: randomUUID(), name: 'Shared Projects — cancel ' + randomUUID().slice(0, 8), rootPaths: [path.join(stateDirectory, 'integration-workspace')]};
	const result = await c.evaluate('(' + function (command, item) {
		const previous = window.__codexSharedCancelCheck;
		let r;
		if ('status' === command) {
			r = previous ?? null;
		}
		else if ('forget' === command) {
			if ('pending' === previous?.state) {
				throw Error('Native confirmation is still pending');
			}
			delete window.__codexSharedCancelCheck;
			r = {forgotten: true};
		}
		else if (previous) {
			r = previous;
		}
		else {
			r = window.__codexSharedCancelCheck = {id: item.id, name: item.name, rootPaths: item.rootPaths, state: 'pending', startedAt: new Date().toISOString()};
			window.__codexSharedDesktop.upsert(item, null).then(
				result => Object.assign(r, {state: 'accepted', result}),
				error => Object.assign(r, {state: 'declined', error: String(error?.message ?? error)})
			);
		}
		return r;
	}.toString() + ')(' + JSON.stringify(command) + ',' + JSON.stringify(item) + ')');
	if (result && 'forget' !== command) {
		await fs.writeFile(path.join(stateDirectory, 'verification-cancel.json'), JSON.stringify(result, null, 2) + '\n');
	}
	console.log(JSON.stringify(result, null, 2));
}
finally {
	c.close();
}
