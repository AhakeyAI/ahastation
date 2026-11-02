import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ipcMain } from 'electron';
import { listLocalClis, listLocalShells, resolveLocalTerminal } from '../dist-electron/local-cli.js';
import { registerShellPtyIpc } from '../dist-electron/ipc/shell-pty.js';
import { getPtyHost } from '../dist-electron/pty-host.js';

test('local CLI detection uses PATH and preserves native color preferences', async (t) => {
  // Windows CI TEMP may use RUNNER~1 while where.exe returns the long path.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aha-local-cli-')));
  const filename = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  const binary = join(root, filename);
  await writeFile(binary, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
  const previous = Object.fromEntries(['PATH', 'ELECTRON_RUN_AS_NODE', 'NO_COLOR', 'COLORFGBG', 'FORCE_COLOR', 'CLICOLOR']
    .map((key) => [key, process.env[key]]));
  process.env.PATH = `${root}${process.platform === 'win32' ? ';' : ':'}${previous.PATH ?? ''}`;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  process.env.NO_COLOR = '1';
  process.env.COLORFGBG = '15;0';
  process.env.FORCE_COLOR = '0';
  process.env.CLICOLOR = '0';
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const entry = listLocalClis().find((cli) => cli.id === 'codex');
  assert.equal(entry.binaryPath, binary);
  const target = resolveLocalTerminal('codex');
  assert.equal(target.file, binary);
  assert.deepEqual(target.args, [], 'manual launch must not send a task or model prompt');
  assert.equal(target.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(target.env.TERM, 'xterm-256color');
  assert.equal(target.env.COLORTERM, 'truecolor');
  for (const key of ['NO_COLOR', 'COLORFGBG', 'FORCE_COLOR', 'CLICOLOR']) {
    assert.equal(target.env[key], process.env[key], `${key} must remain the user's preference`);
  }
});

test('manual terminal IPC retains the same PTY across reattach and closes only its tab', async (t) => {
  const handlers = new Map();
  t.mock.method(ipcMain, 'handle', (channel, fn) => handlers.set(channel, fn));
  const contents = Object.assign(new EventEmitter(), { id: 7, send() {} });
  const host = getPtyHost();
  const live = new Map();
  let spawnCount = 0;
  t.mock.method(host, 'spawn', (id, opts) => { live.set(id, { opts, output: '', onExit() {} }); spawnCount++; return 123; });
  t.mock.method(host, 'onData', () => () => {});
  t.mock.method(host, 'onExit', (id, cb) => { live.get(id).onExit = cb; return () => {}; });
  t.mock.method(host, 'replayBuffer', (id) => Buffer.from(live.get(id)?.output ?? ''));
  t.mock.method(host, 'kill', (id) => live.delete(id));
  let mainWindow = null;
  registerShellPtyIpc({ liveWindow: () => mainWindow, getCurrentCwd: () => undefined });
  mainWindow = { webContents: contents };
  const call = (name, payload, sender = 7) => handlers.get(`shell-pty:${name}`)({ sender: { id: sender } }, payload);
  assert.equal((await call('create', { terminalId: 'a' }, 8)).ok, false);
  assert.equal((await call('create', { cliId: 'unknown' })).ok, false);
  assert.equal((await call('create', { cliId: 'codex', shellId: 'cmd' })).ok, false);
  const shellList = await call('list-shells', {});
  assert.equal(shellList.ok, true);
  assert.ok(shellList.defaultCwd);
  const selected = shellList.shells.find(shell => shell.id !== 'default') ?? shellList.shells[0];
  const a = await call('create', { terminalId: 'a', shellId: selected.id, cwd: shellList.defaultCwd });
  assert.equal(live.get(a.ptyId).opts.file, selected.binaryPath);
  assert.equal(live.get(a.ptyId).opts.cwd, shellList.defaultCwd);
  const b = await call('create', { terminalId: 'b' });
  assert.equal(a.ok, true);
  assert.notEqual(a.ptyId, b.ptyId);
  live.get(a.ptyId).output = 'first terminal history';
  const reattached = await call('create', { terminalId: 'a' });
  assert.equal(reattached.ptyId, a.ptyId);
  assert.equal(Buffer.from(reattached.replay, 'base64').toString(), 'first terminal history');
  assert.equal(spawnCount, 2);
  live.get(a.ptyId).onExit(0);
  const ended = await call('create', { terminalId: 'a' });
  assert.equal(ended.exited, true);
  assert.equal(ended.exitCode, 0);
  assert.equal(spawnCount, 2, 'an exited tab must not automatically restart its CLI');
  const originalKill = host.kill;
  t.mock.method(host, 'kill', () => { throw new Error('termination failed'); });
  assert.equal((await call('kill', { ptyId: b.ptyId })).ok, false);
  assert.equal((await call('create', { terminalId: 'b' })).ptyId, b.ptyId);
  assert.equal(spawnCount, 2, 'failed close keeps ownership for a retry');
  t.mock.method(host, 'kill', originalKill);
  await call('kill', { ptyId: a.ptyId });
  assert.equal(live.has(a.ptyId), false);
  assert.equal(live.has(b.ptyId), true);
  contents.emit('destroyed');
  assert.equal(live.size, 0);
});

test('each available shell resolves its detected executable without a model task', () => {
  for (const shell of listLocalShells()) {
    const target = resolveLocalTerminal(undefined, shell.id);
    assert.equal(target.file, shell.binaryPath);
    assert.deepEqual(target.args, shell.id === 'git-bash' ? ['--login', '-i'] : []);
  }
});
