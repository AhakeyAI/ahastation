import test from 'node:test';
import assert from 'node:assert/strict';
import { ManagedAgentSession, createManagedAgentSession } from '../dist-electron/managed-agent-session.js';
import { AgentResourcePool } from '../dist-electron/agent-resource-pool.js';
import { ProcessMetricsSampler } from '../dist-electron/agent-process-metrics.js';
import { trackAgentProcess } from '../dist-electron/agent-process-scope.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture({ id = 'claude-code', role = 'host', checkpoint = true, startGate, confirmDestructive } = {}) {
  let now = 0;
  let nextPid = 100;
  const rows = new Map();
  const instances = [];
  const events = [];
  const pool = new AgentResourcePool({ limit: 1, idleTimeoutMs: 100, automatic: false,
    sampler: new ProcessMetricsSampler(async () => [...rows.values()], () => now) });
  const backend = { id, createSession(config, emit) {
    const pid = ++nextPid;
    let exit;
    const instance = {
      config, emit, sent: [], ended: 0,
      async start() {
      if (startGate) await startGate.promise;
        rows.set(pid, { pid, ppid: 0, startedAt: String(pid), rssBytes: 100, cpuTimeMs: 0 });
        trackAgentProcess(pid, (cb) => { exit = cb; });
      },
      end() { this.ended++; emit({ kind: 'ended' }); },
      exit() { rows.delete(pid); exit?.(); },
      sendUserText(text) { this.sent.push(text); },
      sendUserContent(content) { this.sent.push(content); },
      resolvePermission() {},
      async interrupt() {},
      snapshot() { return checkpoint ? { protocol: id, sessionId: 'native-session' } : null; },
      setAutoApproveScope(scope) { this.scope = scope; },
      async setPermissionMode(mode) { this.mode = mode; },
    };
    instances.push(instance);
    return instance;
  } };
  const config = { cwd: '.', executionRole: role, extra: { codexTransport: 'app-server' }, confirmDestructive };
  const session = new ManagedAgentSession(backend, config, (event) => events.push(event), pool, () => now);
  return { session, pool, backend, instances, events, config,
    advance: (ms = 101) => { now += ms; },
    complete: () => instances.at(-1).emit(id === 'codex'
      ? { kind: 'turn-status', status: 'completed' }
      : { kind: 'message', message: { type: 'result' } }),
  };
}

for (const id of ['claude-code', 'codex']) {
  test(`${id}: idle host releases the runtime and resumes with its native checkpoint`, async () => {
    const f = fixture({ id });
    await f.session.start();
    f.session.sendUserText('first');
    f.complete();
    f.advance();
    await f.pool.sweep();
    assert.equal(f.instances[0].ended, 1);
    assert.equal(f.pool.snapshot().draining, 1);
    assert.equal(f.events.filter((event) => event.kind === 'ended').length, 0);
    assert.equal(f.session.snapshot().sessionId, 'native-session');
    f.session.sendUserText('second');
    f.session.sendUserText('third');
    await tick();
    assert.equal(f.instances.length, 1);
    assert.equal(f.session.isWaitingForResources(), true);
    f.instances[0].exit();
    await f.pool.sweep();
    await tick();
    assert.equal(f.instances.length, 2);
    assert.equal(f.instances[1].config.resumeSessionId, 'native-session');
    assert.deepEqual(f.instances[1].sent, ['second', 'third']);
    f.instances[0].emit({ kind: 'ended' });
    assert.equal(f.events.filter((event) => event.kind === 'ended').length, 0);
    f.session.end();
  });
}

test('an active tool or silent turn without completion never counts as idle', async () => {
  const f = fixture();
  await f.session.start();
  f.session.sendUserText('run slow build');
  f.instances[0].emit({ kind: 'message', message: { type: 'assistant', message: {
    content: [{ type: 'tool_use', id: 'build', name: 'Bash', input: {} }],
  } } });
  f.advance();
  await f.pool.sweep();
  assert.equal(f.instances[0].ended, 0);
  f.session.end();
});

test('permissions block reclamation even after a completion event', async () => {
  const f = fixture();
  await f.session.start();
  f.session.sendUserText('edit');
  f.instances[0].emit({ kind: 'permission-request', id: 'approval', toolName: 'Write', input: {}, toolUseID: 't' });
  f.complete();
  f.advance();
  await f.pool.sweep();
  assert.equal(f.instances[0].ended, 0);
  f.session.resolvePermission('approval', 'deny');
  f.advance();
  await f.pool.sweep();
  assert.equal(f.instances[0].ended, 1);
});

test('native confirmation is tracked even when it produces no permission event', async () => {
  const gate = deferred();
  const f = fixture({ confirmDestructive: () => gate.promise });
  await f.session.start();
  f.session.sendUserText('delete');
  const confirming = f.instances[0].config.confirmDestructive('Bash', {});
  f.complete();
  f.advance();
  await f.pool.sweep();
  assert.equal(f.instances[0].ended, 0);
  gate.resolve(false);
  await confirming;
  f.advance();
  await f.pool.sweep();
  assert.equal(f.instances[0].ended, 1);
});

test('queued turns must all finish before reclamation', async () => {
  const f = fixture({ id: 'codex' });
  await f.session.start();
  f.session.sendUserText('first');
  f.session.sendUserText('second');
  f.complete();
  f.advance();
  await f.pool.sweep();
  assert.equal(f.instances[0].ended, 0);
  f.complete();
  f.advance();
  await f.pool.sweep();
  assert.equal(f.instances[0].ended, 1);
});

for (const options of [{ id: 'claude-terminal' }, { id: 'opencode' }, { role: 'worker' }, { checkpoint: false }]) {
  test(`uncertain resume capability stays resident: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    await f.session.start();
    f.session.sendUserText('first');
    f.complete();
    f.advance();
    await f.pool.sweep();
    assert.equal(f.instances[0].ended, 0);
    f.session.end();
  });
}

test('interrupt boundary is not treated as a resumable idle completion', async () => {
  const f = fixture();
  await f.session.start();
  f.session.sendUserText('first');
  await f.session.interrupt('user');
  f.complete();
  f.advance();
  await f.pool.sweep();
  assert.equal(f.instances[0].ended, 0);
  f.session.end();
});

test('stop during a handshake does not release before a late process spawn exits', async () => {
  const gate = deferred();
  const f = fixture({ startGate: gate });
  const started = f.session.start();
  await tick();
  f.session.end();
  assert.equal(f.pool.snapshot().resident, 1);
  gate.resolve();
  await started;
  assert.equal(f.pool.snapshot().draining, 1);
  await f.pool.sweep();
  assert.equal(f.pool.snapshot().draining, 1);
  f.instances[0].exit();
  await f.pool.sweep();
  assert.equal(f.pool.snapshot().draining, 0);
});

test('stop during admission cancels queued input without spawning', async () => {
  const f = fixture();
  const blocker = await f.pool.acquire('other', 'worker', new AbortController().signal);
  f.session.sendUserText('must not execute');
  await tick();
  assert.equal(f.session.isWaitingForResources(), true);
  await f.session.interrupt('user');
  f.pool.retire(blocker);
  await tick();
  assert.equal(f.instances.length, 0);
  assert.equal(f.pool.snapshot().resident, 0);
  assert.equal(f.events.some((e) => e.kind === 'error' || e.kind === 'ended'), false);
  f.session.sendUserText('new input');
  await tick();
  assert.deepEqual(f.instances[0].sent, ['new input']);
  f.session.end();
});

test('stopping a dormant Host drops only old inputs, including inputs racing with cleanup', async () => {
  const f = fixture();
  await f.session.start();
  f.session.sendUserText('first');
  f.complete();
  f.advance();
  await f.pool.sweep();
  f.session.sendUserText('cancel text');
  f.session.sendUserContent([{ type: 'text', text: 'cancel content' }]);
  await tick();
  const stopping = f.session.interrupt('user');
  f.session.sendUserText('keep new text');
  await stopping;
  f.instances[0].exit();
  await f.pool.sweep();
  await tick();
  assert.deepEqual(f.instances[1].sent, ['keep new text']);
  assert.equal(f.instances[1].config.resumeSessionId, 'native-session');
  assert.equal(f.events.some((e) => e.kind === 'error' || e.kind === 'ended'), false);
  f.session.end();
});

test('end while initial start awaits admission settles without reporting a failed Host', async () => {
  const f = fixture();
  const blocker = await f.pool.acquire('other', 'worker', new AbortController().signal);
  const started = f.session.start();
  f.session.end();
  await started;
  assert.equal(f.instances.length, 0);
  assert.equal(f.pool.snapshot().waiting, 0);
  assert.equal(f.events.length, 0);
  f.pool.retire(blocker);
});

test('a cancelled handshake joins a late rejection without failing the Host again', async () => {
  const gate = deferred();
  const f = fixture({ startGate: gate });
  let settled = false;
  const started = f.session.start().then(() => { settled = true; });
  await tick();
  f.session.end();
  await tick();
  assert.equal(settled, false);
  assert.equal(f.pool.snapshot().resident, 1);
  gate.reject(new Error('transport closed'));
  await started;
  assert.equal(f.pool.snapshot().resident, 0);
  assert.equal(f.events.length, 0);
});

test('stopping a Worker during admission reports interruption and never starts it later', async () => {
  const f = fixture({ role: 'worker' });
  const blocker = await f.pool.acquire('other', 'worker', new AbortController().signal);
  const started = f.session.start();
  await f.session.interrupt('user');
  await started;
  assert.deepEqual(f.events, [{ kind: 'worker-signal', signal: { kind: 'ended', reason: 'interrupted' } }]);
  f.pool.retire(blocker);
  f.session.sendUserText('must not run');
  await tick();
  assert.equal(f.instances.length, 0);
});

for (const role of ['host', 'worker']) {
  test(`worker-signal ended ${role === 'host' ? 'retires a terminal Host' : 'keeps a Worker turn reusable'}`, async () => {
    const f = fixture({ id: 'claude-terminal', role });
    await f.session.start();
    f.instances[0].emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'completed' } });
    assert.equal(f.pool.snapshot().draining, role === 'host' ? 1 : 0);
    assert.equal(f.instances[0].ended, role === 'host' ? 1 : 0);
    f.session.end();
    f.instances[0].exit();
    await f.pool.sweep();
    assert.equal(f.pool.snapshot().draining, 0);
  });
}

test('resource wait accounting includes only the overlap with completed and current admission', async () => {
  const f = fixture();
  const blocker = await f.pool.acquire('other', 'worker', new AbortController().signal);
  const started = f.session.start();
  f.advance(80);
  assert.equal(f.session.resourceWaitTimeSince(30), 50);
  await f.session.interrupt('user');
  await started;
  f.advance(20);
  f.session.sendUserText('next');
  f.advance(40);
  assert.equal(f.session.resourceWaitTimeSince(30), 90);
  assert.equal(f.session.resourceWaitTimeSince(90), 40);
  f.pool.retire(blocker);
  await tick();
  f.advance(20);
  assert.equal(f.session.resourceWaitTimeSince(30), 90);
  f.session.end();
});

test('settings changes made while dormant apply on resume', async () => {
  const f = fixture();
  await f.session.start();
  f.advance();
  await f.pool.sweep();
  f.session.setAutoApproveScope('read');
  await f.session.setPermissionMode('default');
  f.instances[0].exit();
  await f.pool.sweep();
  f.session.sendUserText('resume');
  await tick();
  assert.equal(f.instances[1].config.autoApproveScope, 'read');
  assert.equal(f.instances[1].mode, 'default');
  f.session.end();
});

test('remote backend bypasses the local pool', () => {
  const marker = {};
  const session = createManagedAgentSession({ id: 'pocket-vibe', createSession: () => marker }, { cwd: '.' }, () => {});
  assert.equal(session, marker);
});
