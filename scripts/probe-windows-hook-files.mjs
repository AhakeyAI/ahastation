// Self-owned fixtures only: no personal configuration, CLI login or PTY.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertPrivateHookFile, createPrivateHookFile, ensurePrivateHookDirectory } from '../dist-electron/global-hooks/file-security.js';
import { resolveBinaryFromPath } from '../dist-electron/backends/subprocess-backend.js';
if (process.platform !== 'win32') throw new Error('windows-probe-only');
const parent = realpathSync(tmpdir());
const root = mkdtempSync(join(parent, 'aha85-native-files 中文 '));
const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$v=[Console]::In.ReadToEnd()|ConvertFrom-Json
$token=[Security.Principal.WindowsIdentity]::GetCurrent()
$raw=[IO.File]::GetAccessControl($v.raw)
$created=[IO.File]::GetAccessControl($v.created)
$allowed=@($token.User.Value,'S-1-5-18','S-1-5-32-544')
$other=@($raw.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $allowed})
@{tokenDefaultOwnerIsUser=($token.Owner.Value -eq $token.User.Value)
 tokenDefaultOwnerIsAdministrators=($token.Owner.Value -eq 'S-1-5-32-544')
 rawOwnerIsUser=($raw.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $token.User.Value)
 rawOwnerIsAdministrators=($raw.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-32-544')
 rawDaclHasOnlyAllowedPrincipals=($other.Count -eq 0)
 createdOwnerIsUser=($created.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $token.User.Value)
}|ConvertTo-Json -Compress
`;
try {
  const store = join(root, 'private'); ensurePrivateHookDirectory(store);
  const raw = join(store, 'native-default.key'), created = join(store, 'explicit-private.key');
  writeFileSync(raw, 'fixture-only', { flag: 'wx', mode: 0o600 });
  let baseline = 'accepted';
  try { assertPrivateHookFile(raw); } catch (error) { baseline = error.message; }
  createPrivateHookFile(created, 'fixture-only'); assertPrivateHookFile(created);
  const ownership = JSON.parse(execFileSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { input: JSON.stringify({ raw, created }), encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }));
  assert.equal(ownership.createdOwnerIsUser, true);
  assert.equal(ownership.rawDaclHasOnlyAllowedPrincipals, true);
  if (!ownership.rawOwnerIsUser) assert.equal(baseline, 'windows-file-security-failed');
  assert.equal(readFileSync(raw, 'utf8'), 'fixture-only');

  const name = 'aha85-encoding-fixture', launcher = join(root, `${name}.cmd`);
  writeFileSync(join(root, name), '#!/bin/sh\n'); writeFileSync(launcher, '@echo off\r\n');
  const previousPath = process.env.PATH;
  let bytes, resolved;
  try {
    process.env.PATH = `${root};${previousPath ?? ''}`;
    bytes = execFileSync('where.exe', [name], { windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    resolved = resolveBinaryFromPath(name);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  }
  assert.equal(resolved, launcher);
  process.stdout.write(JSON.stringify({ ownership, originalPrivateValidation: baseline,
    whereExitCode: 0, whereStdoutHex: bytes.toString('hex'),
    whereUtf8ContainsExactLauncher: bytes.toString('utf8').split(/\r?\n/).includes(launcher),
    nativeResolverFindsExactLauncher: true, personalCliExecuted: false, visiblePtyCreated: false }, null, 2) + '\n');
} finally {
  if (!root.startsWith(parent + sep + 'aha85-native-files ')) throw new Error('unexpected-probe-directory');
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
