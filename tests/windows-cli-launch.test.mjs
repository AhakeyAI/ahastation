import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveBinaryFromPath } from '../dist-electron/backends/subprocess-backend.js';

const execute = promisify(execFile);

test('Windows npm launcher resolves past the Unix shim and preserves PTY arguments', {
  skip: process.platform !== 'win32',
  timeout: 15_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aha CLI 中文 '));
  const name = 'aha-offline-launch';
  const launcher = join(root, `${name}.cmd`);
  const capture = join(root, 'capture.cjs');
  const result = join(root, 'argv.json');
  await writeFile(join(root, name), '#!/bin/sh\nexit 1\n');
  await writeFile(capture, `require('node:fs').writeFileSync(process.env.AHA_TEST_ARGV, JSON.stringify(process.argv.slice(2)));`);
  await writeFile(launcher, `@echo off\r\n"${process.execPath}" "${capture}" %*\r\n`);
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
  import { TerminalCliSession } from ${JSON.stringify(new URL('../dist-electron/backends/terminal-cli-adapter.js', import.meta.url).href)};
  import { PtyHost } from ${JSON.stringify(new URL('../dist-electron/pty-host.js', import.meta.url).href)};
  const binary = process.env.AHA_TEST_BINARY;
  const host = new PtyHost();
  const session = new TerminalCliSession({
    id: 'offline-terminal', capabilities: {}, displayLabel: 'Offline',
    resolveBinary: () => binary, buildCliArgs: () => JSON.parse(process.env.AHA_TEST_ARGS),
    startupMessage: 'Offline startup check', missingBinaryMessage: 'Missing launcher',
  }, { cwd: process.env.AHA_TEST_CWD, env: process.env, extra: { workerId: 'windows-launch' } },
  () => {},
  { host, resolveBinary: () => binary, timersEnabled: false });
  await session.start();
  host.onData('windows-launch', (data) => process.stdout.write(data));
  host.onExit('windows-launch', (code) => process.exit(code ?? 1));
  setTimeout(() => { session.end(); process.exit(2); }, 8000).unref();
  `;
  const runner = join(root, 'check.mjs');
  await writeFile(runner, source);
  const loader = `data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));`;
  await execute(process.execPath, ['--import', loader, runner], {
    env: { ...process.env, AHA_TEST_BINARY: binary, AHA_TEST_ARGS: JSON.stringify(args), AHA_TEST_CWD: root, AHA_TEST_ARGV: result },
    windowsHide: true, timeout: 10_000,
  });
  assert.deepEqual(JSON.parse(await readFile(result, 'utf8')), args);
});
