import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import {
  collectProcessSamples,
  parseCpuTimeMs,
  parsePsProcessSamples,
  parseWindowsProcessSamples,
  processTree,
  ProcessMetricsSampler,
} from '../dist-electron/agent-process-metrics.js';

const sample = (pid, ppid = 0, cpuTimeMs = 0, startedAt = 'birth', rssBytes = 1024) =>
  ({ pid, ppid, cpuTimeMs, startedAt, rssBytes });
const windowsRow = {
  ProcessId: 42, ParentProcessId: 7, WorkingSetSize: '8192',
  KernelModeTime: '123450000', UserModeTime: 10000000,
  CreationDate: '2026-10-29T03:04:05.1234560Z',
};
const psRow = ' 42 7 8 01:02.50 Thu Oct 29 03:04:05 2026\n';

function sequence(frames, timestamps) {
  return new ProcessMetricsSampler(async () => {
    const next = frames.shift();
    if (next instanceof Error) throw next;
    return next;
  }, () => timestamps.shift());
}

test('CPU parser supports minutes, unbounded hours, days and fractional seconds', () => {
  for (const [text, expected] of [
    ['00:00', 0], ['01:02.50', 62500], ['123:45', 7425000],
    ['01:02:03', 3723000], ['123:04:05.125', 443045125],
    ['2-03:04:05', 183845000], [' 0-00:00:00.01 ', 10],
  ]) assert.equal(parseCpuTimeMs(text), expected, text);
});

test('CPU parser rejects malformed, negative and out-of-range times', () => {
  for (const text of ['', 'NaN', '-01:02', '1:60', '01:60:00', '1-24:00:00',
    '1-02:03', '01:02:03:04', '00:00suffix', '9'.repeat(400) + ':00']) {
    assert.throws(() => parseCpuTimeMs(text), /Invalid ps CPU time/);
  }
});

test('Unix parser converts KiB, preserves normalized identity and accepts CRLF', () => {
  assert.deepEqual(parsePsProcessSamples(psRow + '43 42 0 2-03:04:05 Mon Nov  2 00:00:00 2026\r\n'), [
    sample(42, 7, 62500, 'Thu Oct 29 03:04:05 2026', 8192),
    sample(43, 42, 183845000, 'Mon Nov 2 00:00:00 2026', 0),
  ]);
});

test('Unix parser fails the whole snapshot on malformed or truncated rows', () => {
  for (const text of ['', '   ', psRow + 'broken', '42 7 -8 00:00 Thu Oct 29 03:04:05 2026',
    '42 7 8 00:00', psRow.replace(' 8 ', ' 9007199254740991 ')]) {
    assert.throws(() => parsePsProcessSamples(text));
  }
});

test('Windows parser handles object, array, BOM, numeric strings and 100ns units', () => {
  const expected = sample(42, 7, 13345, windowsRow.CreationDate, 8192);
  assert.deepEqual(parseWindowsProcessSamples(JSON.stringify(windowsRow)), [expected]);
  assert.deepEqual(parseWindowsProcessSamples('\uFEFF' + JSON.stringify([windowsRow])), [expected]);
  assert.deepEqual(parseWindowsProcessSamples('[]'), []);
  const [withoutIdentity] = parseWindowsProcessSamples(JSON.stringify({ ...windowsRow, CreationDate: null }));
  assert.equal(withoutIdentity.startedAt, undefined);
  assert.deepEqual(Object.keys(withoutIdentity).sort(), ['cpuTimeMs', 'pid', 'ppid', 'rssBytes']);
});

test('Windows parser rejects missing metrics and malformed output rather than reporting zero', () => {
  for (const text of ['', 'null', '{}', '[null]', 'false', '{broken']) {
    assert.throws(() => parseWindowsProcessSamples(text));
  }
  for (const [field, value] of [
    ['WorkingSetSize', null], ['KernelModeTime', ''], ['UserModeTime', -1],
    ['ProcessId', 1.5], ['ParentProcessId', true], ['CreationDate', {}],
    ['WorkingSetSize', '9007199254740992'],
  ]) assert.throws(() => parseWindowsProcessSamples(JSON.stringify({ ...windowsRow, [field]: value })));
});

test('tree deduplicates overlapping roots and samples; excludes unrelated processes', () => {
  const rows = [sample(1), sample(2, 1), sample(3, 2), sample(4), sample(5, 4), sample(2, 1)];
  Object.freeze(rows);
  assert.deepEqual(processTree(rows, Object.freeze([1, 2, 1, 4])).map(p => p.pid).sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(processTree(rows, [2]).map(p => p.pid).sort(), [2, 3]);
  assert.deepEqual(processTree(rows, []), []);
});

test('tree terminates cycles and self-parent links, ignores absent/zero roots', () => {
  const rows = [sample(1, 2), sample(2, 1), sample(3, 3), sample(4, 99), sample(0)];
  assert.deepEqual(processTree(rows, [1, 3]).map(p => p.pid).sort(), [1, 2, 3]);
  assert.deepEqual(processTree(rows, [99, 0, -1]), []);
});

test('tree handles deep ancestry without recursion', () => {
  const rows = Array.from({ length: 20000 }, (_, i) => sample(i + 1, i));
  assert.equal(processTree(rows, [1]).length, rows.length);
});

test('sampler sums RSS once and computes single-core CPU above 100 percent', async () => {
  const sampler = sequence([
    [sample(1, 0, 100), sample(2, 1, 200), sample(9, 0, 50000)],
    [sample(1, 0, 1600), sample(2, 1, 700), sample(9, 0, 99999)],
  ], [1000, 2000]);
  const first = await sampler.sample([1, 2]);
  assert.equal(first.cpuPercent, null);
  assert.equal(first.rssBytes, 2048);
  const second = await sampler.sample([1, 2]);
  assert.equal(second.cpuPercent, 200);
  assert.equal(second.sampledAt, 2000);
  assert.equal(second.error, undefined);
});

test('new and exited processes do not add lifetime CPU or subtract counters', async () => {
  const sampler = sequence([
    [sample(1, 0, 100), sample(2, 1, 50000)],
    [sample(1, 0, 200), sample(3, 1, 80000)],
  ], [1000, 2000]);
  await sampler.sample([1]);
  assert.equal((await sampler.sample([1])).cpuPercent, 10);
});

test('identity changes, counter reset and reparenting establish a fresh baseline', async () => {
  for (const replacement of [sample(1, 0, 90000, 'new-birth'), sample(1, 0, 1), sample(1, 2, 90000)]) {
    const sampler = sequence([
      [sample(1, 0, 100)], [replacement], [{ ...replacement, cpuTimeMs: replacement.cpuTimeMs + 50 }],
    ], [1000, 2000, 3000]);
    await sampler.sample([1]);
    assert.equal((await sampler.sample([1])).cpuPercent, null);
    assert.equal((await sampler.sample([1])).cpuPercent, 5);
  }
});

test('missing identity uses parent and counter fallback; identity appearing resets baseline', async () => {
  const initial = { pid: 1, ppid: 0, cpuTimeMs: 100, rssBytes: 1024 };
  const sampler = sequence([
    [initial], [{ ...initial, cpuTimeMs: 200 }], [sample(1, 0, 50000)],
  ], [1000, 2000, 3000]);
  await sampler.sample([1]);
  assert.equal((await sampler.sample([1])).cpuPercent, 10);
  assert.equal((await sampler.sample([1])).cpuPercent, null);
});

test('nonpositive time differences return unknown CPU', async () => {
  const sampler = sequence([[sample(1)], [sample(1)], [sample(1)]], [1000, 1000, 900]);
  for (let i = 0; i < 3; i++) assert.equal((await sampler.sample([1])).cpuPercent, null);
});

test('empty trees are valid, with null first CPU then zero', async () => {
  const sampler = sequence([[], []], [1000, 2000]);
  assert.deepEqual(await sampler.sample([]), { sampledAt: 1000, processes: [], rssBytes: 0, cpuPercent: null });
  assert.equal((await sampler.sample([999])).cpuPercent, 0);
});

test('failure is explicit and resets baseline before recovery', async () => {
  const sampler = sequence([[sample(1)], new Error('permission denied'), [sample(1, 0, 90000)]], [1000, 2000, 3000]);
  await sampler.sample([1]);
  assert.deepEqual(await sampler.sample([1]), {
    sampledAt: 2000, processes: [], rssBytes: 0, cpuPercent: null, error: 'permission denied',
  });
  assert.equal((await sampler.sample([1])).cpuPercent, null);
});

test('synchronous and non-Error collector failures are returned, not thrown', async () => {
  const sampler = new ProcessMetricsSampler(() => { throw null; }, () => 1000);
  assert.equal((await sampler.sample([1])).error, 'Process collection failed');
});

test('concurrent requests coalesce OS calls but retain independent roots and baselines', async () => {
  let calls = 0;
  let finish;
  let time = 1000;
  const sampler = new ProcessMetricsSampler(() => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  }, () => time);
  const roots = [1];
  const first = sampler.sample(roots);
  const second = sampler.sample([2]);
  roots[0] = 999;
  await Promise.resolve();
  assert.equal(calls, 1);
  finish([sample(1), sample(2)]);
  assert.deepEqual((await first).processes.map(p => p.pid), [1]);
  assert.deepEqual((await second).processes.map(p => p.pid), [2]);
  time = 2000;
  const third = sampler.sample([1]);
  const fourth = sampler.sample([2]);
  await Promise.resolve();
  assert.equal(calls, 2);
  finish([sample(1, 0, 500), sample(2, 0, 250)]);
  assert.equal((await third).cpuPercent, 50);
  assert.equal((await fourth).cpuPercent, 25);
});

test('concurrent failures coalesce and release the in-flight slot', async () => {
  let calls = 0;
  const sampler = new ProcessMetricsSampler(async () => { calls++; throw new Error('failed'); });
  const results = await Promise.all([sampler.sample([1]), sampler.sample([2])]);
  assert.equal(calls, 1);
  assert.ok(results.every(result => result.error === 'failed' && result.cpuPercent === null));
  await sampler.sample([1]);
  assert.equal(calls, 2);
});

test('caller and collector mutations cannot corrupt the CPU baseline', async () => {
  const row = sample(1, 0, 100);
  const sampler = sequence([[row], [sample(1, 0, 200)]], [1000, 2000]);
  const first = await sampler.sample([1]);
  first.processes[0].cpuTimeMs = 99999;
  row.cpuTimeMs = 99999;
  assert.equal((await sampler.sample([1])).cpuPercent, 10);
});

// Patch only the built-in binding; never launch a real OS command in unit tests.
for (const platform of ['win32', 'linux', 'darwin']) {
  test(`collector uses asynchronous bounded metadata-only command on ${platform}`, async (t) => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform });
    t.after(() => {
      Object.defineProperty(process, 'platform', originalPlatform);
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    let fail = false;
    t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
      assert.equal(options.encoding, 'utf8');
      assert.ok(options.timeout > 0 && options.timeout <= 15000);
      assert.ok(options.maxBuffer > 0 && options.maxBuffer <= 8 * 1024 * 1024);
      assert.equal(options.windowsHide, true);
      assert.equal(options.shell, undefined);
      if (platform === 'win32') {
        assert.equal(file, 'powershell.exe');
        assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
        assert.match(args[3], /SELECT ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,CreationDate FROM Win32_Process/);
        assert.doesNotMatch(args[3], /CommandLine|ExecutablePath|Get-ChildItem|\$env:/i);
      } else {
        assert.equal(file, '/bin/ps');
        assert.deepEqual(args, ['-axo', 'pid=,ppid=,rss=,time=,lstart=']);
        assert.equal(options.env.LC_ALL, 'C');
      }
      queueMicrotask(() => callback(fail ? Object.assign(new Error('private stderr'), { code: 'ETIMEDOUT' }) : null,
        platform === 'win32' ? JSON.stringify([windowsRow]) : psRow));
    });
    syncBuiltinESMExports();
    assert.equal((await collectProcessSamples())[0].pid, 42);
    fail = true;
    await assert.rejects(collectProcessSamples(), error =>
      error.message === 'Process collection failed (ETIMEDOUT)');
  });
}
