import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { ipcMain } from './electron-stub-impl.mjs';
import { getBackendRegistry } from '../dist-electron/backends/registry.js';
import { registerBackendAuthIpc } from '../dist-electron/ipc/backend-auth.js';

test('Windows backend refresh never launches Qoder, but an explicit status check still works', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const registry = getBackendRegistry();
  const previous = registry.list();
  for (const backend of previous) registry.unregister(backend.id);
  const handlers = new Map();
  const execs = [];
  let checks = 0;
  const capabilities = { displayName: 'Fixture', iconId: 'qoder', executeTasks: false };
  registry.register({
    id: 'qoder', capabilities, resolveBinary: () => 'C:\\fixture\\qodercli.js',
    async checkAuthStatus() { checks++; return { loggedIn: true }; },
  });
  registry.register({
    id: 'qoder-terminal', capabilities, resolveBinary: () => 'C:\\fixture\\qodercli.cmd',
  });
  t.mock.method(ipcMain, 'handle', (channel, handler) => handlers.set(channel, handler));
  t.mock.method(childProcess, 'execFile', (file, args, _options, callback) => {
    execs.push([file, ...args]);
    callback(null, '0.0.1');
  });
  t.mock.method(childProcess, 'execFileSync', () => { throw new Error('isolated test'); });
  syncBuiltinESMExports();
  t.after(() => {
    registry.unregister('qoder');
    registry.unregister('qoder-terminal');
    for (const backend of previous) registry.register(backend);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  registerBackendAuthIpc();
  const list = handlers.get('backend-auth:list');
  const [initial] = await list();
  assert.equal(initial.authCheckDeferred, true);
  assert.equal(initial.loggedIn, false);
  assert.equal(checks, 0);
  assert.ok(execs.every(args => !args.some(arg => arg.includes('qodercli'))));

  const check = handlers.get('backend-auth:check-status');
  assert.deepEqual(await check(null, 'qoder'), { ok: true, loggedIn: true });
  const [afterCheck] = await list();
  assert.equal(afterCheck.loggedIn, true);
  assert.equal(afterCheck.authCheckDeferred, undefined);
  assert.equal(checks, 1);
});
