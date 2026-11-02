import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSession } from '../dist-electron/claude-session.js';
import { ClaudeCodeBackend } from '../dist-electron/backends/claude-code-adapter.js';

function hangingQuery() {
  return {
    initializationResult: () => new Promise(() => {}),
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise(() => {}); },
    async interrupt() {},
    async setPermissionMode() {},
    close() {},
  };
}

test('Claude readiness honors initializationTimeoutMs and reports a normal error (A-18)', async () => {
  const events = [];
  const session = new ClaudeSession({
    cwd: process.cwd(),
    emit: (event) => events.push(event),
    sessionOptions: { initializationTimeoutMs: 25 },
    queryFactory: hangingQuery,
  });

  await assert.rejects(session.start(), /readiness handshake timed out/);
  const errors = events.filter((event) => event.kind === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /readiness handshake timed out/);
  assert.equal(events.some((event) => event.kind === 'auth-required'), false);
  session.end();
});

test('Claude worker readiness timeout surfaces as a failed worker signal (A-18)', async () => {
  const events = [];
  const backend = new ClaudeCodeBackend({ queryFactory: hangingQuery });
  const session = backend.createSession({
    cwd: process.cwd(),
    executionRole: 'worker',
    extra: { initializationTimeoutMs: 25 },
  }, (event) => events.push(event));

  await assert.rejects(session.start(), /readiness handshake timed out/);
  const failed = events.filter((event) => event.kind === 'worker-signal'
    && event.signal.kind === 'failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].signal.code, 'claude-runtime-error');
  assert.match(failed[0].signal.message, /readiness handshake timed out/);
  session.end();
});
