// 2026-10-15 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Implement sidebar project folder hierarchy (Folders), context menus, compact panel styling (CSS), and background CDP injection daemon (UI)":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/6
import fs from 'node:fs/promises';
import {watch} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CDP} from './cdp.mjs';
import {profiles, pipeName} from './paths.mjs';
import {createC1Recovery} from './recovery.mjs';
import {CatalogStore, catalogFile} from '../Shared-Projects/catalog.mjs';
import {ProjectSynchronizer} from '../Shared-Projects/sync.mjs';
const code = path.dirname(fileURLToPath(import.meta.url));
// 2026-10-30 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Split project into code and meta (_) repositories, relocate tool KBs to _/KB/tools, and flatten code/<tool> hierarchy":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/15
const rendererFile = path.resolve(code, '../Folders/renderer.js');
const cssFile = path.resolve(code, '../CSS/style.css');
const logFile = path.join(code, 'ui.log');
const clients = new Map();
const connecting = new Set();
const watchers = [];
const closingHidden = new Set();
const seenVisiblePort = new Set();
const catalog = new CatalogStore();
// 2026-10-17 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Add C1 post-update UI recovery, DWM freeze resilience, and idempotent external project registration with auto-trust policy":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/9
const recovery = createC1Recovery(profiles.find(p => 'C1' === p.id).home, log);
let shared = null;
let renderer = '';
let css = '';
let stopping = false;
let scanTimer = null;
let startupError = null;
async function log(message) {
	await fs.appendFile(logFile, new Date().toISOString() + ' ' + message + '\n').catch(() => {});
}
async function assets() {
	[renderer, css] = await Promise.all([fs.readFile(rendererFile, 'utf8'), fs.readFile(cssFile, 'utf8')]);
}
async function checkWindowHidden(profile, immediate = false) {
	if (!stopping && recovery?.probeWindow) {
		if (immediate) {
			await new Promise(r => setTimeout(r, 50));
		}
		if (!stopping) {
			try {
				const info = await recovery.probeWindow(profile.port);
				if (info?.Running) {
					const key = info.Pid + ':' + info.StartTicks;
					if (info.HasVisibleWindow) {
						seenVisiblePort.add(key);
					}
					else if ((seenVisiblePort.has(key) || immediate || 15000 <= Date.now() - Date.parse(info.StartedAt)) && !closingHidden.has(key)) {
						closingHidden.add(key);
						try {
							await log(profile.id + ' window closed to tray (PID ' + info.Pid + '); quitting application');
							const active = [...clients.values()].filter(c => c.profile.id === profile.id && !c.cdp.closed);
							await Promise.allSettled(active.map(c => c.cdp.evaluate("window.electronBridge?.sendMessageFromView({type:'quit-app'})")));
							await new Promise(r => setTimeout(r, 1500));
							if (!stopping) {
								await recovery.closeHidden(info);
							}
						}
						finally {
							closingHidden.delete(key);
							seenVisiblePort.delete(key);
						}
					}
				}
			}
			catch (error) {
				await log('Close hidden ' + profile.id + ': ' + error.message);
			}
		}
	}
}
function state(profile) {
	return shared
		? shared.projection(profile)
		: {
			schemaVersion: 1,
			revision: 0,
			folders: [],
			projectFolderMap: {},
			collapsedFolderIds: [],
			sync: {
				shared: true,
				accounts: Object.fromEntries(profiles.map(p => [p.id, {state: 'paused', error: startupError ?? 'Initializing'}])),
				profiles: [],
				conflicts: []
			}
		};
}
async function broadcast() {
	await Promise.allSettled([...clients.values()].filter(c => c.installed && !c.cdp.closed).map(async client => {
		const value = state(client.profile);
		const serialized = JSON.stringify(value);
		if (client.lastState !== serialized) {
			await client.cdp.evaluate('window.__codexUi?.updateState(' + serialized + ')');
			client.lastState = serialized;
		}
	}));
}
async function operate(profile, operation) {
	if (!shared) {
		throw Error(startupError ?? 'Shared catalog is not ready yet');
	}
	return shared.operation(profile, operation);
}
async function install(client) {
	if (!stopping && !client.installing && !client.cdp.closed) {
		client.installing = true;
		try {
			const valid = await client.cdp.evaluate('!!window.electronBridge?.getInitialSidebarBootstrap && "electron" === window.codexWindowType');
			if (valid) {
				await client.cdp.evaluate(renderer + '\ninstallCodexFolders(' + JSON.stringify({state: state(client.profile), css, profile: client.profile.id}) + ');');
				const escape = await client.cdp.call('Runtime.evaluate', {
					expression: `(() => {
			const guard = window.__codexUi?.handleEscape;
			if (!guard) {
				throw Error('Escape guard is missing');
			}
			const listeners = (getEventListeners(window).keydown ?? []).filter(listener => listener.useCapture);
			for (const {listener} of listeners) {
				window.removeEventListener('keydown', listener, true);
			}
			window.addEventListener('keydown', guard, true);
			for (const entry of listeners) {
				if ((entry.listener.__sentry_original__ ?? entry.listener) !== guard) {
					window.addEventListener('keydown', entry.listener, {capture: true, passive: entry.passive, once: entry.once});
				}
			}
			if (!window.__codexCloseOnHideInstalled) {
				window.__codexCloseOnHideInstalled = true;
				document.addEventListener('visibilitychange', () => {
					if ('hidden' === document.visibilityState && 'function' === typeof window.__codexUiHost) {
						window.__codexUiHost(JSON.stringify({id: '__window_hidden__', operation: {type: 'window-hidden'}}));
					}
				});
			}
			return document.visibilityState;
		})()`,
					includeCommandLineAPI: true,
					returnByValue: true
				});
				if (escape.exceptionDetails) {
					throw Error('Escape guard: ' + escape.exceptionDetails.text);
				}
				client.installed = true;
				client.lastState = null;
				await log('Installed ' + client.profile.id + ' target ' + client.id);
				if ('hidden' === escape.result?.value) {
					checkWindowHidden(client.profile, false);
				}
			}
		}
		catch (error) {
			await log('Install ' + client.profile.id + ': ' + error.message);
		}
		finally {
			client.installing = false;
		}
		shared?.wake(client.profile.id);
	}
}
async function attach(profile, target) {
	const key = profile.id + ':' + target.id;
	const existing = clients.get(key);
	if (existing) {
		if (!existing.installed) {
			await install(existing);
		}
	}
	else if (!connecting.has(key)) {
		connecting.add(key);
		try {
			const cdp = await CDP.open(target.webSocketDebuggerUrl);
			const client = {id: target.id, profile, cdp, installed: false};
			clients.set(key, client);
			cdp.on('close', () => {
				if (clients.get(key) === client) {
					clients.delete(key);
				}
				shared?.wake(profile.id);
			});
			cdp.on('Runtime.bindingCalled', async event => {
				if ('__codexSharedChanged' === event.name) {
					shared?.wake(profile.id);
				}
				else if ('__codexUiHost' === event.name) {
					let request;
					try {
						request = JSON.parse(event.payload);
						if ('window-hidden' === request?.operation?.type) {
							checkWindowHidden(profile, true);
						}
						else {
							if ('string' !== typeof request.id || !request.operation) {
								throw Error('Invalid UI request');
							}
							const value = await operate(profile, request.operation);
							await cdp.evaluate('window.__codexUi?.resolve(' + JSON.stringify(request.id) + ',' + JSON.stringify({ok: true, state: value}) + ')');
						}
					}
					catch (error) {
						if (request?.id) {
							await cdp.evaluate('window.__codexUi?.resolve(' + JSON.stringify(request.id) + ',' + JSON.stringify({ok: false, error: error.message}) + ')').catch(() => {});
						}
					}
				}
			});
			cdp.on('Page.domContentEventFired', () => {
				client.installed = false;
				client.sharedReady = false;
				client.sharedRetryAt = 0;
				install(client);
			});
			await cdp.call('Runtime.enable');
			await cdp.call('Page.enable');
			await cdp.call('Runtime.addBinding', {name: '__codexUiHost'});
			await cdp.call('Runtime.addBinding', {name: '__codexSharedChanged'});
			await install(client);
		}
		catch (error) {
			await log('Attach ' + profile.id + ': ' + error.message);
		}
		finally {
			connecting.delete(key);
		}
	}
}
function mainTarget(target) {
	let r = false;
	if ('page' === target.type && target.url?.startsWith('app://-/index.html')) {
		const route = new URL(target.url).searchParams.get('initialRoute') ?? '/';
		r = !route.includes('prewarm=1') && !route.startsWith('/avatar-overlay') && !route.startsWith('/hotkey');
	}
	return r;
}
async function scan() {
	if (!stopping) {
		await Promise.allSettled(profiles.map(async profile => {
			try {
				const response = await fetch('http://127.0.0.1:' + profile.port + '/json/list', {signal: AbortSignal.timeout(1500)});
				const targets = await response.json();
				await Promise.allSettled(targets.filter(mainTarget).map(target => attach(profile, target)));
			}
			catch {}
		}));
		const c1 = [...clients.values()].some(c => 'C1' === c.profile.id && c.installed && !c.cdp.closed);
		const c1Verified = [...clients.values()].some(c => 'C1' === c.profile.id && c.installed && (c.sharedReady || ['paused', 'unsupported'].includes(shared?.health?.get('C1')?.state)) && !c.cdp.closed);
		await recovery?.updates.tick(Date.now(), c1Verified);
		if (c1) {
			if (recovery && 'connected' !== recovery.status.state) {
				await log('C1 UI recovery verified: Folders/CSS installed');
				recovery.connected();
			}
		}
		else if (!recovery?.updates.handling) {
			await recovery?.tick();
		}
		if (!stopping) {
			scanTimer = setTimeout(scan, 2000);
		}
	}
}
async function shutdown() {
	if (!stopping) {
		stopping = true;
		clearTimeout(scanTimer);
		for (const watcher of watchers) {
			watcher.close();
		}
		recovery?.stop();
		await shared?.stop();
		await Promise.allSettled([...clients.values()].map(async client => {
			await client.cdp.evaluate('window.__codexSharedDesktop?.dispose();window.__codexUi?.dispose()');
			client.cdp.close();
		}));
		await log('UI helper stopped');
		server.close();
		setTimeout(() => process.exit(0), 100).unref();
	}
}
const server = net.createServer(socket => {
	socket.setEncoding('utf8');
	let buffer = '';
	socket.on('data', async chunk => {
		buffer += chunk;
		if (65536 < buffer.length) {
			socket.destroy();
		}
		else {
			const end = buffer.indexOf('\n');
			if (0 <= end) {
				try {
					const request = JSON.parse(buffer.slice(0, end));
					buffer = '';
					let result;
					if ('stop' === request.command) {
						socket.end(JSON.stringify({ok: true}) + '\n');
						await shutdown();
					}
					else {
						switch (request.command) {
							case 'status':
								result = {
									pid: process.pid,
									ready: !!shared,
									error: startupError,
									recovery: recovery?.status,
									update: recovery?.updates.status,
									shared: {
										file: catalogFile,
										revision: catalog.state?.revision,
										projects: Object.values(catalog.state?.projects ?? {}).filter(p => !p.deleted).length,
										folders: catalog.state?.folders.length,
										conflicts: catalog.state?.conflicts,
										accounts: shared?.status()
									},
									profiles: profiles.map(p => ({id: p.id, file: catalogFile, revision: catalog.state?.revision})),
									clients: [...clients.values()].map(c => ({
										profile: c.profile.id,
										id: c.id,
										installed: c.installed,
										sharedReady: !!c.sharedReady,
										appVersion: c.sharedInfo?.appVersion
									}))
								};
								break;
							case 'state':
								result = state(request.profile ?? 'C1');
								break;
							case 'operation': {
								const profile = profiles.find(p => p.id === request.profile);
								if (!profile) {
									throw Error('Unknown profile');
								}
								result = await operate(profile, request.operation);
								break;
							}
							case 'shared-catalog':
								if (!shared) {
									throw Error(startupError ?? 'Shared catalog is not ready yet');
								}
								result = catalog.state;
								break;
							case 'shared-ensure-project':
								if (!shared) {
									throw Error(startupError ?? 'Shared catalog is not ready yet');
								}
								for (const root of request.project?.rootPaths ?? []) {
									if (!(await fs.stat(root)).isDirectory()) {
										throw Error('Project working directory does not exist');
									}
								}
								result = await shared.ensureProject(request.profile, request.project);
								break;
							case 'shared-registration':
								if (!shared) {
									throw Error(startupError ?? 'Shared catalog is not ready yet');
								}
								result = shared.registration(request.sharedId, request.profile);
								break;
							case 'shared-cleanup-project':
								if (!shared) {
									throw Error(startupError ?? 'Shared catalog is not ready yet');
								}
								result = await shared.cleanupProject(request);
								break;
							case 'shared-sync':
								shared?.wakeAll();
								result = {queued: true};
								break;
							case 'shared-reconnect':
								for (const [key, c] of clients) {
									if (!request.profile || c.profile.id === request.profile) {
										await c.cdp.evaluate('window.__codexSharedDesktop?.dispose()');
										c.cdp.close();
										clients.delete(key);
									}
								}
								result = {reconnecting: true};
								break;
							case 'reload':
								await assets();
								await Promise.allSettled([...clients.values()].map(install));
								result = {reloaded: true};
								break;
							default:
								throw Error('Unknown command');
						}
						socket.end(JSON.stringify({ok: true, result}) + '\n');
					}
				}
				catch (error) {
					socket.end(JSON.stringify({ok: false, error: error.message}) + '\n');
				}
			}
		}
	});
	socket.on('error', () => {});
});
server.on('error', error => {
	if ('EADDRINUSE' === error.code) {
		process.exit(0);
	}
	console.error(error);
	process.exit(1);
});
server.listen(pipeName, async () => {
	await log('UI helper starting, PID ' + process.pid);
	await assets();
	try {
		await catalog.load(profiles);
		shared = new ProjectSynchronizer({store: catalog, profiles, getClients: () => [...clients.values()], notify: broadcast, log});
		shared.start();
	}
	catch (error) {
		startupError = 'Failed to open shared catalog: ' + error.message;
		await log(startupError);
	}
	let assetTimer;
	for (const file of [rendererFile, cssFile]) {
		watchers.push(watch(file, () => {
			clearTimeout(assetTimer);
			assetTimer = setTimeout(async () => {
				try {
					await assets();
					await Promise.allSettled([...clients.values()].map(install));
				}
				catch (error) {
					await log('Asset reload: ' + error.message);
				}
			}, 150);
		}));
	}
	await scan();
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', error => {
	log('Fatal: ' + error.stack).finally(() => process.exit(1));
});
process.on('unhandledRejection', error => log('Unhandled: ' + String(error)));
