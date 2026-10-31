import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOOK_EVENTS, type HookAgent } from './protocol.js';
import { assertPrivateHookFile, createPrivateHookFile, ensurePrivateHookDirectory, stageWindowsConfig } from './file-security.js';

type JsonObject = Record<string, any>;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const read = (p: string): string | null => {
  if (!existsSync(p)) return null;
  const bytes = readFileSync(p);
  try {
    // Replacement decoding would lose the original bytes before backup.
    // Preserve a UTF-8 BOM; parseConfig handles it without discarding it
    // from the exact original stored for uninstall.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch { throw new Error('invalid-utf8-hook-file'); }
};

/** JSON only, with duplicate keys rejected. JSON.parse alone would silently
 * discard a user's duplicate setting when serializing an otherwise valid file. */
export function parseConfig(raw: string): JsonObject {
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error('config-size-limit');
  try { JSON.parse(raw.replace(/^\uFEFF/, '')); } // validate grammar before token walk
  catch { throw new Error('invalid-json-config'); } // never include a config excerpt in diagnostics
  const tokens = raw.replace(/^\uFEFF/, '').match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)!;
  let at = 0;
  const value = (): unknown => {
    const token = tokens[at++];
    if (token === '{') {
      const result: JsonObject = Object.create(null);
      if (tokens[at] === '}') { at++; return result; }
      while (true) {
        const key = JSON.parse(tokens[at++]) as string;
        if (Object.hasOwn(result, key)) throw new Error('duplicate-json-key');
        at++; result[key] = value();
        if (tokens[at++] === '}') return result;
      }
    }
    if (token === '[') {
      const result: unknown[] = [];
      if (tokens[at] === ']') { at++; return result; }
      while (true) { result.push(value()); if (tokens[at++] === ']') return result; }
    }
    return JSON.parse(token);
  };
  const result = value();
  if (!object(result)) throw new Error('config-must-be-object');
  if (Object.hasOwn(result, 'hooks') && !object(result.hooks)) throw new Error('hooks-must-be-object');
  if (result.hooks) for (const event of HOOK_EVENTS) {
    if (Object.hasOwn(result.hooks, event) && (!Array.isArray(result.hooks[event])
      || !result.hooks[event].every((g: unknown) => object(g) && Array.isArray(g.hooks)))) {
      throw new Error('invalid-hook-groups');
    }
  }
  return result;
}

function checkPath(path: string): void {
  for (let p = resolve(path); ; p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('symlink-config-path');
    if (dirname(p) === p) break;
  }
}
function atomic(path: string, content: string | null, config = false): void {
  if (content === null) { if (existsSync(path)) unlinkSync(path); return; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const before = config ? read(path) : null;
  try {
    if (config && process.platform === 'win32') stageWindowsConfig(temp, path, content);
    else if (process.platform === 'win32') createPrivateHookFile(temp, content);
    else {
      const fd = openSync(temp, 'wx', existsSync(path) ? lstatSync(path).mode & 0o777 : 0o600);
      try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    }
    if (config && read(path) !== before) throw new Error('concurrent-config-write');
    renameSync(temp, path);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
function seal(text: string | null, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(text), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
function unseal(data: string, key: Buffer): string | null {
  const bytes = Buffer.from(data, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
}

interface Manifest {
  schemaVersion: 1; profileId: string; agent: HookAgent; configPath: string;
  version: string; original: string; installedHash: string; groups: Record<string, JsonObject>;
}
export interface HookInstallOptions {
  /** Explicit roots: never inferred from the process HOME. One CLI at a time. */
  agent: HookAgent; configDir: string; stateDir: string; profileId: string;
  nodePath: string; relayPath: string; version: string;
  /** Real pinned binary; no caller-supplied `hooksEnabled=true` assertion. */
  codexBinary?: string;
}

export function probeCodexHooks(binary: string, configDir: string) {
  const options = { env: { ...process.env, CODEX_HOME: configDir }, encoding: 'utf8' as const,
    timeout: 5000, windowsHide: true, maxBuffer: 512 * 1024, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  let version: string, features: string;
  try {
    version = execFileSync(binary, ['--version'], options).trim();
    features = execFileSync(binary, ['features', 'list'], options);
  } catch { throw new Error('codex-hook-probe-failed'); }
  if (version !== 'codex-cli 0.156.1') throw new Error('unsupported-codex-hook-version');
  const match = features.match(/^hooks\s+stable\s+(true|false)\s*$/m);
  if (!match || match[1] !== 'true') throw new Error('codex-hooks-disabled: review [features].hooks and requirements; config.toml was not changed');
  return { version: '0.156.1', feature: 'hooks', enabled: true, trust: 'requires-user-review' };
}

// Both target versions use a shell command string. Refuse expansion/control
// characters rather than interpolating an arbitrary path into that shell.
function quoted(path: string): string {
  if (!isAbsolute(path) || /["'`$%\r\n\x00]/.test(path)) throw new Error('unsupported-hook-command-path');
  return `"${path.replaceAll('\\', '/')}"`;
}
function groups(options: HookInstallOptions): Record<string, JsonObject> {
  const base = `${quoted(options.nodePath)} ${quoted(options.relayPath)} ${options.agent} ${quoted(join(options.stateDir, 'host.json'))} observe`;
  return Object.fromEntries(HOOK_EVENTS.map(event => [event, {
    matcher: options.agent === 'claude' ? '*' : '.*',
    hooks: [{ type: 'command', command: `${base} ${event} --aha-studio-global-hooks-v1`, timeout: 2 }],
  }]));
}

function validateOptions(options: HookInstallOptions): void {
  if (!['claude', 'codex'].includes(options.agent) || !options.profileId.trim()
    || !/^[a-zA-Z0-9._-]{1,80}$/.test(options.version)
    || !isAbsolute(options.configDir) || !isAbsolute(options.stateDir)) throw new Error('invalid-hook-install-options');
}

function withExclusiveLock<T>(path: string, action: () => T): T {
  const fd = openSync(path, 'wx', 0o600);
  try { return action(); }
  finally { closeSync(fd); unlinkSync(path); }
}

/** No raw backup or config text leaves this module. Diagnostics are codes. */
function withStore<T>(options: HookInstallOptions, action: (context: {
  configPath: string; manifestPath: string; key: Buffer;
  transact: (before: string | null, after: string | null, manifest: Manifest | null) => void;
}) => T): T {
  validateOptions(options);
  const configPath = join(resolve(options.configDir), options.agent === 'claude' ? 'settings.json' : 'hooks.json');
  const stateDir = resolve(options.stateDir);
  checkPath(configPath); checkPath(stateDir);
  ensurePrivateHookDirectory(stateDir);
  const storeLock = join(stateDir, 'install.lock');
  checkPath(storeLock);
  // Per-config lock also excludes another profile choosing a different stateDir.
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const lock = `${configPath}.aha-studio.lock`;
  // The key, manifests and recovery journals are shared even when config
  // paths differ. Always acquire the common store lock before the config lock.
  return withExclusiveLock(storeLock, () => withExclusiveLock(lock, () => {
    const ownerPath = `${configPath}.aha-studio-owner.json`;
    const owner = read(ownerPath);
    if (owner && !same(JSON.parse(owner), { stateDir, profileId: options.profileId })) throw new Error('global-hooks-owned-by-another-profile');
    const keyPath = join(stateDir, 'backup.key');
    checkPath(keyPath);
    if (!existsSync(keyPath)) createPrivateHookFile(keyPath, randomBytes(32));
    else assertPrivateHookFile(keyPath);
    const key = readFileSync(keyPath);
    const manifestPath = join(stateDir, `${options.agent}.json`);
    const journalPath = join(stateDir, `${options.agent}.transaction`);
    for (const p of [ownerPath, manifestPath, journalPath]) checkPath(p);
    for (const p of [manifestPath, journalPath]) if (existsSync(p)) assertPrivateHookFile(p);
    // Recovery never overwrites an external edit. It either completes a
    // durable transaction or refuses and leaves encrypted evidence in place.
    const journal = read(journalPath);
    if (journal) {
      const tx = JSON.parse(unseal(journal, key)!);
      if (tx.configPath !== configPath || tx.profileId !== options.profileId) throw new Error('transaction-owner-mismatch');
      const current = read(configPath);
      if (current !== tx.before && current !== tx.after) throw new Error('transaction-conflict-manual-recovery-required');
      atomic(configPath, tx.after, true);
      atomic(manifestPath, tx.manifest);
      atomic(ownerPath, tx.manifest ? JSON.stringify({ stateDir, profileId: options.profileId }) : null);
      unlinkSync(journalPath);
    }
    const transact = (before: string | null, after: string | null, manifest: Manifest | null) => {
      if (read(configPath) !== before) throw new Error('concurrent-config-write');
      const priorManifest = read(manifestPath);
      const priorOwner = read(ownerPath);
      const backupPath = join(stateDir, 'backups', `${options.agent}-${Date.now()}-${randomUUID()}.enc`);
      checkPath(backupPath);
      ensurePrivateHookDirectory(dirname(backupPath));
      atomic(backupPath, seal(JSON.stringify({ configPath, before, priorManifest, priorOwner,
        nextVersion: manifest?.version ?? null }), key));
      const tx = { configPath, profileId: options.profileId, before, after,
        manifest: manifest ? JSON.stringify(manifest) : null };
      atomic(journalPath, seal(JSON.stringify(tx), key));
      // Recheck after journaling; editors do not respect our advisory lock.
      if (read(configPath) !== before) { unlinkSync(journalPath); throw new Error('concurrent-config-write'); }
      try {
        atomic(configPath, after, true);
        atomic(manifestPath, tx.manifest);
        atomic(ownerPath, manifest ? JSON.stringify({ stateDir, profileId: options.profileId }) : null);
        unlinkSync(journalPath);
      } catch (error) {
        // Ordinary I/O failure: restore immediately if no editor intervened.
        // A process/power crash is handled by the encrypted journal on retry.
        if (read(configPath) === after) {
          try {
            atomic(configPath, before, true); atomic(manifestPath, priorManifest); atomic(ownerPath, priorOwner);
            unlinkSync(journalPath);
          } catch { /* Keep the journal; never erase recovery evidence. */ }
        }
        throw error;
      }
    };
    return action({ configPath, manifestPath, key, transact });
  }));
}

function loadManifest(path: string, options: HookInstallOptions, configPath: string): Manifest | null {
  const raw = read(path);
  if (!raw) return null;
  const m = JSON.parse(raw) as Manifest;
  if (m.schemaVersion !== 1 || m.profileId !== options.profileId || m.agent !== options.agent
    || m.configPath !== configPath || !object(m.groups)) throw new Error('invalid-install-manifest');
  return m;
}

function removeOwned(config: JsonObject, manifest: Manifest): string[] {
  const retained: string[] = [];
  for (const [event, owned] of Object.entries(manifest.groups)) {
    if (!Array.isArray(config.hooks?.[event])) continue;
    config.hooks[event] = config.hooks[event].flatMap((group: JsonObject) => {
      if (same(group, owned)) return [];
      // A user may append their own hook to our group. Remove just our exact
      // command; changed matcher/command is user content and is preserved.
      if (group.matcher === owned.matcher && Array.isArray(group.hooks)) {
        const hooks = group.hooks.filter((h: unknown) => !owned.hooks.some((o: unknown) => same(h, o)));
        if (hooks.length !== group.hooks.length) return hooks.length ? [{ ...group, hooks }] : [];
      }
      if (JSON.stringify(group).includes('--aha-studio-global-hooks-v1')) retained.push(event);
      return [group];
    });
    if (config.hooks[event].length === 0) delete config.hooks[event];
  }
  if (config.hooks && Object.keys(config.hooks).length === 0) delete config.hooks;
  return retained;
}

export function installGlobalHooks(options: HookInstallOptions) {
  quoted(options.nodePath); quoted(options.relayPath);
  if (!existsSync(options.nodePath) || !existsSync(options.relayPath)) throw new Error('hook-runtime-missing');
  const capability = options.agent === 'codex'
    ? probeCodexHooks(options.codexBinary ?? '', options.configDir)
    : { expectedVersion: '2.1.150', activation: 'not-probed', controlledWorkers: false };
  return withStore(options, ({ configPath, manifestPath, key, transact }) => {
    const before = read(configPath);
    const config = parseConfig(before ?? '{}');
    if (options.agent === 'claude' && config.disableAllHooks === true) throw new Error('claude-hooks-disabled');
    const old = loadManifest(manifestPath, options, configPath);
    const added = groups(options);
    if (old && old.version === options.version && same(old.groups, added)
      && HOOK_EVENTS.every(event => config.hooks?.[event]?.some((g: unknown) => same(g, added[event])))) {
      return { status: 'unchanged', capability, controlledWorkers: false };
    }
    if (old) {
      if (!HOOK_EVENTS.every(event => config.hooks?.[event]?.some((g: unknown) => same(g, old.groups[event])))) {
        throw new Error('owned-hook-edited: preserve edits; uninstall before reinstall');
      }
      removeOwned(config, old);
    } else if (JSON.stringify(config).includes('--aha-studio-global-hooks-v1')) {
      throw new Error('untracked-hook-marker-manual-review-required');
    }
    // Upgrade must carry forward edits made AFTER the initial installation.
    const original = old && hash(before ?? '') !== old.installedHash
      ? seal(JSON.stringify(config, null, 2) + '\n', key) : old?.original ?? seal(before, key);
    config.hooks ??= {};
    for (const event of HOOK_EVENTS) {
      config.hooks[event] ??= [];
      config.hooks[event].push(added[event]);
    }
    const after = JSON.stringify(config, null, 2) + '\n';
    transact(before, after, { schemaVersion: 1, profileId: options.profileId, agent: options.agent,
      configPath, version: options.version, original,
      installedHash: hash(after), groups: added });
    return { status: old ? 'upgraded' : 'installed', capability, controlledWorkers: false };
  });
}

export function uninstallGlobalHooks(options: HookInstallOptions) {
  validateOptions(options);
  if (existsSync(join(options.stateDir, 'install.lock'))) throw new Error('global-hooks-store-busy');
  if (!existsSync(join(options.stateDir, `${options.agent}.json`))
    && !existsSync(join(options.stateDir, `${options.agent}.transaction`))) {
    const configPath = join(options.configDir, options.agent === 'claude' ? 'settings.json' : 'hooks.json');
    if (existsSync(`${configPath}.aha-studio-owner.json`)) throw new Error('missing-install-manifest');
    return { status: 'absent', retainedEdits: [] };
  }
  return withStore(options, ({ configPath, manifestPath, key, transact }) => {
    const manifest = loadManifest(manifestPath, options, configPath);
    if (!manifest) return { status: 'absent', retainedEdits: [] };
    const before = read(configPath);
    if (before === null) { transact(null, null, null); return { status: 'removed', retainedEdits: [] }; }
    // Corrupt user config is never "repaired" using an old backup.
    const config = parseConfig(before);
    const retainedEdits = removeOwned(config, manifest);
    const after = hash(before) === manifest.installedHash ? unseal(manifest.original, key)
      : JSON.stringify(config, null, 2) + '\n';
    transact(before, after, null);
    return { status: 'removed', retainedEdits };
  });
}
