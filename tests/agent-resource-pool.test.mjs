import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentResourcePool } from '../dist-electron/agent-resource-pool.js';
import { ProcessMetricsSampler } from '../dist-electron/agent-process-metrics.js';
import { trackAgentProcess } from '../dist-electron/agent-process-scope.js';

const row = (pid, ppid = 0, startedAt = `start-${pid}`) => ({ pid, ppid, startedAt, rssBytes: 100, cpuTimeMs: 0 });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(limit = 1) {
  let rows = [];
  let error;
  let now = 0;
  const pool = new AgentResourcePool({ limit, automatic: false, sampler: new ProcessMetricsSampler(async () => {
    if (error) throw error;
    return rows;
  }, () => ++now * 1000) });
  return { pool, setRows: (value) => { rows = value; }, fail: (value) => { error = value; } };
}
function track(lease, pid) {
  let exit;
  lease.scope.run(() => trackAgentProcess(pid, (cb) => { exit = cb; }));
  return () => exit();
}
const acquire = (pool) => pool.acquire('codex', 'worker', new AbortController().signal);

test('global admission is FIFO and waiting cancellation does not spend a lease', async () => {
  const { pool } = fixture();
  const first = await acquire(pool);
  const abort = new AbortController();
  const cancelled = pool.acquire('claude-code', 'host', abort.signal);
  const rejection = assert.rejects(cancelled, /cancelled/);
  let admitted = false;
  const last = acquire(pool).then((lease) => { admitted = true; return lease; });
  await tick();
  assert.equal(admitted, false);
  assert.equal(pool.snapshot().waiting, 2);
  abort.abort();
  await rejection;
  pool.retire(first);
  const second = await last;
  assert.equal(pool.snapshot().resident, 1);
  assert.equal(pool.snapshot().waiting, 0);
  pool.retire(second);
});

test('end request does not free capacity until the OS confirms exit', async () => {
  const { pool, setRows } = fixture();
  const first = await acquire(pool);
  const exit = track(first, 10);
  setRows([row(10)]);
  await pool.sweep();
  pool.retire(first);
  let ready = false;
  const second = acquire(pool).then((lease) => { ready = true; return lease; });
  await pool.sweep();
  assert.equal(ready, false);
  assert.equal(pool.snapshot().draining, 1);
  exit();
  setRows([]);
  await pool.sweep();
  pool.retire(await second);
});

test('observed descendants retain the lease after parent exit and reparenting', async () => {
  const { pool, setRows } = fixture();
  const first = await acquire(pool);
  const exit = track(first, 10);
  setRows([row(10), row(11, 10)]);
  await pool.sweep();
  pool.retire(first);
  exit();
  setRows([row(11, 1)]);
  await pool.sweep();
  assert.equal(pool.snapshot().draining, 1);
  setRows([]);
  await pool.sweep();
  assert.equal(pool.snapshot().draining, 0);
});

test('sampling failure fails closed, and recovery drains the lease', async () => {
  const { pool, setRows, fail } = fixture();
  const first = await acquire(pool);
  track(first, 10);
  pool.retire(first);
  fail(new Error('collector offline'));
  await pool.sweep();
  assert.equal(pool.snapshot().draining, 1);
  assert.equal(pool.snapshot().rssBytes, null);
  assert.equal(pool.snapshot().cpuPercent, null);
  assert.match(pool.snapshot().error, /offline/);
  fail(undefined);
  setRows([]);
  await pool.sweep();
  assert.equal(pool.snapshot().draining, 0);
});

test('shared runtime memory deduplicates and a remaining owner retains the process', async () => {
  const { pool, setRows } = fixture(2);
  const a = await acquire(pool);
  const b = await acquire(pool);
  track(a, 10);
  track(b, 10);
  setRows([row(10), row(11, 10)]);
  await pool.sweep();
  assert.equal(pool.snapshot().rssBytes, 200);
  assert.equal(pool.snapshot().processCount, 2);
  pool.retire(a);
  await pool.sweep();
  assert.equal(pool.snapshot().resident, 1);
  assert.equal(pool.snapshot().draining, 0);
  pool.retire(b);
  await pool.sweep();
  assert.equal(pool.snapshot().draining, 1);
});

test('PID reuse of a sampled orphan does not pin a retiring lease', async () => {
  const { pool, setRows } = fixture();
  const lease = await acquire(pool);
  const exit = track(lease, 10);
  setRows([row(10), row(11, 10)]);
  await pool.sweep();
  pool.retire(lease);
  exit();
  setRows([row(11, 1, 'different-process')]);
  await pool.sweep();
  assert.equal(pool.snapshot().draining, 0);
});

test('a child spawned during sampling cannot be drained using the older snapshot', async () => {
  let finish;
  let collecting;
  const begun = new Promise((resolve) => { collecting = resolve; });
  const pool = new AgentResourcePool({ automatic: false, sampler: new ProcessMetricsSampler(() => {
    collecting();
    return new Promise((resolve) => { finish = resolve; });
  }) });
  const lease = await acquire(pool);
  const sample = pool.sweep();
  await begun;
  track(lease, 10);
  pool.retire(lease);
  finish([]);
  await sample;
  assert.equal(pool.snapshot().draining, 1);
});

test('invalid limits are rejected in favor of bounded defaults', () => {
  assert.equal(new AgentResourcePool({ limit: 0 }).limit, 6);
  assert.equal(new AgentResourcePool({ limit: 999 }).limit, 32);
  assert.equal(new AgentResourcePool({ idleTimeoutMs: -1 }).idleTimeoutMs, 60_000);
});

test('parent exit during enumeration still captures children before they are reparented', async () => {
  let finish;
  let rows;
  const pool = new AgentResourcePool({ limit: 1, automatic: false,
    sampler: new ProcessMetricsSampler(() => rows
      ? Promise.resolve(rows)
      : new Promise((resolve) => { finish = resolve; })) });
  const lease = await acquire(pool);
  const exit = track(lease, 10);
  const sampling = pool.sweep();
  await tick();
  pool.retire(lease);
  exit();
  finish([row(10), row(11, 10)]);
  await sampling;
  rows = [row(11, 1)];
  await pool.sweep();
  assert.equal(pool.snapshot().draining, 1);
  rows = [];
  await pool.sweep();
  assert.equal(pool.snapshot().draining, 0);
});
