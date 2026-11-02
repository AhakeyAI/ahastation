import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const execute = promisify(execFile);
test('startup rejects connections before security setup and releases the endpoint on ACL failure', {
  timeout: 20_000,
}, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aha acl gate 中文 '));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await execute(process.execPath, [resolve('tests/fixtures/terminal-daemon-security.mjs'), dataDir], {
    windowsHide: true, timeout: 15_000,
  });
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'result.json'), 'utf8')), {
    preReadyRejected: true, aclFailureClosed: true,
  });
});

test('PowerShell constrained language rejects the ACL helper rather than bypassing it', {
  skip: process.platform !== 'win32', timeout: 15_000,
}, async () => {
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const helper = resolve('electron/terminal-daemon/windows-pipe-acl.ps1').replaceAll("'", "''");
  await assert.rejects(execute(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; & '${helper}' -PipeName '\\\\.\\pipe\\aha-unavailable-test'`,
  ], { windowsHide: true, timeout: 10_000 }), error => error.code !== 0 && /Add-Type/.test(error.stderr));
});
