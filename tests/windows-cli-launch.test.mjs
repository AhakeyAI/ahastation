import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  await writeFile(capture, `if (process.env.TERM !== 'xterm-256color') process.exit(73);
require('node:fs').writeFileSync(process.env.AHA_TEST_ARGV, JSON.stringify(process.argv.slice(2)));`);
  // Keep the shim ASCII-only; cmd decodes batch literals using its code page.
  await writeFile(launcher, `@echo off\r\nchcp ${codepage} >nul\r\n"node" "%~dp0capture.cjs" %*\r\n`);
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
  import { TerminalCliSession } from ${JSON.stringify(new URL('../dist-electron/backends/terminal-cli-adapter.js', import.meta.url).href)};
  import { CodexTerminalBackend } from ${JSON.stringify(new URL('../dist-electron/backends/codex-terminal-adapter.js', import.meta.url).href)};
  const binary = process.env.AHA_TEST_BINARY;
  const host = new PtyHost();
  const env = new CodexTerminalBackend().buildEnv({ authMode: 'none' }, {
    AHA_TEST_ARGV: process.env.AHA_TEST_ARGV,
    TERM: 'dumb',
  });
  const session = new TerminalCliSession({
    id: 'fixture-terminal', displayLabel: 'Fixture', startupMessage: 'fixture started',
    buildCliArgs: () => JSON.parse(process.env.AHA_TEST_ARGS),
  }, { cwd: process.env.AHA_TEST_CWD, env, executionRole: 'host' },
  () => {}, { host, resolveBinary: () => binary });
  await session.start();
  host.onData(session.workerId, (data) => process.stdout.write(data));
  host.onExit(session.workerId, (code) => process.exit(code ?? 1));
  setTimeout(() => { host.killAll(); process.exit(2); }, 8000).unref();
  `;
  const runner = join(root, 'check.mjs');
  await writeFile(runner, source);
  const loader = `data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));`;
  // Exercise the mixed-case spelling passed to an Electron app by Windows.
  const runnerEnv = { ...process.env };
  for (const key of Object.keys(runnerEnv)) {
    if (key.toLowerCase() === 'path') delete runnerEnv[key];
  }
  await execute(process.execPath, ['--import', loader, runner], {
    env: {
      ...runnerEnv,
      Path: `${dirname(process.execPath)};${process.env.PATH}`,
      HOME: root,
      USERPROFILE: root,
      AHA_TEST_BINARY: binary,
      AHA_TEST_ARGS: JSON.stringify(args),
      AHA_TEST_CWD: root,
      AHA_TEST_ARGV: result,
    },
    windowsHide: true, timeout: 10_000,
  }).catch(error => {
    error.message += `\nPTY stdout:\n${error.stdout ?? ''}\nChild stderr:\n${error.stderr ?? ''}`;
    throw error;
  });
  assert.deepEqual(JSON.parse(await readFile(result, 'utf8')), args);
});
