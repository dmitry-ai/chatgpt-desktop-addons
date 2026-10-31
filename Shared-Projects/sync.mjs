// 2026-10-15 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Synchronize workspace projects and folder catalog between C1 and C2 with trust-free replica restore (Shared-Projects)":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/7
import {connectScript} from './desktop.mjs';
import {
	observeProjects,
	planOperation,
	acknowledge,
	markStarted,
	failOperation,
	resumeSync,
	projectState,
	folderOperation,
	pendingCount,
	ensureProject,
	registrationReceipt,
	selectRegistrationSources,
	assignCreatedProject
} from './catalog.mjs';
import {TrustPolicy} from './trust.mjs';
import {cleanupProject} from './cleanup.mjs';
const allowedEvents = new Set(['createLocal', 'editLocal', 'renameLocal', 'upsertLocal', 'removeLocal', 'setProjectOrder']);
export class ProjectSynchronizer {
	constructor({store, profiles, getClients, notify, log, trustPolicy = new TrustPolicy()}) {
		Object.assign(this, {store, profiles, getClients, notify, log, trustPolicy});
		this.runners = new Map();
		this.health = new Map();
		this.stopping = false;
		this.timer = null;
		for (const p of profiles) {
			this.health.set(p.id, {state: 'offline'});
		}
	}
	async attach(client) {
		if (!this.stopping && !client.sharedConnecting && !client.sharedReady && !client.cdp.closed && !(client.sharedRetryAt > Date.now())) {
			client.sharedConnecting = true;
			try {
				const info = await client.cdp.evaluate(connectScript(), 20000);
				client.sharedReady = true;
				client.sharedInfo = {appVersion: info.appVersion, url: info.url, exportName: info.exportName};
				client.sharedRetryAt = 0;
				this.health.set(client.profile.id, {state: 'connected', appVersion: info.appVersion});
				await this.log('Shared projects connected ' + client.profile.id + ' ' + info.appVersion + ' ' + info.exportName);
			}
			catch (error) {
				const starting = String(error?.message ?? error).includes('DESKTOP_STARTING:');
				client.sharedReady = false;
				client.sharedRetryAt = Date.now() + (starting ? 1000 : 30000);
				if (starting) {
					this.health.set(client.profile.id, {state: 'initializing'});
				}
				else {
					await this.report(client.profile.id, error, 'unsupported');
				}
			}
			finally {
				client.sharedConnecting = false;
			}
		}
	}
	status() {
		return Object.fromEntries(this.profiles.map(p => [p.id, {...this.health.get(p.id), pending: pendingCount(this.store.state, p.id)}]));
	}
	projection(profile) {
		return projectState(this.store.state, 'string' === typeof profile ? profile : profile.id, {accounts: this.status()});
	}
	// 2026-10-17 Dmitrii Fediuk https://github.com/dmitrii-fediuk
	// "Add C1 post-update UI recovery, DWM freeze resilience, and idempotent external project registration with auto-trust policy":
	// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/9
	async ensureProject(profileId, spec) {
		await this.trustPolicy.prepare(spec);
		const availableProfiles = this.getClients().filter(c => c.installed && c.sharedReady && !c.cdp.closed).map(c => c.profile.id);
		const {result} = await this.store.transact(state => ensureProject(state, profileId, spec, {availableProfiles}));
		await this.notify();
		this.wakeAll();
		if (!result.complete && availableProfiles.length) {
			const source = result.registration_source ?? profileId;
			let timer;
			await Promise.race([
				(async () => {
					await this.wake(source);
					if (source !== profileId && availableProfiles.includes(profileId)) {
						await this.wake(profileId);
					}
				})(),
				new Promise(r => {
					timer = setTimeout(r, 5000);
					timer.unref?.();
				})
			]).catch(() => {}).finally(() => clearTimeout(timer));
		}
		return this.registration(result.shared_id, profileId);
	}
	registration(id, profileId) {
		return {...registrationReceipt(this.store.state, id, profileId), accounts: this.status()};
	}
	cleanupProject(spec) {
		return cleanupProject(this, spec);
	}
	async operation(profile, operation) {
		if ('assign-created-project' === operation.type) {
			const client = this.getClients().find(c => c.profile.id === profile.id && c.sharedReady && !c.cdp.closed);
			if (!client) {
				throw Error('App is not connected yet');
			}
			const snapshot = await client.cdp.evaluate('window.__codexSharedDesktop.read()', 20000);
			await this.store.transact(s => assignCreatedProject(s, profile.id, snapshot, operation.projectId, operation.folderId));
		}
		else if ('retry-sync' === operation.type) {
			await this.store.transact(resumeSync);
			for (const p of this.profiles) {
				const h = this.health.get(p.id);
				if (h) {
					delete h.manualRetry;
					delete h.error;
					delete h.retryAt;
				}
				for (const c of this.getClients().filter(c => c.profile.id === p.id)) {
					c.sharedRetryAt = 0;
				}
			}
		}
		else {
			await this.store.transact(s => folderOperation(s, profile.id, operation));
		}
		await this.notify();
		this.wakeAll();
		return this.projection(profile);
	}
	start() {
		this.timer = setInterval(() => this.wakeAll(), 2000);
		this.wakeAll();
	}
	wakeAll() {
		if (!this.stopping) {
			for (const p of this.profiles) {
				this.wake(p.id);
			}
		}
	}
	wake(profileId) {
		let r;
		if (this.stopping) {
			r = Promise.resolve();
		}
		else {
			let runner = this.runners.get(profileId);
			if (runner?.running) {
				runner.again = true;
				r = runner.promise;
			}
			else {
				runner = {running: true, again: false, promise: null};
				this.runners.set(profileId, runner);
				runner.promise = this.run(profileId).catch(error => this.report(profileId, error)).finally(async () => {
					runner.running = false;
					await this.notify().catch(() => {});
					if (runner.again && !this.stopping) {
						setTimeout(() => this.wake(profileId), 50);
					}
				});
				r = runner.promise;
			}
		}
		return r;
	}
	async report(profile, error, state = 'paused') {
		const previous = this.health.get(profile) ?? {};
		const message = String(error?.message ?? error);
		if (previous.error !== message) {
			await this.log('Shared projects ' + profile + ': ' + message);
		}
		if (message.includes('Runtime.evaluate timed out')) {
			for (const c of this.getClients().filter(c => c.profile.id === profile && !c.cdp.closed)) {
				try {
					c.cdp.close();
				}
				catch {}
			}
		}
		this.health.set(profile, {...previous, state, error: message, retryAt: Date.now() + 30000});
	}
	async collect(profile, client) {
		const events = [];
		for (const c of this.getClients().filter(c => c.profile.id === profile && c.sharedReady && !c.cdp.closed)) {
			const pending = await c.cdp.evaluate('window.__codexSharedDesktop?.drainEvents()??[]');
			if (pending.some(e => 'overflow' === e.method)) {
				throw Error('Too many unconfirmed changes. Check projects before retrying.');
			}
			events.push(...pending.filter(e => allowedEvents.has(e.method)));
		}
		const r = await client.cdp.evaluate('window.__codexSharedDesktop.read()', 20000);
		await this.store.transact(s => {
			for (const event of events) {
				observeProjects(s, profile, r, event);
			}
			observeProjects(s, profile, r);
		});
		return r;
	}
	async run(profile) {
		if (!this.cleaning) {
			const clients = this.getClients().filter(c => c.profile.id === profile && !c.cdp.closed && c.installed);
			if (!clients.length) {
				this.health.set(profile, {state: 'offline'});
			}
			else {
				for (const c of clients) {
					await this.attach(c);
				}
				const client = clients.find(c => c.sharedReady);
				if (client) {
					let snapshot = await this.collect(profile, client);
					await this.store.transact(s => selectRegistrationSources(s, this.getClients().filter(c => c.installed && c.sharedReady && !c.cdp.closed).map(c => c.profile.id)));
					await client.cdp.evaluate('window.__codexSharedDesktop.retainOperations(' + JSON.stringify(this.store.state.operations.map(o => o.id)) + ')');
					const pauseReason = this.store.state.profiles[profile].pauseReason;
					if (pauseReason) {
						this.health.set(profile, {state: 'paused', error: pauseReason, manualRetry: true, appVersion: client.sharedInfo?.appVersion});
					}
					else if (!(this.health.get(profile)?.retryAt > Date.now())) {
						this.health.set(profile, {state: 'connected', appVersion: client.sharedInfo?.appVersion});
						let stoppedEarly = false;
						for (let count = 0; 8 > count && !this.stopping && !stoppedEarly; count++) {
							const {result: operation} = await this.store.transact(async s => {
								const planned = planOperation(s, profile, snapshot);
								const current = planned ? s.operations.find(op => op.id === planned.id) : null;
								let r = null;
								if (current) {
									if (!current.startedAt) {
										current.trust = await this.trustPolicy.operation(s.projects[current.projectId], current, this.profiles.find(p => p.id === profile));
									}
									r = markStarted(s, planned.id);
								}
								return r;
							});
							if (!operation) {
								break;
							}
							try {
								const allowStart = !this.store.state.conflicts.some(c => c.projectId === operation.projectId);
								const result = await client.cdp.evaluate('window.__codexSharedDesktop.startOperation(' + JSON.stringify(operation) + ',' + allowStart + ')');
								if ('pending' === result.state) {
									this.health.set(profile, {state: 'waiting', appVersion: client.sharedInfo?.appVersion});
									stoppedEarly = true;
								}
								else if ('blocked' === result.state) {
									await this.store.transact(s => failOperation(s, operation.id, 'Conflict before dispatch'));
									this.health.set(profile, {state: 'paused', error: 'Operation is waiting for conflict resolution', appVersion: client.sharedInfo?.appVersion});
									stoppedEarly = true;
								}
								else if ('failed' === result.state) {
									const registrationBlock = result.error.startsWith('UNTRUSTED_PROJECT:')
										? 'untrusted'
										: /^(TRUST_|TRUST_PROFILE_)/.test(result.error)
											? 'blocked'
											: null;
									await this.store.transact(s => failOperation(s, operation.id, result.error, {pause: result.error.includes('did not confirm project save'), registrationBlock}));
									await client.cdp.evaluate('window.__codexSharedDesktop.forgetOperation(' + JSON.stringify(operation.id) + ')');
									throw Error(result.error);
								}
								else {
									if ('done' !== result.state) {
										throw Error('Invalid Desktop App operation response');
									}
									await this.store.transact(s => acknowledge(s, operation, result.result));
									await client.cdp.evaluate('window.__codexSharedDesktop.forgetOperation(' + JSON.stringify(operation.id) + ')');
									await this.log('Shared project ' + operation.type + ' applied to ' + profile + ': ' + operation.projectId);
									snapshot = await this.collect(profile, client);
								}
							}
							catch (error) {
								await this.report(profile, error);
								if (String(error.message).includes('PROJECT_CHANGED')) {
									snapshot = await this.collect(profile, client);
								}
								else {
									stoppedEarly = true;
								}
							}
						}
					}
				}
			}
		}
	}
	async stop() {
		this.stopping = true;
		clearInterval(this.timer);
		await Promise.allSettled([...this.runners.values()].map(r => r.promise));
	}
}
