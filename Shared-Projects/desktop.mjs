// 2026-10-15 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Synchronize workspace projects and folder catalog between C1 and C2 with trust-free replica restore (Shared-Projects)":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/7
import {ensureTrustedRoots} from './trust.mjs';
export function findProjectServiceExport(source) {
	const candidates = [];
	const pattern = /function\s+([\w$]+)\(\)\{let\s+([\w$]+)=([\w$]+)\.projects;if\(\2==null\)throw Error\([^)]*\);return \2\}/g;
	for (const match of source.matchAll(pattern)) {
		for (const exports of source.matchAll(/export\s*\{([^}]+)\}/g)) {
			for (const entry of exports[1].split(',')) {
				const parts = entry.trim().split(/\s+as\s+/);
				if (parts[0] === match[1]) {
					candidates.push(parts[1] ?? parts[0]);
				}
			}
		}
	}
	const unique = [...new Set(candidates)];
	if (1 !== unique.length) {
		throw Error('Unambiguous Desktop App project service not found');
	}
	return unique[0];
}
export function findProjectHostImport(source) {
	const getter = /function\s+([\w$]+)\(\)\{let\s+([\w$]+)=([\w$]+)\.projects;if\(\2==null\)throw Error\([^)]*\);return \2\}/.exec(source);
	if (!getter) {
		throw Error('Project service getter is missing');
	}
	const variable = getter[3];
	const matches = [];
	for (const declaration of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*(['"`])([^'"`]+)\2/g)) {
		for (const entry of declaration[1].split(',')) {
			const parts = entry.trim().split(/\s+as\s+/);
			if ((parts[1] ?? parts[0]) === variable) {
				matches.push({name: parts[0], url: declaration[3]});
			}
		}
	}
	if (1 !== matches.length) {
		throw Error('Project host binding is ambiguous');
	}
	return matches[0];
}
// 2026-10-17 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Add C1 post-update UI recovery, DWM freeze resilience, and idempotent external project registration with auto-trust policy":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/9
export function findMessageBusImport(source) {
	const names = [...new Set([...source.matchAll(/([\w$]+)\.subscribe\([`'"](?:shared-object-updated|mcp-notification)[`'"]/g)].map(m => m[1]))];
	if (1 !== names.length || !source.includes(names[0] + '.dispatchMessage(')) {
		throw Error('Desktop message bus is ambiguous');
	}
	const matches = [];
	for (const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*(['"`])([^'"`]+)\2/g)) {
		for (const entry of m[1].split(',')) {
			const parts = entry.trim().split(/\s+as\s+/);
			if ((parts[1] ?? parts[0]) === names[0]) {
				matches.push({name: parts[0], url: m[3]});
			}
		}
	}
	if (1 !== matches.length) {
		throw Error('Desktop message bus import is ambiguous');
	}
	return matches[0];
}
export function configRequest(bus, method, params) {
	if (!['config/read', 'config/batchWrite'].includes(method)) {
		throw Error('Unsupported shared-project config method');
	}
	return new Promise((resolve, reject) => {
		const id = crypto.randomUUID();
		let timer;
		let off = () => {};
		const finish = (error, result) => {
			clearTimeout(timer);
			off();
			error ? reject(error) : resolve(result);
		};
		try {
			off = bus.subscribe('mcp-response', event => {
				if ('local' === event.hostId && event.message?.id === id) {
					event.message.error ? finish(Error(event.message.error.message)) : finish(null, event.message.result);
				}
			});
			timer = setTimeout(() => finish(Error('TRUST_TIMEOUT: configuration request result was not received')), 15000);
			bus.dispatchMessage('mcp-request', {hostId: 'local', request: {id, method, params}, priority: 'interactive', source: 'config', timeoutMs: 15000});
		}
		catch (error) {
			finish(error);
		}
	});
}
export function operationLedger(tasks, execute, changed) {
	const state = task => 'done' === task.state
		? {state: 'done', result: task.result}
		: 'failed' === task.state
			? {state: 'failed', error: task.error}
			: {state: 'pending'};
	return {
		start(operation, allowStart = true) {
			const key = JSON.stringify([operation.type, operation.desktopId, operation.value, operation.expected, operation.registration, operation.approvedBy, operation.trust]);
			const previous = tasks.get(operation.id);
			let r;
			if (previous) {
				if (previous.key !== key) {
					throw Error('Operation ID was reused with different data');
				}
				r = state(previous);
			}
			else if (!allowStart) {
				r = {state: 'blocked'};
			}
			else {
				const task = {key, state: 'pending'};
				tasks.set(operation.id, task);
				Promise.resolve().then(() => execute(operation)).then(
					result => Object.assign(task, {state: 'done', result}),
					error => Object.assign(task, {state: 'failed', error: String(error?.message ?? error)})
				).finally(() => {
					try {
						changed();
					}
					catch {}
				});
				r = state(task);
			}
			return r;
		},
		forget(id) {
			if ('pending' !== tasks.get(id)?.state) {
				tasks.delete(id);
			}
		},
		retain(ids) {
			const keep = new Set(ids);
			for (const [id, task] of tasks) {
				if ('pending' !== task.state && !keep.has(id)) {
					tasks.delete(id);
				}
			}
		}
	};
}
async function connectDesktop(findExport, findHost, makeLedger, findBus, requestConfig, ensureTrust) {
	let r;
	if (8 === window.__codexSharedDesktop?.version) {
		r = window.__codexSharedDesktop.info;
	}
	else {
		let urls = [...new Set([
			...performance.getEntriesByType('resource').map(e => e.name),
			...[...document.scripts].map(e => e.src)
		])].filter(url => /^app:\/\/-\/assets\/app-initial-[\w-]+\.js$/.test(url));
		const primaryUrls = new Set();
		// 2026-10-30 Dmitrii Fediuk https://github.com/dmitrii-fediuk
		// "Support unprivileged staged MSIX discovery (GetStagedPackagePathByFullName), Win32/NT process scanning without WMI, and Rolldown bundle chain":
		// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/14
		const scanBootstrap = async () => {
			const found = new Set();
			const seen = new Set();
			const queue = [...document.scripts].map(s => s.src).filter(u => /^app:\/\/-\/assets\/index-[\w-]+\.js$/.test(u));
			while (queue.length) {
				const next = queue.shift();
				if (!seen.has(next)) {
					seen.add(next);
					const res = await fetch(next);
					if (res.ok) {
						const entry = await res.text();
						for (const match of entry.matchAll(/app-initial-[\w-]+\.js/g)) {
							found.add(new URL('./' + match[0], next).href);
						}
						for (const match of entry.matchAll(/app-primary-[\w-]+\.js/g)) {
							primaryUrls.add(new URL('./' + match[0], next).href);
						}
						for (const match of entry.matchAll(/app-(?:main|runtime)-[\w-]+\.js/g)) {
							queue.push(new URL('./' + match[0], next).href);
						}
					}
				}
			}
			return [...found];
		};
		if (!urls.length) {
			urls = await scanBootstrap();
		}
		if (1 !== urls.length) {
			throw Error('Main Desktop App module not found or ambiguous');
		}
		const url = urls[0];
		const response = await fetch(url);
		if (!response.ok) {
			throw Error('Failed to read Desktop App module');
		}
		const source = await response.text();
		let bundle = source;
		if (!bundle.includes('.upsertLocal(') || !bundle.includes('.editLocal(') || !bundle.includes('.setProjectOrder(') || !/\.upsertLocal\([\s\S]{0,600}?,[`'"]restore[`'"]\)/.test(bundle)) {
			for (const match of source.matchAll(/app-primary-[\w-]+\.js/g)) {
				primaryUrls.add(new URL('./' + match[0], url).href);
			}
			if (!primaryUrls.size) {
				await scanBootstrap();
			}
			for (const nextUrl of primaryUrls) {
				const res = await fetch(nextUrl);
				if (res.ok) {
					bundle += '\n' + await res.text();
				}
			}
		}
		if (!bundle.includes('.upsertLocal(') || !bundle.includes('.editLocal(') || !bundle.includes('.setProjectOrder(')) {
			throw Error('Desktop App project contract changed; synchronization stopped');
		}
		if (!/\.upsertLocal\([\s\S]{0,600}?,[`'"]restore[`'"]\)/.test(bundle)) {
			throw Error('Desktop App project restore mode is not confirmed; synchronization stopped');
		}
		const name = findExport(source);
		const module = await import(url);
		const binding = findHost(source);
		const host = (await import(new URL(binding.url, url).href))[binding.name];
		if (!host?.projects) {
			throw Error('DESKTOP_STARTING: project service is still initializing');
		}
		const projects = module[name]();
		if (['getLocalProjects', 'createLocal', 'editLocal', 'renameLocal', 'upsertLocal', 'removeLocal', 'setProjectOrder'].some(m => 'function' !== typeof projects?.[m])) {
			throw Error('Desktop App project contract changed; synchronization stopped');
		}
		const busBinding = findBus(source);
		const bus = (await import(new URL(busBinding.url, url).href))[busBinding.name];
		if ('function' !== typeof bus?.subscribe || 'function' !== typeof bus?.dispatchMessage) {
			throw Error('Desktop config connection is unavailable');
		}
		const descriptor = Object.getOwnPropertyDescriptor(host, 'projects');
		if (host.projects !== projects || !descriptor?.writable) {
			throw Error('Desktop project capability cannot be safely observed');
		}
		const read = async () => {
			const value = await projects.getLocalProjects();
			if (!value || Array.isArray(value) || 'object' !== typeof value) {
				throw Error('Invalid Desktop App project list');
			}
			for (const [id, item] of Object.entries(value)) {
				if (!item || item.id !== id || 'string' !== typeof item.name || !Array.isArray(item.rootPaths) ||
					item.rootPaths.some(p => 'string' !== typeof p || !p)) {
					throw Error('Desktop App project format changed');
				}
			}
			return value;
		};
		const clean = values => Object.fromEntries(Object.entries(values).map(([id, p]) => [id, {
			id,
			name: p.name,
			rootPaths: p.rootPaths,
			cloudBacked: !!(p.chatGptBacking || p.chatGptBackingCreation || p.retiredChatGptBacking)
		}]));
		const events = [];
		const creationListeners = new Set();
		const methods = new Set(['createLocal', 'editLocal', 'renameLocal', 'upsertLocal', 'removeLocal', 'setProjectOrder']);
		const wrappers = new Map();
		const proxy = new Proxy(projects, {
			get(target, key) {
				const original = target[key];
				let prop = original;
				if (methods.has(key) && 'function' === typeof original) {
					if (!wrappers.has(key)) {
						wrappers.set(key, async (...args) => {
							const created = 'createLocal' === key ? [...creationListeners].map(listener => listener()).filter(Boolean) : [];
							let before;
							try {
								before = clean(await read());
							}
							catch {}
							const result = await Reflect.apply(original, target, args);
							let after;
							try {
								after = clean(await read());
							}
							catch {}
							if (before && after) {
								events.push({id: crypto.randomUUID(), method: key, args, before, after});
								if (100 < events.length) {
									events.splice(0, events.length - 100);
									events.push({method: 'overflow'});
								}
								try {
									window.__codexSharedChanged?.(JSON.stringify({event: 'projects'}));
								}
								catch {}
							}
							if (result?.projectId) {
								for (const listener of created) {
									try {
										await listener(result.projectId);
									}
									catch (error) {
										console.warn('[codex-folders] Project placement:', error);
									}
								}
							}
							return result;
						});
					}
					prop = wrappers.get(key);
				}
				return prop;
			}
		});
		const snapshot = clean(await read());
		window.__codexSharedDesktop?.dispose?.();
		host.projects = proxy;
		const info = {url, exportName: name, appVersion: window.electronBridge?.getSentryInitOptions?.().appVersion ?? null};
		const api = window.__codexSharedDesktop = {
			version: 8,
			info,
			read: async () => clean(await read()),
			onLocalProjectCreating(listener) {
				creationListeners.add(listener);
				return () => creationListeners.delete(listener);
			},
			drainEvents() {
				return events.splice(0);
			},
			dispose() {
				creationListeners.clear();
				if (host.projects === proxy) {
					host.projects = projects;
				}
				delete window.__codexSharedDesktop;
			},
			async upsert(item, expected, registration = 'sync', trust = null) {
				if (!['sync', 'restore'].includes(registration)) {
					throw Error('Unknown project registration mode');
				}
				if (
					!item ||
					'string' !== typeof item.id ||
					!item.id ||
					'string' !== typeof item.name ||
					!item.name.trim() ||
					!Array.isArray(item.rootPaths) ||
					!item.rootPaths.length
				) {
					throw Error('Invalid project operation');
				}
				const before = await read();
				const existing = before[item.id];
				const fields = p => p ? JSON.stringify([p.name, p.rootPaths]) : null;
				if (undefined !== expected && fields(existing) !== fields(expected)) {
					throw Error('PROJECT_CHANGED: project changed before applying operation');
				}
				if (existing?.chatGptBacking || existing?.chatGptBackingCreation || existing?.retiredChatGptBacking) {
					throw Error('ChatGPT cloud projects are not synchronized by this module');
				}
				if (trust && JSON.stringify(trust.roots) !== JSON.stringify(item.rootPaths)) {
					throw Error('TRUST_POLICY: operation roots did not match');
				}
				const verified = trust ? await ensureTrust((method, params) => requestConfig(bus, method, params), trust) : null;
				const checked = (await read())[item.id];
				if (fields(checked) !== fields(existing)) {
					throw Error('PROJECT_CHANGED: project changed during trust check');
				}
				if (checked?.chatGptBacking || checked?.chatGptBackingCreation || checked?.retiredChatGptBacking) {
					throw Error('PROJECT_CHANGED: project became cloud-backed');
				}
				const ok = await projects.upsertLocal({projectId: item.id, name: item.name, sources: item.rootPaths}, registration);
				if (true !== ok) {
					throw Error('App did not confirm project save');
				}
				const after = await read();
				if (!after[item.id]) {
					throw Error('Project did not appear after save');
				}
				return {...clean(after)[item.id], ...(verified ? {trust: verified} : {})};
			},
			async remove(id, expected) {
				const before = await read();
				const existing = before[id];
				if (existing) {
					if (JSON.stringify([existing.name, existing.rootPaths]) !== JSON.stringify([expected.name, expected.rootPaths])) {
						throw Error('PROJECT_CHANGED: project changed before deletion');
					}
					if (existing.chatGptBacking || existing.chatGptBackingCreation || existing.retiredChatGptBacking) {
						throw Error('Cloud project deletion is not supported');
					}
					await projects.removeLocal(id);
					if ((await read())[id]) {
						throw Error('App did not confirm project deletion');
					}
				}
				return {removed: true};
			}
		};
		const tasks = window.__codexSharedTasks ??= new Map();
		const ledger = makeLedger(
			tasks,
			op => 'upsert' === op.type
				? api.upsert({id: op.desktopId, ...op.value}, op.expected, 'restore' === op.registration && 'string' === typeof op.approvedBy ? 'restore' : 'sync', op.trust)
				: api.remove(op.desktopId, op.expected),
			() => window.__codexSharedChanged?.(JSON.stringify({event: 'operation'}))
		);
		api.startOperation = (operation, allowStart) => ledger.start(operation, allowStart);
		api.forgetOperation = id => ledger.forget(id);
		api.retainOperations = ids => ledger.retain(ids);
		r = {...info, snapshot};
	}
	return r;
}
export const connectScript = () => '(' + connectDesktop.toString() + ')(' + [findProjectServiceExport, findProjectHostImport, operationLedger, findMessageBusImport, configRequest, ensureTrustedRoots].map(fn => fn.toString()).join(',') + ')';
