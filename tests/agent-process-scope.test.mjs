import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';

import { AgentProcessScope, trackAgentProcess } from '../dist-electron/agent-process-scope.js';
import { createCliTransport } from '../dist-electron/claude-cli/transport.js';
import { PtyHost } from '../dist-electron/pty-host.js';

function register(pid, child) {
  trackAgentProcess(pid, (onExit) => child.once('exit', onExit));
}

test('no scope or invalid PID does not subscribe', () => {
  const subscribe = () => assert.fail('must not subscribe');
  trackAgentProcess(123, subscribe);
  const scope = new AgentProcessScope();
  scope.run(() => {
    for (const pid of [undefined, null, 0, -1, 1.5, NaN, Infinity, '123', Number.MAX_SAFE_INTEGER + 1]) {
      trackAgentProcess(pid, subscribe);
    }
  });
  assert.equal(scope.processes.size, 0);
});

test('run preserves values, promises, throws, and the enclosing scope', async () => {
  const outer = new AgentProcessScope();
  const inner = new AgentProcessScope();
  const child = new EventEmitter();
  const value = {};
  assert.equal(outer.run(() => value), value);
  const promise = Promise.resolve(value);
  assert.equal(outer.run(() => promise), promise);
  outer.run(() => {
    register(1, child);
    assert.throws(() => inner.run(() => {
      register(2, child);
      throw new Error('nested');
    }), /nested/);
    register(3, child);
  });
  await assert.rejects(inner.run(async () => { throw new Error('async'); }), /async/);
  trackAgentProcess(4, () => assert.fail('scope leaked'));
  assert.deepEqual([...outer.processes.keys()], [1, 3]);
  assert.deepEqual([...inner.processes.keys()], [2]);
});

test('concurrent start/send promise and timer chains remain isolated', async () => {
  const a = new AgentProcessScope();
  const b = new AgentProcessScope();
  const childA = new EventEmitter();
  const childB = new EventEmitter();
  // Queue exists before either scope, like a session send queue.
  const queue = Promise.resolve();
  await Promise.all([
    a.run(async () => {
      await nextTurn();
      register(10, childA);
      await queue.then(async () => {
        await nextTurn();
        register(11, childA);
      });
    }),
    b.run(async () => {
      await queue.then(() => register(20, childB));
      await nextTurn();
      register(21, childB);
    }),
  ]);
  assert.deepEqual([...a.processes.keys()], [10, 11]);
  assert.deepEqual([...b.processes.keys()], [20, 21]);
  assert.ok([...a.processes.values()].every((r) => !r.exited));
  // Exit outside both scopes still updates only the captured records.
  childA.emit('exit');
  assert.ok([...a.processes.values()].every((r) => r.exited));
  assert.ok([...b.processes.values()].every((r) => !r.exited));
  childB.emit('exit');
  assert.ok([...b.processes.values()].every((r) => r.exited));
});

test('live PID deduplicates but a new process may reuse it after exit', () => {
  const scope = new AgentProcessScope();
  const child = new EventEmitter();
  scope.run(() => {
    register(30, child);
    register(30, child);
  });
  assert.equal(child.listenerCount('exit'), 1);
  const record = scope.processes.get(30);
  child.emit('exit');
  const replacement = new EventEmitter();
  scope.run(() => register(30, replacement));
  assert.notEqual(scope.processes.get(30), record);
  assert.deepEqual(record, { pid: 30, exited: true });
  child.emit('exit');
  assert.equal(scope.processes.get(30).exited, false);
  replacement.emit('exit');
  assert.equal(scope.processes.get(30).exited, true);
});

test('a shared server PID is independently recorded in each session scope', () => {
  const a = new AgentProcessScope();
  const b = new AgentProcessScope();
  const child = new EventEmitter();
  const handle = { pid: 40, onExit: (cb) => child.once('exit', cb) };
  for (const scope of [a, b]) {
    scope.run(() => trackAgentProcess(handle.pid, (cb) => handle.onExit(cb)));
  }
  assert.equal(child.listenerCount('exit'), 2);
  assert.notEqual(a.processes.get(40), b.processes.get(40));
  assert.equal(a.processes.get(40).exited, false);
  assert.equal(b.processes.get(40).exited, false);
  child.emit('exit');
  assert.equal(a.processes.get(40).exited, true);
  assert.equal(b.processes.get(40).exited, true);
});

test('exit captures the original record rather than looking up a reused PID', () => {
  const scope = new AgentProcessScope();
  const oldChild = new EventEmitter();
  const newChild = new EventEmitter();
  scope.run(() => register(50, oldChild));
  const oldRecord = scope.processes.get(50);
  scope.processes.delete(50);
  scope.run(() => register(50, newChild));
  oldChild.emit('exit');
  assert.equal(oldRecord.exited, true);
  assert.equal(scope.processes.get(50).exited, false);
  newChild.emit('exit');
  assert.equal(scope.processes.get(50).exited, true);
});

test('an already-exited handle may notify synchronously during subscription', () => {
  const scope = new AgentProcessScope();
  scope.run(() => trackAgentProcess(60, (onExit) => onExit()));
  assert.deepEqual(scope.processes.get(60), { pid: 60, exited: true });
});

test('real child PID stays live until the native exit event', { timeout: 10_000 }, async (t) => {
  const scope = new AgentProcessScope();
  const child = scope.run(() => {
    const proc = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    register(proc.pid, proc);
    return proc;
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = once(child, 'exit');
  assert.deepEqual(scope.processes.get(child.pid), { pid: child.pid, exited: false });
  child.stdin.end();
  assert.equal(scope.processes.get(child.pid).exited, false);
  await exited;
  assert.equal(scope.processes.get(child.pid).exited, true);
});

test('Claude transport close settles the session but does not synthesize process exit', () => {
  const scope = new AgentProcessScope();
  const child = Object.assign(new EventEmitter(), {
    pid: 70,
    stdin: { write() {}, end() {} },
    stdout: null,
    stderr: null,
    kill() {},
  });
  let settled = false;
  const transport = scope.run(() => createCliTransport(
    { file: 'fake', args: [], cwd: process.cwd(), env: {} },
    { spawnFn: () => child, onMessage() {}, onExit() { settled = true; } },
  ));
  assert.equal(scope.processes.get(70).exited, false);
  // Prevent Windows process-tree cleanup from invoking taskkill on a fake PID.
  child.pid = undefined;
  transport.close();
  assert.equal(settled, true);
  assert.equal(scope.processes.get(70).exited, false);
  child.emit('exit', 0, null);
  assert.equal(scope.processes.get(70).exited, true);
});

test('PTY tracking survives kill/dispose and waits for its independent onExit', () => {
  const scope = new AgentProcessScope();
  const exits = new Set();
  const pty = {
    pid: 80,
    onData() { return { dispose() {} }; },
    onExit(cb) {
      exits.add(cb);
      return { dispose() { exits.delete(cb); } };
    },
    write() {}, resize() {}, kill() {},
  };
  const host = new PtyHost({ spawn: () => pty });
  scope.run(() => host.spawn('worker', { file: 'fake', args: [], cwd: process.cwd(), env: {} }));
  assert.equal(exits.size, 2);
  host.kill('worker');
  assert.equal(host.has('worker'), false);
  assert.equal(exits.size, 1);
  assert.equal(scope.processes.get(80).exited, false);
  for (const cb of exits) cb({ exitCode: 0 });
  assert.equal(scope.processes.get(80).exited, true);
});
