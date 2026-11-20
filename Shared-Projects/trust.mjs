// 2026-11-20 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Add Ⰿ/≻/♕/⛯ registry candidate and relocated ⛯ primary support in trust.mjs":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/22
// 2026-11-20 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Resolve upworkRuntime templates from Harness paths.json and accept relocated V1 manifests":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/20
// 2026-11-19 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Support path registry template expansion in Shared-Projects TrustPolicy":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/18
// 2026-10-17 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Add C1 post-update UI recovery, DWM freeze resilience, and idempotent external project registration with auto-trust policy":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/9
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const ESC_DOLLAR = '\0HARNESS_DOLLAR_LBRACE\0';
const ESC_PCT = '\0HARNESS_PERCENT\0';
const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOKEN_RE = /\$\$\{|%%|\$\{([^}]*)\}|%([A-Za-z_][A-Za-z0-9_]*)%/g;
function lookupEnv(name, env) {
	const upper = name.toUpperCase();
	const hit = Object.entries(env ?? {}).find(([k, v]) => k.toUpperCase() === upper && String(v ?? '').trim());
	if (hit) {
		return String(hit[1]).replaceAll('\\', '/');
	}
	const home = os.homedir().replaceAll('\\', '/').replace(/\/+$/, '');
	if ('USERPROFILE' === upper || 'HOME' === upper) {
		return home;
	}
	if ('APPDATA' === upper) {
		return `${home}/AppData/Roaming`;
	}
	if ('LOCALAPPDATA' === upper) {
		return `${home}/AppData/Local`;
	}
	if ('PROGRAMFILES' === upper) {
		return 'C:/Program Files';
	}
	if ('SYSTEMROOT' === upper || 'WINDIR' === upper) {
		return 'C:/Windows';
	}
	return null;
}
function normalizeExpandedPath(raw, preserveTrailingSlash = false) {
	if (!raw) {
		return raw;
	}
	const hadTrailing = raw.endsWith('/') || raw.endsWith('\\');
	const text = raw.replaceAll('\\', '/');
	const isUnc = text.startsWith('//') && !text.startsWith('///');
	const body = isUnc ? text.slice(2) : text;
	let collapsed = (isUnc ? '//' : '') + body.replace(/\/{2,}/g, '/');
	if (!preserveTrailingSlash && collapsed.length > 1 && !/^[A-Za-z]:\/$/.test(collapsed) && '//' !== collapsed) {
		collapsed = collapsed.replace(/\/+$/, '');
	}
	else if (preserveTrailingSlash && hadTrailing && !collapsed.endsWith('/')) {
		collapsed += '/';
	}
	return collapsed;
}
export function expandPathTemplate(raw, vars, {env = process.env, _seen = new Set()} = {}) {
	if ('string' !== typeof raw || (!raw.includes('$') && !raw.includes('%'))) {
		return 'string' === typeof raw ? (0 === _seen.size ? normalizeExpandedPath(raw, false) : raw) : raw;
	}
	const unclosedCheck = raw.replaceAll('$${', '');
	if (unclosedCheck.includes('${') && !/\$\{[^}]*\}/.test(unclosedCheck)) {
		throw Error('TRUST_POLICY: unclosed template variable in ' + raw);
	}
	const expanded = raw.replace(TOKEN_RE, (full, braced, pct) => {
		if ('$${' === full) {
			return ESC_DOLLAR;
		}
		if ('%%' === full) {
			return ESC_PCT;
		}
		if (undefined !== pct) {
			const val = lookupEnv(pct, env);
			if (null === val) {
				throw Error('TRUST_POLICY: unresolved env variable %' + pct + '%');
			}
			return val.replaceAll('${', ESC_DOLLAR).replaceAll('%', ESC_PCT);
		}
		const expr = (braced ?? '').trim();
		if (expr.toUpperCase().startsWith('ENV:')) {
			const envName = expr.slice(4).trim();
			if (!VAR_RE.test(envName)) {
				throw Error('TRUST_POLICY: invalid env variable ${' + braced + '}');
			}
			const val = lookupEnv(envName, env);
			if (null === val) {
				throw Error('TRUST_POLICY: unresolved env variable ${' + braced + '}');
			}
			return val.replaceAll('${', ESC_DOLLAR).replaceAll('%', ESC_PCT);
		}
		if (!VAR_RE.test(expr)) {
			throw Error('TRUST_POLICY: invalid template variable ${' + braced + '}');
		}
		if (_seen.has(expr) || 'string' !== typeof vars?.[expr]) {
			throw Error('TRUST_POLICY: unresolved template variable ${' + expr + '}');
		}
		const next = new Set(_seen);
		next.add(expr);
		return normalizeExpandedPath(expandPathTemplate(vars[expr], vars, {env, _seen: next}), true);
	});
	if (expanded.replaceAll(ESC_DOLLAR, '').includes('${')) {
		throw Error('TRUST_POLICY: malformed template variable in ' + raw);
	}
	if (0 < _seen.size) {
		return expanded;
	}
	const unescaped = expanded.replaceAll(ESC_DOLLAR, '${').replaceAll(ESC_PCT, '%');
	return normalizeExpandedPath(unescaped, false);
}
export async function resolveUpworkRuntime(policyFile, {env = process.env} = {}) {
	const resolvedPolicy = path.resolve(policyFile ?? fileURLToPath(new URL('./trust-policy.json', import.meta.url)));
	const baseDir = path.dirname(resolvedPolicy);
	const policy = JSON.parse((await fs.readFile(resolvedPolicy, 'utf8')).replace(/^\uFEFF/, ''));
	if ('string' !== typeof policy?.upworkRuntime || !policy.upworkRuntime.trim()) {
		throw Error('TRUST_POLICY: missing upworkRuntime');
	}
	let regFile = '';
	const explicitReg = policy.pathsRegistry || env?.HARNESS_PATHS_FILE;
	if (explicitReg) {
		regFile = path.resolve(baseDir, explicitReg);
	}
	else if (policy.upworkRuntime.includes('$') || policy.upworkRuntime.includes('%')) {
		for (let cur = baseDir; ; cur = path.dirname(cur)) {
			const harnessRoot = path.join(cur, 'harness');
			for (const rel of ['\u2c0f/\u227b/\u2655/\u26ef/paths.json', 'Artifacts/\u227b/Deliverables/\u26ef/paths.json', 'code/paths.json']) {
				const cand = path.join(harnessRoot, rel);
				try {
					if ((await fs.stat(cand)).isFile()) {
						regFile = cand;
						break;
					}
				}
				catch {}
			}
			if (regFile || path.dirname(cur) === cur) {
				break;
			}
		}
	}
	let reg = null;
	let vars = {};
	if (regFile) {
		reg = JSON.parse((await fs.readFile(regFile, 'utf8')).replace(/^\uFEFF/, ''));
		vars = reg?.variables ?? {};
	}
	const runtimeRaw = (policy.upworkRuntime.includes('$') || policy.upworkRuntime.includes('%')) ? expandPathTemplate(policy.upworkRuntime, vars, {env}) : policy.upworkRuntime;
	const runtimeFile = path.resolve(baseDir, runtimeRaw);
	const primary = path.dirname(runtimeFile);
	if (!reg) {
		const siblingReg = path.join(primary, 'paths.json');
		try {
			if ((await fs.stat(siblingReg)).isFile()) {
				reg = JSON.parse((await fs.readFile(siblingReg, 'utf8')).replace(/^\uFEFF/, ''));
				vars = reg?.variables ?? {};
			}
		}
		catch {}
	}
	const relocatedPrimaries = [];
	if (reg?.relocations && vars.HARNESS_ROOT) {
		const harnessRootNorm = expandPathTemplate('${HARNESS_ROOT}', vars, {env});
		for (const [oldTpl, newTpl] of Object.entries(reg.relocations)) {
			try {
				const oldExpanded = expandPathTemplate(oldTpl, vars, {env});
				const newExpanded = expandPathTemplate(newTpl, vars, {env});
				if (newExpanded === harnessRootNorm && (oldExpanded.endsWith('/code') || oldExpanded.endsWith('/\u26ef'))) {
					relocatedPrimaries.push(oldExpanded);
				}
			}
			catch {}
		}
	}
	return {runtimeFile, primary, relocatedPrimaries, vars};
}
export class TrustPolicy {
	constructor(file = fileURLToPath(new URL('./trust-policy.json', import.meta.url))) {
		this.file = file;
	}
	async prepare(spec) {
		if (undefined !== spec?.trustPolicy) {
			if ('upwork-daily' !== spec.trustPolicy) {
				throw Error('TRUST_POLICY: unknown trust policy');
			}
			const resolved = await resolveUpworkRuntime(this.file);
			const runtime = JSON.parse(await fs.readFile(resolved.runtimeFile, 'utf8'));
			let vars = resolved.vars;
			if (!Object.keys(vars).length && [runtime.workspace_root, runtime.daily_root].some(v => 'string' === typeof v && (v.includes('${') || v.includes('%')))) {
				const regFile = path.resolve(path.dirname(resolved.runtimeFile), runtime.paths_registry || 'paths.json');
				const reg = JSON.parse(await fs.readFile(regFile, 'utf8'));
				vars = reg?.variables ?? {};
			}
			const workspaceRoot = expandPathTemplate(runtime.workspace_root, vars);
			const dailyRoot = expandPathTemplate(runtime.daily_root, vars);
			if (!path.isAbsolute(workspaceRoot) || !dailyRoot || path.isAbsolute(dailyRoot)) {
				throw Error('TRUST_POLICY: invalid daily directory');
			}
			const daily = path.resolve(workspaceRoot, dailyRoot);
			const relativeDaily = path.relative(workspaceRoot, daily);
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
