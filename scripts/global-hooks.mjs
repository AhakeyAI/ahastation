#!/usr/bin/env node
// Explicit command only; never run from postinstall or application startup.
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGlobalHooks, uninstallGlobalHooks } from '../dist-electron/global-hooks/installer.js';
import { assertPrivateHookFile, createPrivateHookFile, ensurePrivateHookDirectory } from '../dist-electron/global-hooks/file-security.js';

const [action, ...args] = process.argv.slice(2);
const values = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith('--') || !args[i + 1] || values.has(args[i])) throw new Error('invalid-arguments');
  values.set(args[i], args[i + 1]);
}
const get = name => {
  const value = values.get(`--${name}`);
  if (!value) throw new Error(`required: --${name}`);
  return value;
};
try {
  if (action !== 'install' && action !== 'uninstall') throw new Error('usage: global-hooks.mjs install|uninstall --agent claude|codex --config-dir ABS --state-dir ABS --profile ID [--codex-binary ABS]');
  const agent = get('agent');
  const configDir = get('config-dir');
  const stateDir = get('state-dir');
  const profileId = get('profile');
  if (!isAbsolute(stateDir) || !isAbsolute(configDir)) throw new Error('absolute-roots-required');
  for (let p = resolve(stateDir); ; p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('symlink-runtime-path');
    if (dirname(p) === p) break;
  }
  // Immutable standalone copy: survives build output cleanup and app upgrades.
  const source = fileURLToPath(new URL('../dist-electron/global-hooks/', import.meta.url));
  // Recovery/uninstall must work even if a later build lost its relay files.
  const files = action === 'install'
    ? ['relay.js', 'protocol.js'].map(name => [name, readFileSync(join(source, name))]) : [];
  const version = action === 'install'
    ? `v1-${createHash('sha256').update(Buffer.concat(files.map(([, data]) => data))).digest('hex').slice(0, 24)}`
    : 'uninstall';
  const runtime = resolve(stateDir, 'runtimes', version);
  if (action === 'install') {
    ensurePrivateHookDirectory(resolve(stateDir));
    for (let p = runtime; ; p = dirname(p)) {
      if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('symlink-runtime-path');
      if (dirname(p) === p) break;
    }
    ensurePrivateHookDirectory(dirname(runtime));
    ensurePrivateHookDirectory(runtime);
    for (const [name, data] of [...files, ['package.json', Buffer.from('{"type":"module"}\n')]]) {
      const target = join(runtime, name);
      if (existsSync(target)) {
        if (lstatSync(target).isSymbolicLink()) throw new Error('symlink-runtime-path');
        assertPrivateHookFile(target);
        if (!readFileSync(target).equals(data)) throw new Error('installed-runtime-modified');
      } else createPrivateHookFile(target, data);
    }
  }
  const options = { agent, configDir, stateDir, profileId, version,
    nodePath: process.execPath, relayPath: join(runtime, 'relay.js'), codexBinary: values.get('--codex-binary') };
  const result = action === 'install' ? installGlobalHooks(options) : uninstallGlobalHooks(options);
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  // No stack/config dump: config or subprocess errors can contain credentials.
  const message = error instanceof Error ? error.message : 'installation-failed';
  const safe = /^[a-z][a-z0-9-]+(?:: [^\r\n]{0,180})?$/.test(message) ? message : 'installation-failed; inspect config format, locks and CLI capability locally';
  process.stderr.write(safe + '\n'); process.exitCode = 1;
}
