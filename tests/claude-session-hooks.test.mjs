import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ClaudeSession } from '../dist-electron/claude-session.js';
import { buildCliArgs } from '../dist-electron/claude-cli/driver.js';

test('Claude sessions disable settings-sourced hooks and clean up on end (A-17)', async () => {
  let queryInput;
  const fakeQuery = {
    initializationResult: async () => ({ session_id: 'claude-hooks-off' }),
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise(() => {}); },
    async interrupt() {},
    async setPermissionMode() {},
    close() {},
  };
  const session = new ClaudeSession({
    cwd: process.cwd(),
    emit: () => {},
    queryFactory: (input) => { queryInput = input; return fakeQuery; },
  });

  await session.start();
  const settingsPath = queryInput.options.settingsPath;
  assert.equal(typeof settingsPath, 'string');
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), { disableAllHooks: true });
  // The user's settings tree still loads (login state, subagents, MCP) —
  // only the hooks inside it are neutralized.
  assert.deepEqual(queryInput.options.settingSources, ['user', 'project', 'local']);

  const settingsDir = dirname(settingsPath);
  session.end();
  assert.equal(existsSync(settingsDir), false);
});

test('Claude readiness failure also removes the per-session settings dir (A-17)', async () => {
  let queryInput;
  const fakeQuery = {
    initializationResult: async () => { throw new Error('init failed'); },
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise(() => {}); },
    async interrupt() {},
    async setPermissionMode() {},
    close() {},
  };
  const session = new ClaudeSession({
    cwd: process.cwd(),
    emit: () => {},
    queryFactory: (input) => { queryInput = input; return fakeQuery; },
  });

  await assert.rejects(session.start(), /init failed/);
  assert.equal(existsSync(dirname(queryInput.options.settingsPath)), false);
});

test('driver forwards --settings to the CLI (A-17)', () => {
  const args = buildCliArgs(
    { settingsPath: '/tmp/aha-settings.json' },
    { hasCanUseTool: false, externalMcpServers: {} },
  );
  const index = args.indexOf('--settings');
  assert.notEqual(index, -1);
  assert.equal(args[index + 1], '/tmp/aha-settings.json');
});
