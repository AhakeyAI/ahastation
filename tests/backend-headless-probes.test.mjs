import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
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
    assert.ok(calls.some(call => ['where', 'which'].includes(call.file)));
    assert.ok(calls.every(call => call.options.windowsHide === true));
  } finally {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
  }
});
