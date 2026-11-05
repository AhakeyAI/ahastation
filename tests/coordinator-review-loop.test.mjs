// The Coordinator review used to be a single fire-and-forget briefing: nothing
// in production ever called onCoordinatorTurnEnded, so a Coordinator that read
// two chunks and moved on left the delivery — and everything depending on it —
// stalled forever. These tests pin the loop that now drives the review to a
// terminal state, and the tool gate that keeps the Coordinator on task.
//
// Run after `npm run build:electron`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Orchestrator } from '../dist-electron/orchestrator.js';
import { TaskWorkspaceManager } from '../dist-electron/task-workspace.js';
import { buildTalkerMcp } from '../dist-electron/meeting-mcp.js';

class FakeSession {
  constructor(options = {}) {
    this.options = options;
    this.started = false;
    this.ended = false;
    this.inputs = [];
    this.cwd = options.cwd;
  }
  start() { this.started = true; }
  sendUserText(text) { this.inputs.push(text); }
  sendUserContent() { /* no-op */ }
  resolvePermission() { /* no-op */ }
  async interrupt() { /* no-op */ }
  async setPermissionMode() { /* no-op */ }
  setAutoApprove() { /* no-op */ }
  end() { this.ended = true; }
  async terminateSessionTree() { this.ended = true; return { confirmed: true, pid: null }; }
  /** Simulate a provider turn boundary for this host. */
  endTurn() {
    this.options.emit?.({ kind: 'message', message: { type: 'result' } });
  }
  briefings() {
    return this.inputs.filter((text) => text.startsWith('(coordinator review)'));
  }
}

function createGitWorkspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'ahastation-review-loop-'));
  const git = (args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  git(['init']);
  git(['config', 'user.email', 'review-loop-test@ahastation.local']);
  git(['config', 'user.name', 'AhaStation review loop test']);
  git(['config', 'core.autocrlf', 'false']);
  writeFileSync(join(root, 'README.md'), '# review loop fixture\n');
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

test('an unfinished Coordinator turn re-briefs the review instead of stalling the delivery', async (t) => {
  const root = createGitWorkspace(t);
  const meetingId = `review-loop-${Date.now()}`;
  const sessions = [];
  const orch = new Orchestrator({
    emit: () => {},
    cwd: root,
    meetingId,
    reviewStallTimeoutMs: 0,
    workspaceManager: new TaskWorkspaceManager(meetingId, root, {
      worktreeRoot: join(root, '.task-worktrees'),
    }),
    sessionFactory: (options) => {
      const session = new FakeSession(options);
      sessions.push(session);
      return session;
    },
  });
  t.after(() => orch.end().catch(() => undefined));

  await orch.start();
  const coordinator = sessions[0];
  assert.ok(coordinator, 'coordinator host session was not created');

  assert.equal((await orch.installPlan([
    { id: 'a', title: 'A', prompt: 'do A', deps: [], writePaths: ['result.txt'] },
  ])).ok, true);
  const worker = await waitUntil(() => sessions[1], 'worker session was not created');

  writeFileSync(join(worker.cwd, 'result.txt'), 'finished with evidence\n');
  orch.submitWorkerReport('a', {
    status: 'completed',
    summary: 'finished with evidence',
    files: [{ path: 'result.txt', action: 'created' }],
    tests: [],
    unresolved: [],
  });

  const reviewer = await waitUntil(() => sessions.find(session => session.briefings().length), 'Reviewer never received a briefing');
  assert.notEqual(reviewer, coordinator);
  assert.equal(coordinator.briefings().length, 0);
  const first = JSON.parse(reviewer.briefings()[0].split('\n')[1]);
  assert.equal(first.status, 'active');
  assert.ok(first.uncoveredChunkIds.length > 0, 'briefing must name the chunks still owed a verdict');
  assert.match(first.nextAction, /submit_delivery_chunk_review/);

  assert.equal(orch.inspectDeliveryReview(first.reviewId).status, 'active');

  // The Coordinator ends its turn without covering anything: the delivery must
  // not be abandoned in `coordinator-reviewing`.
  reviewer.endTurn();
  reviewer.options.emit({ kind: 'turn-status', status: 'completed' });
  await waitUntil(
    () => reviewer.briefings().length >= 2,
    'an unfinished Coordinator turn did not re-brief the review',
  );
  assert.equal(orch.inspectDeliveryReview(first.reviewId).turnCount, 1);

  for (;;) {
    const chunk = orch.getDeliveryReviewChunk(first.reviewId);
    if (!chunk) break;
    await orch.submitDeliveryChunkReview(first.reviewId, {
      chunkId: chunk.id,
      chunkHash: chunk.hash,
      verdict: 'passed',
      findings: [],
    });
  }
  assert.equal(
    orch.inspectDeliveryReview(first.reviewId).turnCount,
    0,
    'covering a chunk must clear the stall counter',
  );
  await orch.completeDeliveryReview(first.reviewId);

  assert.equal(orch.inspectDeliveryReview(first.reviewId).status, 'completed');
  const settled = reviewer.briefings().length;
  reviewer.endTurn();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reviewer.briefings().length, settled, 'a completed review must stop re-briefing');
});

test('Codex portable Reviewer receives bound evidence and completes without blocking Host chat', async (t) => {
  const root = createGitWorkspace(t);
  const meetingId = `portable-review-${Date.now()}`;
  const sessions = [];
  const orch = new Orchestrator({
    emit() {}, cwd: root, meetingId, defaultBackendId: 'codex', reviewStallTimeoutMs: 0,
    workspaceManager: new TaskWorkspaceManager(meetingId, root, { worktreeRoot: join(root, '.task-worktrees') }),
    sessionFactory: options => { const session = new FakeSession(options); sessions.push(session); return session; },
  });
  t.after(() => orch.end());
  await orch.start();
  assert.equal((await orch.installPlan([{ id: 'portable', title: 'Portable', prompt: 'write result', deps: [], writePaths: ['result.txt'] }])).ok, true);
  const worker = await waitUntil(() => sessions[1]?.started && sessions[1], 'Worker startup');
  const hostTurnsBeforeProgress = sessions[0].inputs.length;
  for (let index = 0; index < 100; index++) {
    orch.schedulerOnWorkerEvent('portable', { kind: 'worker-signal', signal: { kind: 'progress', message: `update ${index}` } });
  }
  await orch.hostInbox.flush();
  assert.equal(sessions[0].inputs.length - hostTurnsBeforeProgress, 0, 'ordinary progress must not cause a Host turn');
  writeFileSync(join(worker.cwd, 'result.txt'), 'review-bound evidence\n');
  const summary = 'portable evidence ' + '核🧪'.repeat(4_000);
  orch.submitWorkerReport('portable', {
    status: 'completed', summary, files: [{ path: 'result.txt', action: 'created' }], tests: [], unresolved: [],
  });
  const reviewer = await waitUntil(() => sessions.find(session => session.briefings().length), 'Reviewer startup');
  const readContext = (options = {}) => orch.executeMeetingCommand('default', {
    kind: 'read-meeting-context', taskId: 'portable', ...options,
  });
  const firstPage = (await readContext()).value;
  assert.equal(firstPage.complete, false);
  const stale = await readContext({ cursor: firstPage.nextCursor, expectedHash: '0'.repeat(64) });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /version conflict/);
  let text = firstPage.text;
  for (let page = firstPage; page.nextCursor !== null;) {
    page = (await readContext({ cursor: page.nextCursor, expectedHash: firstPage.hash })).value;
    text += page.text;
  }
  assert.equal(JSON.parse(text).report.summary, summary);
  const { reviewId } = JSON.parse(reviewer.briefings()[0].split('\n')[1]);
  const command = reviewer.options.sessionOptions.meetingCommandHandler;
  await command({ kind: 'get_delivery_review_chunk', commandId: 'wrong-scope', reviewId: randomUUID() });
  await command({ kind: 'get_delivery_review_chunk', commandId: 'evidence', reviewId });
  reviewer.options.emit({ kind: 'turn-status', status: 'completed', turnId: 'turn-1' });
  await orch.sendUserText('new requirement during review');
  const discussion = await waitUntil(() => sessions[0].inputs.find(text => text.startsWith('new requirement during review')),
    'Host should still accept discussion');
  const context = JSON.parse(discussion.split('\n').at(-1));
  assert.ok(context.sourceCursor > 0);
  assert.equal(context.tasks.tasks[0].taskId, 'portable');
  const next = await waitUntil(() => reviewer.briefings()[1], 'command results were not returned');
  const results = JSON.parse(next.split('<meeting-command-results>\n')[1].split('\n</meeting-command-results>')[0]);
  assert.equal(results.find(item => item.commandId === 'wrong-scope').result.ok, false);
  assert.match(JSON.stringify(results.find(item => item.commandId === 'evidence')), /review-bound evidence/);
  reviewer.options.emit({ kind: 'turn-status', status: 'completed', turnId: 'turn-1' });
  assert.equal(orch.inspectDeliveryReview(reviewId).turnCount, 1, 'late duplicate must not charge the next turn');
  for (let chunk; (chunk = orch.getDeliveryReviewChunk(reviewId));) {
    await command({ kind: 'submit_delivery_chunk_review', commandId: chunk.id, reviewId, chunkId: chunk.id,
      chunkHash: chunk.hash, verdict: 'passed', findings: [] });
  }
  await command({ kind: 'complete_delivery_review', commandId: 'done', reviewId });
  assert.equal(orch.inspectDeliveryReview(reviewId).status, 'completed');
  assert.equal(reviewer.ended, true);
});

test('Claude MCP Host and Reviewer mount disjoint command surfaces and reject a stale review', async () => {
  const reviewId = randomUUID();
  let current = true;
  const calls = [];
  const host = buildTalkerMcp({}).instance;
  const reviewer = buildTalkerMcp({}, () => true, 'reviewer', () => current, reviewId, async (input) => {
    calls.push(input);
    return { ok: true, value: { chunk: 'bound evidence' } };
  }).instance;
  const list = async (server) => (await server.dispatch({ method: 'tools/list', id: 1 })).result.tools.map(t => t.name);
  assert.ok((await list(host)).includes('plan_meeting'));
  assert.ok(!(await list(host)).includes('get_delivery_review_chunk'));
  assert.ok(!(await list(reviewer)).includes('plan_meeting'));
  const read = (id) => reviewer.dispatch({
    method: 'tools/call', id: 2, params: { name: 'get_delivery_review_chunk', arguments: { reviewId: id } },
  });
  assert.equal((await read(randomUUID())).result.isError, true);
  assert.match((await read(reviewId)).result.content[0].text, /bound evidence/);
  current = false;
  assert.equal((await read(reviewId)).result.isError, true);
  assert.deepEqual(calls, [{ kind: 'get_delivery_review_chunk', reviewId }]);
});
