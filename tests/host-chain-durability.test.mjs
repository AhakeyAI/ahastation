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

test('the current proposal survives restart and stale or duplicate approvals cannot install extra tasks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'host-plan-version-'));
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
  const orch = new Orchestrator(opts);
  meetings.push(orch);
  await orch.start();
  const task = id => ({ id, title: id, prompt: 'create output', deps: [], writePaths: ['output.txt'] });
  assert.equal((await orch.proposePlan([task('proposal-a')])).ok, true);
  assert.equal((await orch.proposePlan([task('proposal-b')])).ok, true);
  await orch.end();
  const journal = await MeetingRepository.replay(meetingId);
  const proposals = journal.filter(event => event.type === 'plan-proposal-v1').map(event => event.payload);
  const recovered = new Orchestrator({ ...opts, recoverySeq: journal.at(-1).seq });
  meetings.push(recovered);
  await recovered.start();
  const identity = ({ proposalId, proposalVersion }) => ({ proposalId, proposalVersion, approvalCommandId: randomUUID() });
  assert.match((await recovered.approvePendingPlan(true, [task('proposal-a')], undefined, identity(proposals[0]))).error, /version conflict/);
  assert.match((await recovered.approvePendingPlan(false, undefined, undefined, identity(proposals[0]))).error, /version conflict/);
  const approval = identity(proposals[1]);
  const [first, retry] = await Promise.all([
    recovered.approvePendingPlan(true, undefined, undefined, approval),
    recovered.approvePendingPlan(true, undefined, undefined, approval),
  ]);
  assert.deepEqual(first, { ok: true });
  assert.deepEqual(retry, first);
  assert.match((await recovered.approvePendingPlan(false, undefined, undefined, approval)).error, /command content conflict/);
  const entries = await MeetingRepository.replay(meetingId);
  const grants = entries.filter(event => event.type === 'plan-authority-approved');
  assert.equal(grants.length, 1);
  assert.deepEqual(grants[0].payload.tasks.map(task => task.taskId), ['proposal-b']);

  const commit = entries.find(event => event.type === 'plan-install-committed');
  assert.ok(commit);
  for (const committed of [false, true]) {
    const eventsAtCrash = entries.filter(event => event.seq <= (committed ? commit.seq : grants[0].seq));
    const runtime = new HostRuntime({
      cwd: root, emit() {}, autoApproveScope: 'none', getTalker: () => null,
      sessionFactory: () => assert.fail('replay must not launch a session'), buildWorkerMcp() {},
    }, new MeetingRepository(meetingId), () => {}, () => false);
    const tasksAtRecovery = [];
    runtime.restore(eventsAtCrash, tasksAtRecovery);
    if (committed) {
      assert.equal(runtime.pendingProposal, null);
      assert.deepEqual(tasksAtRecovery.map(task => [task.id, task.status, task.approvalDecisionId]),
        [['proposal-b', 'interrupted', approval.approvalCommandId]]);
    } else {
      assert.equal(runtime.pendingProposal.proposalId, proposals[1].proposalId);
      assert.deepEqual(tasksAtRecovery, []);
    }
    await runtime.scheduler.endAll();
  }
});
