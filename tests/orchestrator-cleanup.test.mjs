// Minimal coverage of the worker-resource-release paths added to fix the
// PTY/subprocess leak. The injected session models native tree-stop evidence
// without spawning a CLI subprocess.
//
// Run after `npm run build:electron`:
//   node --test tests/orchestrator-cleanup.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Orchestrator } from '../dist-electron/orchestrator.js';
import { MeetingRepository } from '../dist-electron/meeting-repository.js';
import { TaskWorkspaceManager } from '../dist-electron/task-workspace.js';

class FakeSession {
  constructor(options = {}) {
    this.started = false;
    this.ended = false;
    this.inputs = [];
    this.cwd = options.cwd;
  }
  start() { this.started = true; }
  sendUserText(text) { this.inputs.push({ kind: 'text', text }); }
  sendUserContent(content) { this.inputs.push({ kind: 'content', content }); }
  resolvePermission() { /* no-op */ }
  async interrupt() { /* no-op */ }
  async setPermissionMode() { /* no-op */ }
  setAutoApprove() { /* no-op */ }
  async terminateSessionTree() {
    this.ended = true;
    return { confirmed: true, pid: null };
  }
  end() { this.ended = true; }
}

function makeOrch(cwd, workspaceManager, meetingId) {
  const events = [];
  const sessions = [];
  const orch = new Orchestrator({
    emit: (e) => events.push(e),
    cwd,
    workspaceManager,
    meetingId,
    // No real Coordinator paces these tests, so wall-clock must never charge
    // the review turn budget (same convention as coordinator-review-loop).
    reviewStallTimeoutMs: 0,
    sessionFactory: (options) => {
      const s = new FakeSession(options);
      sessions.push(s);
      return s;
    },
  });
  return { orch, events, sessions };
}

function writableTask(id, deps = []) {
  return { id, title: id, prompt: 'do work', deps, workspaceMode: 'shared-locked', writePaths: [`${id}.txt`] };
}

function createGitWorkspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'ahastation-cleanup-git-'));
  const git = (args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  git(['init']);
  git(['config', 'user.email', 'cleanup-test@ahastation.local']);
  git(['config', 'user.name', 'AhaStation cleanup test']);
  git(['config', 'core.autocrlf', 'false']);
  writeFileSync(join(root, 'README.md'), '# cleanup fixture\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

async function waitUntil(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

test('legacy task_done cannot release a worker; reviewed WorkReport does', async (t) => {
  const root = createGitWorkspace(t);
  const meetingId = `cleanup-delivery-${Date.now()}`;
  const workspaceManager = new TaskWorkspaceManager(
    meetingId,
    root,
    { worktreeRoot: join(root, '.task-worktrees') },
  );
  const { orch, sessions, events } = makeOrch(root, workspaceManager, meetingId);
  // Start the Coordinator host before requesting reviews. Without a live
  // Coordinator session every review briefing lands on a null host and the
  // driver pauses the review for disconnect, racing the manual submit loop
  // below into 'review is paused' failures on slow runners.
  await orch.start();
  assert.equal(sessions.length, 1, 'coordinator host session created');
  const result = await orch.installPlan([
    { id: 'a', title: 'A', prompt: 'do A', deps: [], writePaths: ['result.txt'] },
  ]);
  assert.equal(result.ok, true);
  await waitUntil(() => sessions.length === 2, 'worker session was not created');
  const worker = sessions[1];
  assert.equal(worker.started, true);
  assert.equal(worker.ended, false, 'session live during task');

  // Legacy completion is only a note. It cannot bypass verification/review.
  orch.markWorkerTaskDone('a', 'finished');
  assert.equal(worker.ended, false, 'task_done cannot release the session');

  writeFileSync(join(worker.cwd, 'result.txt'), 'finished with evidence\n');
  orch.submitWorkerReport('a', {
    status: 'completed',
    summary: 'finished with evidence',
    files: [{ path: 'result.txt', action: 'created' }],
    tests: [],
    unresolved: [],
  });
  const review = await waitUntil(
    async () => {
      const journal = await MeetingRepository.replay(meetingId);
      return journal
        .filter((event) => event.type === 'coordinator-review-requested')
        .map((event) => event.payload?.data?.session)
        .at(-1);
    },
    'delivery did not reach Coordinator review',
  );
  // The scheduler releases the Backend session as soon as a WorkReport enters
  // verification (freeing the concurrency slot during review/acceptance), so by
  // the time Coordinator review opens the session is already ended. Legacy
  // task_done above must NOT have ended it; the reviewed WorkReport did.
  assert.equal(worker.ended, true, 'a reviewed WorkReport releases the Backend session for verification/review');
  for (;;) {
    if (orch.inspectDeliveryReview(review.id)?.status === 'paused') {
      await orch.coordinatorReviewDriver.resume(review.id);
    }
    const chunk = orch.getDeliveryReviewChunk(review.id);
    if (!chunk) break;
    await orch.submitDeliveryChunkReview(review.id, {
      chunkId: chunk.id,
      chunkHash: chunk.hash,
      verdict: 'passed',
      findings: [],
    });
  }
  await orch.completeDeliveryReview(review.id);
  await waitUntil(
    () => events.some((entry) => (
      entry.event?.kind === 'worker-ended'
      && entry.event.workerId === 'a'
      && entry.event.status === 'accepted'
    )),
    'reviewed delivery did not become durably accepted',
  );
  assert.equal(worker.ended, true, 'accepted delivery releases the session');
  await orch.end();
});

test('premature session end (no task_done) cleans up + cascades', async (t) => {
  const { orch, sessions, events } = makeOrch(createGitWorkspace(t));
  await orch.installPlan([
    writableTask('a'),
    writableTask('b', ['a']),
  ]);
  await waitUntil(() => sessions.length === 1, 'first dependency worker was not created');
  assert.equal(sessions.length, 1, 'only A is spawned initially (B blocked on dep)');

  // Simulate the Worker transport ending before delivery
  // (e.g. crash, network drop, or user cancel mid-flight).
  orch.schedulerOnWorkerEvent('a', { kind: 'ended' });
  await waitUntil(
    () => events.filter((e) => e.event?.kind === 'worker-ended' && e.event.status === 'failed').length >= 2,
    'failure did not cascade',
  );

  await waitUntil(() => sessions[0].ended, 'A native session was not terminated');

  // B should now be marked failed and never spawn.
  const failedEvents = events.filter(
    (e) => e.event && e.event.kind === 'worker-ended' && e.event.status === 'failed',
  );
  const failedIds = failedEvents.map((e) => e.event.workerId).sort();
  assert.deepEqual(failedIds, ['a', 'b'], 'A failed, B cascaded to failed');
  assert.equal(sessions.length, 1, 'B never spawned a session');
  await orch.end();
});

test('end() tears down every live worker', async (t) => {
  const { orch, sessions } = makeOrch(createGitWorkspace(t));
  await orch.installPlan([
    writableTask('a'),
    writableTask('b'),
  ]);
  await waitUntil(() => sessions.length === 2, 'parallel workers were not created');
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((s) => s.ended === false));

  await orch.end();
  await waitUntil(() => sessions.every((s) => s.ended), 'native cleanup did not complete');

  assert.ok(
    sessions.every((s) => s.ended === true),
    'all live worker sessions ended on orchestrator.end()',
  );
});

test('disposeWorker is idempotent (double end() does not throw)', async (t) => {
  const { orch, sessions } = makeOrch(createGitWorkspace(t));
  await orch.installPlan([writableTask('a')]);
  await waitUntil(() => sessions.length === 1, 'worker session was not created');
  orch.schedulerOnWorkerEvent('a', {
    kind: 'worker-signal',
    signal: {
      kind: 'failed',
      code: 'fixture-failure',
      message: 'first',
      retryable: false,
    },
  });
  await waitUntil(() => sessions[0].ended, 'failed worker was not disposed');
  // Re-firing an end event after terminal cleanup is a no-op.
  assert.doesNotThrow(() => orch.schedulerOnWorkerEvent('a', { kind: 'ended' }));
  assert.equal(sessions[0].ended, true);
  await orch.end();
});

test('worker receives its first task only after backend readiness resolves', async (t) => {
  let releaseReady;
  const ready = new Promise((resolve) => { releaseReady = resolve; });
  const sessions = [];
  const orch = new Orchestrator({
    emit() {},
    cwd: createGitWorkspace(t),
    sessionFactory: () => {
      const session = new FakeSession();
      session.start = () => ready.then(() => { session.started = true; });
      sessions.push(session);
      return session;
    },
  });

  await orch.installPlan([writableTask('ready-gate')]);
  await waitUntil(() => sessions.length === 1, 'worker session was not created');
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].inputs, [], 'task is not sent during backend handshake');

  releaseReady();
  await waitUntil(() => sessions[0].inputs.length > 0, 'worker did not receive the task after readiness');
  assert.match(sessions[0].inputs[0]?.text ?? '', /^## Task\ndo work/);
  assert.match(sessions[0].inputs[0]?.text ?? '', /## Frozen visible context/);
  await orch.end();
});
