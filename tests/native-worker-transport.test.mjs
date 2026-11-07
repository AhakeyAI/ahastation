import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Utf8Frames } from '../dist-electron/native-worker/utf8-frames.js';

test('approval and content UTF-8 survives every byte split and one-byte chunks', () => {
  const action = { op: 'ask', input: { content: '中文，审批后写入 🧪\n第二行', file_path: 'unicode.txt' } };
  const bytes = Buffer.from(JSON.stringify(action) + '\n');
  for (let split = 0; split <= bytes.length; split++) {
    const frames = new Utf8Frames();
    const lines = [...frames.push(bytes.subarray(0, split)), ...frames.push(bytes.subarray(split))];
    frames.end(); assert.deepEqual(lines.map(JSON.parse), [action]);
  }
  const frames = new Utf8Frames(), lines = [];
  for (const byte of Buffer.concat([bytes, bytes])) lines.push(...frames.push(Uint8Array.of(byte)));
  frames.end(); assert.deepEqual(lines.map(JSON.parse), [action, action]);
});

test('invalid, truncated, or oversized UTF-8 frames fail closed', () => {
  assert.throws(() => new Utf8Frames().push(Uint8Array.of(0xe4, 0x41)), /encoded data/);
  const partial = new Utf8Frames(); partial.push(Uint8Array.of(0xe4, 0xb8));
  assert.throws(() => partial.end(), /encoded data/);
  const unfinished = new Utf8Frames(); unfinished.push(Buffer.from('{"content":"中文"}'));
  assert.throws(() => unfinished.end(), /truncated/);
  assert.throws(() => new Utf8Frames().push(Buffer.alloc(2 * 1024 * 1024 + 1, 65)), /too-large/);
});

// Actual own AppContainer tree. No CLI, PTY, user config or name-based kill.
for (const stopMode of ['stop', 'host-eof']) test(`saturated worker input cannot block ${stopMode} and Job reaping`, {
  skip: process.platform !== 'win32', timeout: 15_000,
}, async t => {
  // Windows CI's TEMP may use RUNNER~1. Resolve this owned directory before
  // passing it into a token that cannot enumerate the user's parent folder.
  const directory = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), 'aha-guard-saturation-')));
  const child = spawn(resolve(process.env.AHA_GUARD_TEST_HELPER ?? 'build/worker-guard/WindowsGuard.exe'), [],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let ended = false; void exited.then(() => { ended = true; });
  child.stdin.on('error', () => {}); child.stderr.resume();
  const events = [], frames = new Utf8Frames(); let failure;
  child.stdout.on('data', bytes => {
    try { events.push(...frames.push(bytes).map(JSON.parse)); } catch (error) { failure = error; }
  });
  t.after(async () => {
    // Exact child process handle launched by this test only. Closing this
    // helper's handle triggers KILL_ON_JOB_CLOSE even on a failed regression.
    if (!ended) { child.kill(); await exited; }
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const wait = async predicate => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      const describe = () => JSON.stringify(events.map(e => ({ kind: e.kind, error: e.error, op: e.message?.op,
        errorType: e.message?.errorType, errorCode: e.message?.errorCode, nativeErrorCode: e.message?.nativeErrorCode,
        messageKeys: Object.keys(e.message ?? {}) })));
      assert.equal(events.some(e => e.kind === 'fatal' || e.message?.op === 'fixture-error'), false,
        `guard lost fixture transport: ${describe()}`);
      const index = events.findIndex(predicate); if (index >= 0) return events.splice(index, 1)[0];
      assert.equal(ended, false, `helper exited before returning OS evidence: ${describe()}`);
      await delay(10);
    }
    assert.fail('guard did not answer while input pipe was saturated');
  };
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  send({ directory, hello: { credential: 'owned-fault-fixture', basis: {}, sessionId: 'fixture-only' } });
  const identity = await wait(e => e.kind === 'spawned');
  await wait(e => e.kind === 'request' && e.message.op === 'bind');
  send({ kind: 'input', message: { pauseInput: true } });
  const paused = await wait(e => e.kind === 'request' && e.message.op === 'input-paused');
  assert.ok(paused.message.pid > 0, 'live descendant is inside the same Job');
  send({ kind: 'input', message: { content: '管道饱和'.repeat(40_000) } });
  await delay(100);
  send({ kind: 'transport-state' });
  const blocked = await wait(e => e.kind === 'transport-state');
  assert.equal(blocked.writing, 1); assert.ok(blocked.pendingBytes > 64 * 1024);
  await delay(150);
  send({ kind: 'transport-state' });
  assert.equal((await wait(e => e.kind === 'transport-state')).writing, 1, 'write remains physically blocked');
  const start = Date.now();
  if (stopMode === 'stop') send({ kind: 'stop' }); else child.stdin.end();
  const exit = await wait(e => e.kind === 'tree-exit');
  assert.equal(exit.confirmed, true); assert.equal(exit.activeProcesses, 0);
  for (const key of ['pid', 'startId', 'bootId']) assert.equal(exit[key], identity[key]);
  const stopMs = Date.now() - start;
  assert.ok(stopMs < 3000, 'stop/EOF is independent of the blocked writer');
  t.diagnostic(JSON.stringify({ mode: stopMode, pendingBytes: blocked.pendingBytes, stopMs, activeProcesses: exit.activeProcesses }));
  assert.equal((await exited).code, 0);
});
