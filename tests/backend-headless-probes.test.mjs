import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CodexBackend } from '../dist-electron/backends/codex-adapter.js';
import { ClaudeCodeBackend } from '../dist-electron/backends/claude-code-adapter.js';
import { resolveBinaryFromPath } from '../dist-electron/backends/subprocess-backend.js';
import { removeBackendAuth } from '../dist-electron/store.js';

test('background discovery and default auth probes hide console windows without launching personal CLIs', async () => {
  const original = childProcess.execFileSync;
  const calls = [];
  childProcess.execFileSync = (file, args, options) => {
    calls.push({ file, args, options });
    if (args.includes('prefix')) return dirname(process.execPath);
    if (args[0] === 'auth') return '{"loggedIn":true}';
    if (args[0] === 'login') return ''; // Codex success is its exit status
    return process.execPath;
  };
  syncBuiltinESMExports();
  try {
    await removeBackendAuth('codex');
    assert.deepEqual(await new CodexBackend({ resolveBinary: () => '/fixture/codex' }).checkAuthStatus(), { loggedIn: true });
    assert.deepEqual(await new ClaudeCodeBackend({ resolveBinary: () => '/fixture/claude' }).checkAuthStatus(), { loggedIn: true });
    assert.equal(resolveBinaryFromPath('node'), process.execPath);
    assert.ok(calls.some(call => call.args[0] === 'login'));
    assert.ok(calls.some(call => call.args[0] === 'auth'));
    if (process.platform !== 'win32') assert.ok(calls.some(call => call.file === 'which'));
    assert.ok(calls.every(call => call.options.windowsHide === true));
  } finally {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
  }
});

test('Windows resolver finds a Unicode npm launcher without running it or decoding where output', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'aha85 resolver 中文 '));
  const previousPath = process.env.PATH;
  const launcher = join(root, 'aha85-offline.cmd');
  mkdirSync(join(root, 'aha85-offline.exe')); // a directory cannot mask the launcher
  writeFileSync(join(root, 'aha85-offline'), '#!/bin/sh\n');
  writeFileSync(launcher, '@echo off\r\n');
  process.env.PATH = `${root};${previousPath ?? ''}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(resolveBinaryFromPath('aha85-offline'), launcher);
});
