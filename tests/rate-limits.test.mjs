import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MANUAL_REFETCH_MS,
  MIN_REFETCH_MS,
  RateLimitService,
  STALE_MS,
  mapClaudeWindow,
  mapCodexRateLimits,
  mapKimiUsage,
  parseResetTimestamp,
} from '../dist-electron/rate-limits.js';

test('Claude windows accept utilization or used_percentage and clamp to 0–100', () => {
  assert.deepEqual(mapClaudeWindow({ utilization: 42, resets_at: '2026-10-29T12:00:00Z' }, 300), {
    usedPercent: 42, windowMinutes: 300, resetsAt: Date.parse('2026-10-29T12:00:00Z'),
  });
  assert.equal(mapClaudeWindow({ used_percentage: 130 }, 10080).usedPercent, 100);
  assert.equal(mapClaudeWindow({}, 300), null);
  assert.equal(mapClaudeWindow(undefined, 300), null);
});

test('reset timestamps distinguish seconds from milliseconds', () => {
  assert.equal(parseResetTimestamp(1_800_000_000), 1_800_000_000_000);
  assert.equal(parseResetTimestamp(1_800_000_000_000), 1_800_000_000_000);
  assert.equal(parseResetTimestamp('1800000000'), 1_800_000_000_000);
  assert.equal(parseResetTimestamp(''), null);
  assert.equal(parseResetTimestamp('not a date'), null);
});

test('Codex windows are classified by duration, tolerating a one-minute drift', () => {
  const mapped = mapCodexRateLimits({
    primary: { usedPercent: 70, windowDurationMins: 10079, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_700_000_000 },
    planType: 'plus',
  });
  assert.equal(mapped.session.usedPercent, 12);
  assert.equal(mapped.weekly.usedPercent, 70);
  assert.equal(mapped.weekly.resetsAt, 1_800_000_000_000);
  assert.equal(mapped.planType, 'plus');
});

test('Codex windows with unknown durations keep primary=session, secondary=weekly', () => {
  const mapped = mapCodexRateLimits({ primary: { usedPercent: 5 }, secondary: { usedPercent: 9 } });
  assert.equal(mapped.session.usedPercent, 5);
  assert.equal(mapped.weekly.usedPercent, 9);
  assert.deepEqual(mapCodexRateLimits(null), { session: null, weekly: null, planType: null });
});

test('Kimi usage maps the top-level block to weekly and the closest-to-5h window to session', () => {
  const mapped = mapKimiUsage({
    usage: { limit: '100', remaining: '25' },
    limits: [
      { window: { duration: 60, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 10, used: 1 } },
      { window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: 50, used: 10, resetTime: '2026-10-29T12:00:00Z' } },
    ],
  });
  assert.equal(mapped.weekly.usedPercent, 75);
  assert.equal(mapped.session.usedPercent, 20);
  assert.equal(mapped.session.windowMinutes, 300);
  assert.equal(mapKimiUsage({}).session, null);
});

const ok = (provider, used, now) => ({
  provider, session: { usedPercent: used, windowMinutes: 300, resetsAt: null }, weekly: null,
  status: 'ok', error: null, updatedAt: now,
});
const failed = (provider) => ({ provider, session: null, weekly: null, status: 'error', error: '网络不可用', updatedAt: 0 });

test('a failed refresh keeps the cached windows as stale until STALE_MS, then drops them', async () => {
  let clock = 1_000_000;
  let next = 'ok';
  const svc = new RateLimitService(() => {}, {
    claude: async () => (next === 'ok' ? ok('claude', 30, clock) : failed('claude')),
  }, () => clock);

  await svc.refresh('poll');
  assert.equal(svc.snapshot().providers[0].status, 'ok');

  next = 'fail';
  clock += 60_000;
  await svc.refresh('poll');
  const stale = svc.snapshot().providers[0];
  assert.equal(stale.status, 'error');
  assert.equal(stale.session.usedPercent, 30);
  assert.equal(stale.error, '网络不可用');

  clock += STALE_MS + 1;
  await svc.refresh('poll');
  assert.equal(svc.snapshot().providers[0].session, null);
});

test('focus and manual refreshes are debounced; concurrent calls share one fetch', async () => {
  let clock = 5_000_000;
  let calls = 0;
  const svc = new RateLimitService(() => {}, {
    codex: async () => { calls += 1; return ok('codex', 10, clock); },
  }, () => clock);

  await Promise.all([svc.refresh('poll'), svc.refresh('manual')]);
  assert.equal(calls, 1);

  clock += MANUAL_REFETCH_MS - 1;
  await svc.refresh('manual');
  assert.equal(calls, 1);
  clock += 2;
  await svc.refresh('manual');
  assert.equal(calls, 2);

  clock += MIN_REFETCH_MS - 1;
  await svc.refresh('focus');
  assert.equal(calls, 2);
  clock += 2;
  await svc.refresh('focus');
  assert.equal(calls, 3);
});

test('a throwing fetcher degrades to an error row and never leaks the exception text', async () => {
  const svc = new RateLimitService(() => {}, {
    kimi: async () => { throw new Error('Bearer sk-secret leaked'); },
  });
  await svc.refresh('poll');
  const row = svc.snapshot().providers[0];
  assert.equal(row.status, 'error');
  assert.doesNotMatch(JSON.stringify(svc.snapshot()), /sk-secret/);
});
