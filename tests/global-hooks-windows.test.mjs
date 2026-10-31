import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installGlobalHooks, uninstallGlobalHooks } from '../dist-electron/global-hooks/installer.js';
import { GlobalHookHost } from '../dist-electron/global-hooks/host.js';

const windows = { skip: process.platform !== 'win32' };
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$value = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($value.action -eq 'prepare') {
  [void][IO.Directory]::CreateDirectory($value.configDir)
  $acl = [IO.Directory]::GetAccessControl($value.configDir)
  $users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  [IO.Directory]::SetAccessControl($value.configDir, $acl)
  [IO.File]::WriteAllText($value.path, $value.content, [Text.UTF8Encoding]::new($false))
  $fileAcl = [IO.File]::GetAccessControl($value.path)
  $fileAcl.SetAccessRuleProtection($true, $false)
  $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'Allow'))
  [IO.File]::SetAccessControl($value.path, $fileAcl)
}
if ($value.action -eq 'expose-file') {
  $fileAcl = [IO.File]::GetAccessControl($value.path)
  $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'), 'Read', 'Allow'))
  [IO.File]::SetAccessControl($value.path, $fileAcl)
}
if ([IO.Directory]::Exists($value.path)) { $result = [IO.Directory]::GetAccessControl($value.path) }
else { $result = [IO.File]::GetAccessControl($value.path) }
@{ protected=$result.AreAccessRulesProtected
   owner=$result.GetOwner([Security.Principal.SecurityIdentifier]).Value
   group=$result.GetGroup([Security.Principal.SecurityIdentifier]).Value
   rules=@($result.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {
     @{ sid=$_.IdentityReference.Value; rights=$_.FileSystemRights.ToString(); type=$_.AccessControlType.ToString()
        inherited=$_.IsInherited; inheritance=$_.InheritanceFlags.ToString(); propagation=$_.PropagationFlags.ToString() }
   }) } | ConvertTo-Json -Depth 6 -Compress
`;
function powershell(value) {
  return JSON.parse(childProcess.execFileSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    { input: JSON.stringify(value), encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] }));
}
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'aha85 ACL 中文 '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, 'shared readable config');
  const path = join(configDir, 'settings.json');
  const original = '{"env":{"TOKEN":"fixture-only"}}\r\n';
  const before = powershell({ action: 'prepare', path, configDir, content: original });
  return { root, path, original, before, options: { agent: 'claude', configDir,
    stateDir: join(root, 'private state'), profileId: 'windows-acl', version: 'v1',
    nodePath: process.execPath, relayPath: resolve('dist-electron/global-hooks/relay.js') } };
}
const inspect = path => powershell({ action: 'inspect', path });

test('Windows configuration DACL survives install, upgrade, journal recovery and uninstall', windows, t => {
  const { path, original, before, options } = fixture(t);
  assert.equal(before.protected, true);
  assert.ok(!before.rules.some(rule => rule.sid === 'S-1-5-32-545'));
  assert.equal(installGlobalHooks(options).status, 'installed');
  assert.deepEqual(inspect(path), before);
  const upgrade = { ...options, version: 'v2' };
  assert.equal(installGlobalHooks(upgrade).status, 'upgraded');
  assert.deepEqual(inspect(path), before);
  const originalRename = fs.renameSync;
  fs.renameSync = function(from, to) {
    if (to === path) throw new Error('fixture-interrupted-config-commit');
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => installGlobalHooks({ ...options, version: 'v3' }), /fixture-interrupted/); }
  finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
  assert.ok(fs.existsSync(join(options.stateDir, 'claude.transaction')));
  assert.equal(installGlobalHooks({ ...options, version: 'v3' }).status, 'unchanged');
  assert.deepEqual(inspect(path), before);
  uninstallGlobalHooks(options);
  assert.equal(fs.readFileSync(path, 'utf8'), original);
  assert.deepEqual(inspect(path), before);
});

test('Windows permission helper failure refuses configuration writes and remains recoverable', windows, t => {
  const { path, original, before, options } = fixture(t);
  const originalExec = childProcess.execFileSync;
  childProcess.execFileSync = function(binary, args, execution) {
    if (args.includes('-EncodedCommand') && JSON.parse(execution.input).action === 'stage') {
      throw new Error('fixture-security-provider-unavailable');
    }
    return originalExec.call(this, binary, args, execution);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => installGlobalHooks(options), /windows-file-security-failed/); }
  finally { childProcess.execFileSync = originalExec; syncBuiltinESMExports(); }
  assert.equal(fs.readFileSync(path, 'utf8'), original);
  assert.deepEqual(inspect(path), before);
  assert.equal(fs.existsSync(join(options.stateDir, 'install.lock')), false);
  installGlobalHooks(options); uninstallGlobalHooks(options);
  assert.deepEqual(inspect(path), before);
});

test('Windows key, staged runtime and observation token use a private store; unsafe existing stores are refused', windows, async t => {
  const { root, path, original, options } = fixture(t);
  const args = ['scripts/global-hooks.mjs', 'install', '--agent', 'claude', '--config-dir', options.configDir,
    '--state-dir', options.stateDir, '--profile', options.profileId];
  const installed = childProcess.spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
  assert.equal(installed.status, 0, installed.stderr);
  const storeAcl = inspect(options.stateDir);
  const allowed = new Set([storeAcl.owner, 'S-1-5-18', 'S-1-5-32-544']);
  const runtime = fs.readdirSync(join(options.stateDir, 'runtimes'))[0];
  const endpoint = join(options.stateDir, 'host.json');
  const host = new GlobalHookHost({ endpointPath: endpoint, profileId: options.profileId, deviceId: 'test-device',
    classifyAuthorized: () => null });
  await host.start(); t.after(() => host.stop());
  assert.equal(storeAcl.protected, true);
  for (const file of [join(options.stateDir, 'backup.key'), join(options.stateDir, 'runtimes', runtime, 'relay.js'), endpoint]) {
    const acl = inspect(file);
    assert.equal(acl.owner, storeAcl.owner, 'private files use the current user owner even under an elevated token');
    assert.ok(acl.rules.every(rule => rule.type !== 'Allow' || allowed.has(rule.sid)));
  }
  await host.stop();
  assert.equal(childProcess.spawnSync(process.execPath, args.map(value => value === 'install' ? 'uninstall' : value),
    { encoding: 'utf8', windowsHide: true }).status, 0);
  assert.equal(fs.readFileSync(path, 'utf8'), original);
  const unsafe = join(root, 'unsafe-store'); fs.mkdirSync(unsafe);
  const acl = inspect(unsafe);
  assert.throws(() => installGlobalHooks({ ...options, stateDir: unsafe }), /windows-file-security-failed/);
  assert.deepEqual(inspect(unsafe), acl);
  assert.equal(fs.readFileSync(path, 'utf8'), original);
  assert.equal(fs.existsSync(join(unsafe, 'backup.key')), false);
  const key = join(options.stateDir, 'backup.key');
  powershell({ action: 'expose-file', path: key });
  assert.throws(() => installGlobalHooks(options), /windows-file-security-failed/);
  assert.equal(fs.readFileSync(path, 'utf8'), original);
});
