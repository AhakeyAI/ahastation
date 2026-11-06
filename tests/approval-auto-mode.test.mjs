import assert from 'node:assert/strict';
import test from 'node:test';

import { DeliveryHarness } from '../dist-electron/delivery-harness.js';

function harness(approvalMode, integrated) {
  return new DeliveryHarness({
    executionMode: 'external',
    approvalMode,
    verifier: { verify: async () => ({ passed: true, checks: ['ok'] }) },
    reviewer: { review: async () => ({ passed: true, findings: [] }) },
    integrator: { integrate: async () => { integrated.count += 1; return { kind: 'report-only' }; } },
  });
}

async function submit(h) {
  const proposal = await h.propose({
    meetingId: 'm',
    objective: 'explore',
    workspace: '/repo',
    sourceRevision: 'abc123',
    acceptanceCriteria: [{ id: 'manual', description: 'review', verification: { kind: 'manual' } }],
  });
  await h.decide(proposal.id, { kind: 'approve-spec', specVersion: 1 });
  return h.submitExternalReport(proposal.id, {
    status: 'completed', summary: 'done', files: [], tests: [], unresolved: [],
  });
}

test('auto approval accepts a verified report without a host decision', async () => {
  const integrated = { count: 0 };
  const view = await submit(harness('auto', integrated));
  assert.equal(view.status, 'accepted');
  assert.equal(view.integration?.kind, 'report-only');
});

test('manual approval still parks the report for the host', async () => {
  const view = await submit(harness('manual', { count: 0 }));
  assert.equal(view.status, 'awaiting-delivery-acceptance');
});
