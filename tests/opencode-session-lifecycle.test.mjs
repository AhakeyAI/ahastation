import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenCodeBackend } from '../dist-electron/backends/opencode-adapter.js';
import { AgentResourcePool } from '../dist-electron/agent-resource-pool.js';
import { ProcessMetricsSampler } from '../dist-electron/agent-process-metrics.js';
import { ManagedAgentSession } from '../dist-electron/managed-agent-session.js';
import {
  OpencodeServerRegistry, getOpencodeServerRegistry, serverKeyOf,
} from '../dist-electron/ide/opencode/opencode-server-registry.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, spawn) {
  const registry = new OpencodeServerRegistry({ load: () => [], save() {}, probe: async () => false });
  const singleton = getOpencodeServerRegistry();
  t.mock.method(singleton, 'acquire', (opts) => registry.acquire({ ...opts, spawn }));
  t.mock.method(singleton, 'handleLifecycle', (...args) => registry.handleLifecycle(...args));
  let alive = true;
  let kills = 0;
  const exits = [];
  const handle = {
    url: 'http://127.0.0.1:1', password: 'fixture', pid: 101,
    kill() { kills++; },
    onExit(cb) { exits.push(cb); },
  };
  const pool = new AgentResourcePool({ limit: 1, automatic: false,
    sampler: new ProcessMetricsSampler(async () => alive
      ? [{ pid: 101, ppid: 0, startedAt: 'fixture', rssBytes: 100, cpuTimeMs: 0 }] : []) });
  const events = [];
  const config = { cwd: process.cwd(), meetingId: 'lifecycle-fixture', executionRole: 'host' };
  const session = new ManagedAgentSession(new OpenCodeBackend(), config, (e) => events.push(e), pool);
  t.after(() => session.end());
  return { session, pool, registry, handle, events,
    key: serverKeyOf(config.meetingId, config.cwd),
    get kills() { return kills; },
    exit() { alive = false; for (const cb of exits) cb(0, null); },
  };
}

test('close during OpenCode acquire releases a late shared-server reference and drains its PID', async (t) => {
  const gate = deferred();
  const f = fixture(t, () => gate.promise);
  const started = f.session.start();
  await tick();
  f.session.end();
  assert.equal(f.pool.snapshot().resident, 1, 'acquire has not finished yet');
  gate.resolve(f.handle);
  await started;
  assert.equal(f.registry.refcount(f.key), 0);
  assert.equal(f.kills, 1);
  await f.pool.sweep();
  assert.equal(f.pool.snapshot().draining, 1, 'kill request is not a native exit');
  f.exit();
  await f.pool.sweep();
  assert.equal(f.pool.snapshot().draining, 0);
});

test('close while OpenCode awaits its first event stream settles start without a server leak', async (t) => {
  let f;
  f = fixture(t, async () => f.handle);
  const connecting = deferred();
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    connecting.resolve();
    return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('stream aborted')), { once: true });
    });
  });
  const started = f.session.start();
  await connecting.promise;
  f.session.end();
  await started;
  assert.equal(f.registry.refcount(f.key), 0);
  assert.equal(f.kills, 1);
  assert.equal(f.events.some((e) => e.kind === 'error'), false);
  await f.pool.sweep();
  assert.equal(f.pool.snapshot().draining, 1);
  f.exit();
  await f.pool.sweep();
  assert.equal(f.pool.snapshot().draining, 0);
});

test('a late cancelled OpenCode acquire releases only its own shared-server reference', async (t) => {
  const gate = deferred();
  const acquired = deferred();
  const f = fixture(t, async () => f.handle);
  await f.registry.acquire({ meetingId: 'lifecycle-fixture', cwd: process.cwd(), spawn: async () => f.handle });
  t.mock.method(getOpencodeServerRegistry(), 'acquire', async (opts) => {
    const reference = await f.registry.acquire(opts);
    acquired.resolve();
    await gate.promise;
    return reference;
  });
  const started = f.session.start();
  await acquired.promise;
  f.session.end();
  assert.equal(f.registry.refcount(f.key), 2);
  gate.resolve();
  await started;
  assert.equal(f.registry.refcount(f.key), 1);
  assert.equal(f.kills, 0);
  await f.registry.handleLifecycle('sessionEnd', f.key);
  assert.equal(f.kills, 1);
  f.exit();
});
