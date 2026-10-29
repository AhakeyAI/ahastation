import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveBinaryFromPath } from '../dist-electron/backends/subprocess-backend.js';

const execute = promisify(execFile);

for (const codepage of [437, 65001]) test(`Windows npm launcher preserves PTY arguments with code page ${codepage}`, {
  skip: process.platform !== 'win32',
  timeout: 15_000,
}, async (t) => {
  // Windows CI TEMP may use RUNNER~1 while where.exe returns the long path.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aha CLI 中文 ')));
  const name = 'aha-offline-launch';
  const launcher = join(root, `${name}.cmd`);
  const capture = join(root, 'capture.cjs');
  const result = join(root, 'argv.json');
  await writeFile(join(root, name), '#!/bin/sh\nexit 1\n');
  await writeFile(capture, `require('node:fs').writeFileSync(process.env.AHA_TEST_ARGV, JSON.stringify(process.argv.slice(2)));`);
  // Keep the shim ASCII-only; cmd decodes batch literals using its code page.
  await writeFile(launcher, `@echo off\r\nchcp ${codepage} >nul\r\n"%AHA_TEST_NODE%" "%~dp0capture.cjs" %*\r\n`);
  const previousPath = process.env.PATH;
  process.env.PATH = `${root};${previousPath ?? ''}`;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const binary = resolveBinaryFromPath(name);
  assert.equal(binary, launcher, 'ConPTY cannot execute the extensionless npm Shell script');
  const args = ['-c', 'hooks.Stop=[{command="C:\\Program Files\\hook.cjs"}]', '-w', root];
  // Isolate native ConPTY threads so a startup failure cannot crash or keep
  // the test runner alive after the child command exits.
  const source = `
  import { PtyHost } from ${JSON.stringify(new URL('../dist-electron/pty-host.js', import.meta.url).href)};
  const binary = process.env.AHA_TEST_BINARY;
  const host = new PtyHost();
  host.spawn('windows-launch', { file: binary, args: JSON.parse(process.env.AHA_TEST_ARGS),
    cwd: process.env.AHA_TEST_CWD, env: process.env });
  host.onData('windows-launch', (data) => process.stdout.write(data));
  host.onExit('windows-launch', (code) => process.exit(code ?? 1));
  setTimeout(() => { host.killAll(); process.exit(2); }, 8000).unref();
  `;
  const runner = join(root, 'check.mjs');
  await writeFile(runner, source);
  const loader = `data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));`;
  await execute(process.execPath, ['--import', loader, runner], {
    env: { ...process.env, AHA_TEST_NODE: process.execPath, AHA_TEST_BINARY: binary, AHA_TEST_ARGS: JSON.stringify(args), AHA_TEST_CWD: root, AHA_TEST_ARGV: result },
    windowsHide: true, timeout: 10_000,
  }).catch(error => {
    error.message += `\nPTY stdout:\n${error.stdout ?? ''}\nChild stderr:\n${error.stderr ?? ''}`;
    throw error;
  });
  assert.deepEqual(JSON.parse(await readFile(result, 'utf8')), args);
});
