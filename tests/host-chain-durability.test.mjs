import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { HostInbox } from '../dist-electron/host/inbox.js';
import { HostRuntime } from '../dist-electron/host/runtime.js';
import { MeetingRepository } from '../dist-electron/meeting-repository.js';
import { Orchestrator } from '../dist-electron/orchestrator.js';
import { normalizeMeetingPlanBrief, normalizePlanMeetingTasks } from '../dist-electron/meeting-tools.js';
import { createHash } from 'node:crypto';
import { buildTalkerMcp } from '../dist-electron/meeting-mcp.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function planFixture(journal = []) {
  const append = async (type, payload) => {
    const event = { id: randomUUID(), seq: journal.length + 1, ts: Date.now(), type, payload: structuredClone(payload) };
    journal.push(event);
    return event;
  };
  const emit = event => { if (event.event.kind === 'plan-updated') void append('event:plan-updated', event); };
  const runtime = new HostRuntime({
    cwd: tmpdir(), emit, autoApproveScope: 'none', getTalker: () => null, isClosed: () => false,
    sessionFactory: () => assert.fail('recovery must not launch a Worker'), buildWorkerMcp() {},
  }, { append }, emit, () => false);
  runtime.scheduler.spawnReadyWorkers = () => {};
  const tasks = normalizePlanMeetingTasks([
    { id: 'resume', title: 'Resume', prompt: 'write a result', deps: [], writePaths: ['result.txt'] },
  ], 'claude-code', { cwd: tmpdir(), baselineKind: 'git-dirty', nativeCliWorkers: true }).tasks;
  const brief = normalizeMeetingPlanBrief(undefined, tasks);
  const draft = { id: 'draft-event', seq: 1, type: 'plan-proposal-v1', payload: {
    schemaVersion: 1, proposalId: 'draft', proposalVersion: 1, basePlanVersion: 0,
    tasks, brief, contentHash: digest({ normalized: tasks, brief }),
  } };
  return { runtime, journal, tasks, brief, draft };
}

test('commit without plan projection restores idempotency and never queues a duplicate', async t => {
  const f = planFixture();
  t.after(() => f.runtime.scheduler.endAll());
  await f.runtime.install(f.tasks, 'host-request');
  const recovered = planFixture(f.journal.filter(e => e.type !== 'event:plan-updated'));
  t.after(() => recovered.runtime.scheduler.endAll());
  recovered.runtime.restore(recovered.journal, []);
  assert.deepEqual(await recovered.runtime.install(f.tasks, 'host-request'), { ok: true });
  assert.deepEqual(recovered.runtime.scheduler.snapshot().map(task => [task.id, task.status]), [['resume', 'interrupted']]);
  assert.equal(recovered.journal.filter(e => e.type === 'plan-install-committed').length, 1);
});

test('resumed draft resolution survives commit-only recovery; uncommitted grants preserve the draft', async t => {
  const f = planFixture();
  t.after(() => f.runtime.scheduler.endAll());
  f.journal.push(f.draft);
  f.runtime.restore(f.journal, []);
  await f.runtime.install(f.tasks, 'host-request', f.brief);
  for (const committed of [false, true]) {
    const journal = f.journal.filter(e => e.type !== 'event:plan-updated' && (committed || e.type !== 'plan-install-committed'));
    const recovered = planFixture(journal);
    t.after(() => recovered.runtime.scheduler.endAll());
    recovered.runtime.restore(journal, []);
    assert.equal(recovered.runtime.retainedProposal?.proposalId ?? null, committed ? null : 'draft');
    assert.equal(recovered.runtime.scheduler.snapshot().length, committed ? 1 : 0);
  }
});

test('approval-era flat proposal identity resolves only with a matching installation commit', async t => {
  const f = planFixture();
  t.after(() => f.runtime.scheduler.endAll());
  await f.runtime.install(f.tasks, 'host-request');
  const grant = f.journal.find(e => e.type === 'plan-authority-approved');
  Object.assign(grant.payload, { schemaVersion: 1, source: 'plan-meeting-confirmation', proposalId: 'draft', approvalCommandId: grant.payload.decisionId });
  for (const committed of [false, true]) {
    const journal = [f.draft, ...f.journal.filter(e => e.type !== 'event:plan-updated' && (committed || e.type !== 'plan-install-committed'))];
    const recovered = planFixture(journal);
    t.after(() => recovered.runtime.scheduler.endAll());
    recovered.runtime.restore(journal, []);
    assert.equal(recovered.runtime.retainedProposal?.proposalId ?? null, committed ? null : 'draft');
  }
});

test('delegate MCP retries keep their task identity, while new calls and changed content remain distinct', async t => {
  const orch = new Orchestrator({ cwd: tmpdir(), emit() {} });
  t.after(() => orch.end());
  // Keep the production delegation path, bypass readiness without calling an account.
  orch.validateExecutionBackends = async () => null;
  orch.hostRuntime.scheduler.spawnReadyWorkers = () => {};
  const server = buildTalkerMcp(orch).instance;
  const call = (id, description = 'write a result') => server.dispatch({ jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'delegate_task', arguments: { description, writePaths: ['result.txt'] } } });
  const [first, retried] = await Promise.all([call(1), call(1)]);
  assert.deepEqual(first, retried);
  assert.equal(orch.hostRuntime.scheduler.snapshot().length, 1);
  await call(2); // Intentional new call with identical content.
  assert.equal(orch.hostRuntime.scheduler.snapshot().length, 2);
  assert.deepEqual(await call(1), first); // A retry also works after another install.
  const conflict = await call(1, 'write something different');
  assert.match(conflict.result.content[0].text, /identity reused/);
  const journal = await orch.replayMeetingJournal();
  const recovered = planFixture(journal);
  t.after(() => recovered.runtime.scheduler.endAll());
  recovered.runtime.restore(journal, []);
  const grant = journal.find(e => e.type === 'plan-authority-approved');
  assert.deepEqual(await recovered.runtime.install(grant.payload.normalizedTasks, 'host-request', undefined, undefined, grant.payload.requestId), { ok: true });
  assert.equal(recovered.runtime.scheduler.snapshot().length, 2);
});

test('Host acceptance survives disconnection, lost reply and restart without replaying uncertain sends', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'host-inbox-recovery-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const meetingId = randomUUID();
  const repository = new MeetingRepository(meetingId, 0, { rootDir });
  let online = false;
  const sends = [];
  const inbox = new HostInbox(repository, () => online ? input => {
    sends.push(input.text);
    if (input.inputId === 'uncertain') throw new Error('transport disconnected');
    return true;
  } : undefined, () => {}, () => {});
  const route = () => ({ hostId: 'default', direct: false });
  const [a, b] = await Promise.all([
    inbox.receive('duplicate', '完整正文 🧪', route),
    inbox.receive('duplicate', '完整正文 🧪', route),
  ]);
  assert.deepEqual(a, b);
  assert.equal(a.state, 'queued');
  assert.deepEqual(sends, []);
  await assert.rejects(inbox.receive('duplicate', 'different content', route), /conflict/);
  await inbox.receive('uncertain', 'possible side effect', route);
  online = true;
  inbox.wake('default');
  await inbox.flush();
  assert.deepEqual(sends, ['完整正文 🧪', 'possible side effect']);
  const recovered = new HostInbox(repository, () => () => assert.fail('replayed a submitted or uncertain input'), () => {}, assert.fail);
  assert.equal((await recovered.read('duplicate')).text, '完整正文 🧪');
  assert.equal((await recovered.read('duplicate')).state, 'submitted');
  assert.equal((await recovered.read('uncertain')).state, 'uncertain');
  recovered.wake('default');
  await recovered.flush();
});

test('a journal write failure rejects Host acceptance before any send', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'host-inbox-write-fault-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const repository = new MeetingRepository(randomUUID(), 0, { rootDir });
  const inbox = new HostInbox(repository, () => () => assert.fail('send on disk failure'), () => {}, () => {});
  await inbox.read('ready');
  repository.append = async () => { throw new Error('fixture disk fault'); };
  await assert.rejects(inbox.receive('failed', 'input body', () => ({ hostId: 'default', direct: false })), /disk fault/);
  assert.equal(await inbox.read('failed'), undefined);
});

test('a torn journal line cannot swallow the next durable Host input', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'host-inbox-torn-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const meetingId = randomUUID();
  const repository = new MeetingRepository(meetingId, 0, { rootDir });
  await repository.append('meeting-created', { cwd: rootDir });
  await appendFile(join(rootDir, 'events.jsonl'), '{"type":"host-input-act');
  const reopened = new MeetingRepository(meetingId, 1, { rootDir });
  const inbox = new HostInbox(reopened, () => undefined, () => {}, assert.fail);
  await inbox.receive('after-crash', '完整正文', () => ({ hostId: 'default', direct: false }));
  const diagnostics = [];
  const journal = await MeetingRepository.replay(meetingId, rootDir, issue => diagnostics.push(issue));
  assert.deepEqual(journal.map(event => event.type), ['meeting-created', 'host-input-received']);
  assert.equal(journal[1].payload.text, '完整正文');
  assert.equal(diagnostics.length, 1);
});

test('ambiguous Host input survives restart and only the selected Host receives it', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'host-input-route-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const meetingId = randomUUID();
  const repository = new MeetingRepository(meetingId, 0, { rootDir });
  const sent = [];
  const makeInbox = () => new HostInbox(repository, hostId => input => {
    sent.push([hostId, input.text]); return true;
  }, () => {}, assert.fail);
  const receipt = await makeInbox().receive('ambiguous', 'ambiguous instruction',
    () => ({ hostId: 'default', direct: false, targetChoices: ['first', 'second'] }));
  assert.equal(receipt.state, 'awaiting-target');
  const restored = makeInbox();
  assert.deepEqual((await restored.read('ambiguous')).targetChoices, ['first', 'second']);
  await assert.rejects(restored.assignTarget('ambiguous', 'outside', () => true), /unavailable/);
  await restored.assignTarget('ambiguous', 'second', () => true);
  await restored.flush();
  assert.deepEqual(sent, [['second', 'ambiguous instruction']]);
  await assert.rejects(restored.assignTarget('ambiguous', 'first', () => true), /confirmed/);
});

test('cancelled user input stays cancelled and an unsent question follows the new Coordinator', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'host-input-controls-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const repository = new MeetingRepository(randomUUID(), 0, { rootDir });
  const sent = [];
  const before = new HostInbox(repository, () => undefined, () => {}, assert.fail);
  const target = (hostId) => () => ({ hostId, direct: false });
  await before.receive('cancel-me', 'user draft', target('previous'));
  await before.receive('worker-question-one', 'durable question', target('previous'), undefined, 'worker-question');
  assert.equal((await before.cancel('cancel-me')).state, 'cancelled');
  await assert.rejects(before.cancel('worker-question-one'), /unavailable/);
  await before.receive('worker-question-one', 'durable question', target('current'), undefined, 'worker-question');

  const after = new HostInbox(repository, (hostId) => (input) => {
    sent.push([hostId, input.text]);
    return true;
  }, () => {}, assert.fail);
  assert.equal((await after.read('cancel-me')).state, 'cancelled');
  assert.equal((await after.cancel('cancel-me')).state, 'cancelled');
  after.wake('previous');
  after.wake('current');
  await after.flush();
  assert.deepEqual(sent, [['current', 'durable question']]);
});

test('direct plan installs are durable and idempotent, while approval-era drafts stay inert', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'host-plan-direct-'));
  const meetingId = randomUUID();
  const originalPath = app.getPath;
  const meetings = [];
  app.getPath = () => root;
  t.after(async () => {
    try {
      await Promise.all(meetings.map((meeting) => meeting.end()));
    } finally {
      app.getPath = originalPath;
      await rm(root, { recursive: true, force: true });
    }
  });
  const events = [];
  const opts = {
    cwd: root, meetingId, emit: event => events.push(event.event),
    sessionFactory: () => ({
      async start() {}, end() {}, sendUserText() {}, sendUserContent() {}, resolvePermission() {}, async interrupt() {},
    }),
  };
  const task = id => ({ id, title: id, prompt: 'create output', deps: [], writePaths: ['output.txt'] });
  const orch = new Orchestrator(opts);
  meetings.push(orch);
  await orch.start();
  assert.deepEqual(await orch.proposePlan([task('direct-a')]), { ok: true, status: 'installed' });
  assert.deepEqual(await orch.proposePlan([task('direct-b')]), { ok: true, status: 'installed' });
  const installedJournal = await MeetingRepository.replay(meetingId);
  assert.deepEqual(
    installedJournal.filter(event => event.type === 'plan-authority-approved').map(event => event.payload.source),
    ['host-request', 'host-request'],
  );
  // A retransmitted request cannot install a duplicate task.
  assert.deepEqual(await orch.proposePlan([task('direct-b')]), { ok: true, status: 'installed' });
  const retriedJournal = await MeetingRepository.replay(meetingId);
  assert.equal(retriedJournal.filter(event => event.type === 'plan-authority-approved').length, 2);
  assert.deepEqual(
    retriedJournal.filter(event => event.type === 'plan-install-committed').at(-1).payload.taskIds,
    ['direct-b'],
  );
  await orch.end();

  const recovered = new Orchestrator({ ...opts, recoverySeq: retriedJournal.at(-1).seq });
  meetings.push(recovered);
  await recovered.start();
  const recoveredPlan = (await recovered.replayMeetingJournal())
    .filter(event => event.type === 'event:plan-updated').at(-1).payload.event.plan;
  assert.deepEqual(recoveredPlan.nodes.map(node => node.id).sort(), ['direct-a', 'direct-b']);
  assert.equal(events.some(event => event.kind === 'plan-draft-retained'), false);
  await recovered.end();

  // Crash between grant and commit: no installed task and no idempotency token.
  const normalized = normalizePlanMeetingTasks(
    [task('crash-task')], 'claude-code', { cwd: root, baselineKind: 'git-dirty', nativeCliWorkers: true },
  ).tasks;
  const crashRepository = new MeetingRepository(meetingId);
  const crashRuntime = new HostRuntime({
    cwd: root, emit() {}, autoApproveScope: 'none', getTalker: () => null, isClosed: () => false,
    sessionFactory: () => ({
      async start() {}, end() {}, sendUserText() {}, sendUserContent() {}, resolvePermission() {}, async interrupt() {},
    }), buildWorkerMcp() {},
  }, crashRepository, () => {}, () => false);
  const requestHash = (await import('node:crypto')).createHash('sha256')
    .update(JSON.stringify(normalized)).digest('hex');
  crashRuntime.restore([{
    id: randomUUID(), seq: 1, ts: Date.now(), type: 'plan-authority-approved',
    payload: {
      schemaVersion: 2, decisionId: 'grant-without-commit', approvedAt: Date.now(),
      source: 'host-request', requestHash, planVersion: 1, normalizedTasks: normalized, tasks: [],
    },
  }], []);
  assert.deepEqual(crashRuntime.scheduler.snapshot(), []);
  assert.deepEqual(await crashRuntime.install(normalized, 'host-request'), { ok: true });
  assert.deepEqual(crashRuntime.scheduler.snapshot().map(entry => entry.id), ['crash-task']);
  await crashRuntime.scheduler.endAll();

  // Approval-era drafts are readable but a restart must not execute them.
  const { tasks: legacyTasks } = normalizePlanMeetingTasks(
    [{ id: 'legacy-draft', title: 'Legacy draft', prompt: 'write the old plan', deps: [], writePaths: ['legacy.txt'] }],
    'claude-code', { cwd: root, baselineKind: 'git-dirty', nativeCliWorkers: true },
  );
  const brief = normalizeMeetingPlanBrief({ goal: 'legacy goal', steps: [], risks: [], openQuestions: [] }, legacyTasks);
  const proposalId = randomUUID();
  const contentHash = (await import('node:crypto')).createHash('sha256')
    .update(JSON.stringify({ normalized: legacyTasks, brief })).digest('hex');
  const emitted = [];
  const draftRepository = new MeetingRepository(meetingId);
  const draftRuntime = new HostRuntime({
    cwd: root, emit() {}, autoApproveScope: 'none', getTalker: () => null, isClosed: () => false,
    sessionFactory: () => assert.fail('a retained draft must not launch a session'), buildWorkerMcp() {},
  }, draftRepository, event => emitted.push(event.event), () => false);
  const recoveredTasks = [];
  draftRuntime.restore([{
    id: randomUUID(), seq: 1, ts: Date.now(), type: 'plan-proposal-v1',
    payload: {
      schemaVersion: 1, proposalId, proposalVersion: 1, basePlanVersion: 0, contentHash,
      tasks: legacyTasks, brief,
    },
  }], recoveredTasks);
  assert.deepEqual(recoveredTasks, []);
  assert.equal(draftRuntime.retainedProposal.proposalId, proposalId);
  draftRuntime.publishPlanState();
  assert.deepEqual(emitted.map(event => event.kind), ['plan-draft-retained']);
  assert.equal(emitted[0].tasks[0].id, 'legacy-draft');
  await draftRuntime.scheduler.endAll();

  // A legacy confirmation already installed that draft; it is not offered again.
  const resolvedRuntime = new HostRuntime({
    cwd: root, emit() {}, autoApproveScope: 'none', getTalker: () => null, isClosed: () => false,
    sessionFactory: () => assert.fail('a resolved legacy draft must not launch a session'), buildWorkerMcp() {},
  }, new MeetingRepository(meetingId), () => {}, () => false);
  resolvedRuntime.restore([
    {
      id: 'legacy-proposal-event', seq: 1, ts: Date.now(), type: 'plan-proposed',
      payload: { tasks: legacyTasks, brief },
    },
    {
      id: 'legacy-confirmation', seq: 2, ts: Date.now(), type: 'plan-approval-result',
      payload: { source: 'plan-meeting-confirmation' },
    },
  ], []);
  assert.equal(resolvedRuntime.retainedProposal, null);
  await resolvedRuntime.scheduler.endAll();
});
