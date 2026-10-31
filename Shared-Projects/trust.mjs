// 2026-10-17 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Add C1 post-update UI recovery, DWM freeze resilience, and idempotent external project registration with auto-trust policy":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/9
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export class TrustPolicy {
	constructor(file = fileURLToPath(new URL('./trust-policy.json', import.meta.url))) {
		this.file = file;
	}
	async prepare(spec) {
		if (undefined !== spec?.trustPolicy) {
			if ('upwork-daily' !== spec.trustPolicy) {
				throw Error('TRUST_POLICY: unknown trust policy');
			}
			const policy = JSON.parse(await fs.readFile(this.file, 'utf8'));
			const runtime = JSON.parse(await fs.readFile(policy.upworkRuntime, 'utf8'));
			if (!path.isAbsolute(runtime.workspace_root) || !runtime.daily_root || path.isAbsolute(runtime.daily_root)) {
				throw Error('TRUST_POLICY: invalid daily directory');
			}
			const daily = path.resolve(runtime.workspace_root, runtime.daily_root);
			const relativeDaily = path.relative(runtime.workspace_root, daily);
			if (!relativeDaily || '..' === relativeDaily || relativeDaily.startsWith('..' + path.sep) || path.isAbsolute(relativeDaily)) {
				throw Error('TRUST_POLICY: daily is outside workspace');
			}
			const scope = await fs.realpath(daily);
			if (!Array.isArray(spec.rootPaths) || 1 !== spec.rootPaths.length) {
				throw Error('TRUST_POLICY: exactly one Upwork root is required');
			}
			for (const root of spec.rootPaths) {
				if ('string' !== typeof root || !path.isAbsolute(root)) {
					throw Error('TRUST_POLICY: absolute root is required');
				}
				const real = await fs.realpath(root);
				const relative = path.relative(scope, real);
				if (!relative || '..' === relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !(await fs.stat(real)).isDirectory()) {
					throw Error('TRUST_POLICY: root is outside configured daily directory');
				}
			}
		}
		return spec;
	}
	async operation(project, operation, profile) {
		let r = null;
		if (project.trustPolicy && 'upsert' === operation.type) {
			await this.prepare({trustPolicy: project.trustPolicy, rootPaths: operation.value.rootPaths});
			r = {policy: project.trustPolicy, roots: [...operation.value.rootPaths], configFile: path.join(profile.home, 'config.toml')};
		}
		return r;
	}
}
export async function ensureTrustedRoots(request, policy) {
	if (!policy || 'upwork-daily' !== policy.policy || !Array.isArray(policy.roots) || 1 !== policy.roots.length) {
		throw Error('TRUST_POLICY: invalid trust operation');
	}
	const key = value => value.replaceAll('/', '\\').replace(/^\\\\\?\\/, '').replace(/\\+$/, '').toLowerCase();
	const read = () => request('config/read', {includeLayers: true, cwd: null});
	const before = await read();
	const user = before.layers?.filter(layer => 'user' === layer.name?.type).at(-1);
	if (!user?.version || 'string' !== typeof user.name.file || !/^\w:[\\/]/.test(user.name.file) || key(user.name.file) !== key(policy.configFile)) {
		throw Error('TRUST_PROFILE_MISMATCH: selected Windows profile config is not confirmed');
	}
	const rejectUntrusted = response => {
		for (const root of policy.roots) {
			for (const config of [response.config, ...(response.layers ?? []).filter(l => !l.disabledReason).map(l => l.config)]) {
				if (Object.entries(config?.projects ?? {}).some(([name, value]) => key(name) === key(root) && 'untrusted' === value?.trust_level)) {
					throw Error('UNTRUSTED_PROJECT: explicit untrusted status for ' + root);
				}
			}
		}
	};
	rejectUntrusted(before);
	const missing = policy.roots.filter(root => 'trusted' !== before.config?.projects?.[root]?.trust_level);
	if (missing.length) {
		const result = await request('config/batchWrite', {
			edits: missing.map(root => ({
				keyPath: 'projects.' + JSON.stringify(root) + '.trust_level',
				value: 'trusted',
				mergeStrategy: 'replace'
			})),
			filePath: user.name.file,
			expectedVersion: user.version,
			reloadUserConfig: true
		});
		if ('ok' !== result?.status) {
			throw Error('TRUST_OVERRIDDEN: configuration did not confirm trust');
		}
	}
	const after = await read();
	rejectUntrusted(after);
	if (policy.roots.some(root => 'trusted' !== after.config?.projects?.[root]?.trust_level)) {
		throw Error('TRUST_UNVERIFIED: effective configuration does not confirm exact root');
	}
	return {status: 'verified', roots: [...policy.roots], checkedAt: new Date().toISOString(), written: 0 < missing.length};
}
