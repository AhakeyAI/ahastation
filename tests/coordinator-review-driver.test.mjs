// These tests exercise the manual approval flow.
process.env.AHASTATION_APPROVAL_MODE = 'manual';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  CoordinatorReviewDriver,
} from '../dist-electron/coordinator-review-driver.js';
import { DeliveryHarness } from '../dist-electron/delivery-harness.js';

import candidate from './fixtures/coordinator-review-candidate.json' with { type: 'json' };

/** Two-chunk candidate so stall accounting can be observed across partial coverage. */
function twoChunkCandidate() {
  const frozen = structuredClone(candidate);
  frozen.manifest.chunks = [
    structuredClone(candidate.manifest.chunks[0]),
    {
      ...structuredClone(candidate.manifest.chunks[0]),
      id: 'fixture-chunk-2',
      index: 1,
      path: 'src/other.ts',
      hash: '2'.repeat(64),
    },
  ];
  return frozen;
}

function makeDriver(maxTurns = 3) {
  const calls = [];
  const completed = [];
  const reworks = [];
  const paused = [];
  const driver = new CoordinatorReviewDriver({
    onPaused: async (session) => {
      paused.push(session);
    },
    maxTurns,
    now: (() => {
      let value = 100;
      return () => ++value;
    })(),
    id: () => 'review-driver-1',
    append: async (type, payload) => {
      calls.push({ kind: 'append', type, payload });
    },
    flush: async () => {
      calls.push({ kind: 'flush' });
    },
    notifyCoordinator: async (briefing) => {
      calls.push({ kind: 'notify', briefing });
    },
    onCompleted: async (session) => {
      completed.push(session);
    },
    onReworkRequested: async (session) => {
      reworks.push(session);
    },
  });
  return { driver, calls, completed, reworks, paused };
}

test('review completion is idempotent and calls the completion owner once', async () => {
  const { driver, completed } = makeDriver();
  const session = await driver.request({
    candidate,
    verification: { passed: true, checks: [] },
  });
  await driver.submitChunkReview(session.id, {
    chunkId: 'fixture-chunk-1',
    chunkHash: candidate.manifest.chunks[0].hash,
    verdict: 'passed',
    findings: [],
  });
  const first = await driver.complete(session.id);
  const second = await driver.complete(session.id);
  assert.equal(first.reviewHash, second.reviewHash);
  assert.equal(completed.length, 1);
});

test('snapshot and restore preserve exact chunk coverage and confirmations', async () => {
  const { driver } = makeDriver();
  const session = await driver.request({
    candidate,
    verification: { passed: true, checks: [] },
  });
  await driver.submitChunkReview(session.id, {
    chunkId: 'fixture-chunk-1',
    chunkHash: candidate.manifest.chunks[0].hash,
    verdict: 'passed',
    findings: [],
  });
  const snapshots = driver.snapshot();
  const restored = makeDriver().driver;
  for (const snapshot of snapshots) restored.restore(snapshot);
  assert.deepEqual(restored.snapshot(), snapshots);
  assert.equal(restored.inspect(session.id).coverage.complete, true);
});

function hashJson(value) {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
