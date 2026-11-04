// Regression evidence for the 31fde4f review. No provider, model or personal homes.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexTerminalBackend } from '../dist-electron/backends/codex-terminal-adapter.js';
import { DeliveryHarness } from '../dist-electron/delivery-harness.js';
import { MeetingRepository } from '../dist-electron/meeting-repository.js';
import { Orchestrator } from '../dist-electron/orchestrator.js';
import { PtyHost } from '../dist-electron/pty-host.js';
import { TaskMailbox } from '../dist-electron/task-mailbox.js';
import { TaskWorkspaceManager } from '../dist-electron/task-workspace.js';
import { WorkerScheduler } from '../dist-electron/worker-scheduler.js';
import { testMeetingsPath } from './electron-stub-impl.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, message = 'condition timed out') {
  const deadline = Date.now() + 8_000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((done) => setTimeout(done, 20));
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function fakePty() {
  const exits = [];
  return {
    pid: 62000,
    killed: false,
    onData() { return { dispose() {} }; },
    onExit(cb) { exits.push(cb); return { dispose() {} }; },
    write() {}, resize() {},
    kill() {
      if (this.killed) return;
      this.killed = true;
      for (const cb of exits) cb({ exitCode: 0 });
    },
  };
}

async function fixture(t, { tree = false, record = async () => {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aha-native-review-'));
  const cwd = join(root, 'repo');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'hello.js'), 'export const greeting = "v0";\n');
  const git = (args) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Native Review Fixture']);
  git(['config', 'user.email', 'native-review@example.com']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', 'src/hello.js']);
  git(['commit', '-m', 'fixture']);
  const pidsFile = join(root, 'tree.json');
  const treeProgram = join(root, 'tree.mjs');
  writeFileSync(treeProgram, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
    `writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ rootPid: process.pid, childPid: child.pid }));`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const spawned = [];
  const host = new PtyHost({ osTreeKill: tree, spawn: (_file, _args, options) => {
    let pty;
    if (tree) {
      const child = spawn(process.execPath, [treeProgram], {
        cwd: options.cwd, env: options.env, windowsHide: true, stdio: 'ignore',
      });
      const exits = [];
      child.on('exit', (code) => { for (const cb of exits) cb({ exitCode: code ?? 0 }); });
      pty = {
        pid: child.pid,
        onData() { return { dispose() {} }; },
        onExit(cb) { exits.push(cb); return { dispose() {} }; },
        write() {}, resize() {}, kill() { child.kill(); },
      };
    } else pty = fakePty();
    spawned.push({ options, pty });
    return pty;
  } });
  const backend = new CodexTerminalBackend({ host, resolveBinary: () => process.execPath, timersEnabled: false });
  const meetingId = `native-review-${randomUUID()}`;
  const repository = new MeetingRepository(meetingId);
  const mailbox = new TaskMailbox(repository);
  const harness = new DeliveryHarness({
    executionMode: 'external',
    verifier: { verify: async () => ({ passed: true, checks: [] }) },
    reviewer: { review: async () => ({ passed: true, findings: [] }) },
    integrator: { integrate: async () => ({}) },
  });
  const events = [];
  let closed = false;
  const scheduler = new WorkerScheduler({
    cwd, meetingId, defaultBackendId: 'codex-terminal', maxConcurrentWorkers: 1,
    taskMailbox: mailbox, deliveryHarness: harness,
    workspaceManager: new TaskWorkspaceManager(meetingId, cwd, { worktreeRoot: join(root, 'worktrees') }),
    autoApproveScope: 'off',
    sessionFactory: (opts) => backend.createSession({
      cwd: opts.cwd, env: opts.envOverride, autoApproveScope: opts.autoApproveScope,
      executionRole: 'worker', extra: { workerId: opts.sessionOptions.workerId },
      taskProfile: opts.sessionOptions.taskProfile,
      nativeCliWorker: opts.sessionOptions.nativeCliWorker,
    }, opts.emit),
    emit: (event) => events.push(event),
    buildWorkerMcp: () => ({}), getTalker: () => null,
    isClosed: () => closed, getSpeechFilterMode: () => 'off',
    recordCustomEvent: async (kind, data) => { await repository.append(kind, data); await record(kind, data); },
    flushEvents: () => repository.flush(),
  });
  t.after(async () => {
    closed = true;
    // Only fixture-owned PIDs are touched; never kill by executable name.
    if (tree && existsSync(pidsFile)) {
      const { rootPid, childPid } = JSON.parse(readFileSync(pidsFile, 'utf8'));
      for (const pid of [childPid, rootPid]) {
        if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
    }
    scheduler.endAll();
    await scheduler.cliBridge.close();
    await repository.flush();
    await rm(testMeetingsPath(meetingId), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const task = (id = 'review-task', extra = {}) => ({
    id, title: id, prompt: 'fixture task', deps: [], executorBackendId: 'codex-terminal',
    workspaceMode: 'git-worktree', writePaths: ['src/hello.js'],
    acceptanceCriteria: [{ id: 'manual', description: 'fixture review', verification: { kind: 'manual' } }],
    ...extra,
  });
  const start = async (id = 'review-task') => {
    assert.deepEqual(scheduler.installPlan([task(id)]), { ok: true });
    await waitFor(() => scheduler.workers.get(id)?.status === 'running');
  };
  const postReport = (index = 0) => {
    const env = spawned[index].options.env;
    return fetch(`${env.AHASTATION_WORKER_URL}/worker/report`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.AHASTATION_WORKER_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'completed', summary: 'fixture report', files: [], tests: [], unresolved: [] }),
    });
  };
  return { root, cwd, host, scheduler, harness, mailbox, spawned, pidsFile, events, task, start, postReport };
}

for (const retry of [false, true]) {
  test(`report paused in durable logging is rejected after stop${retry ? ' and retry' : ''}`, async (t) => {
    const entered = deferred();
    const resume = deferred();
    t.after(() => resume.resolve());
    const f = await fixture(t, { record: async (kind) => {
      if (kind === 'native-worker-report-received') { entered.resolve(); await resume.promise; }
    } });
    await f.start();
    const oldDeliveryId = f.scheduler.workers.get('review-task').deliveryId;
    const response = f.postReport();
    await entered.promise;
    assert.deepEqual(await f.scheduler.interruptWorker('review-task', 'stop while logging'), { ok: true });
    if (retry) {
      await f.scheduler.queueFollowUp('review-task', 'explicit retry');
      await waitFor(() => f.spawned.length === 2 && f.scheduler.workers.get('review-task').status === 'running');
    }
    const handle = f.scheduler.workers.get('review-task');
    if (retry) assert.equal(handle.attempt, 2, 'new delivery preserves the task attempt instead of resetting it');
    const deliveryId = handle.deliveryId;
    resume.resolve();
    const result = await response;
    assert.equal(result.status, 409);
    assert.equal((await result.json()).code, 'stale-attempt');
    assert.equal(handle.report, null);
    assert.equal(handle.status, retry ? 'running' : 'interrupted');
    assert.equal(f.harness.snapshot(oldDeliveryId).attempts.length, 0);
    if (retry) assert.equal(f.harness.snapshot(deliveryId).attempts.length, 0, 'new delivery never receives old report');
  });
}

test('report is rejected while stop is still waiting for its durable mailbox entry', async (t) => {
  const f = await fixture(t);
  await f.start();
  const entered = deferred();
  const resume = deferred();
  t.after(() => resume.resolve());
  const enqueue = f.mailbox.enqueue.bind(f.mailbox);
  f.mailbox.enqueue = async (message) => {
    const entry = await enqueue(message);
    if (message.kind === 'interrupt') { entered.resolve(); await resume.promise; }
    return entry;
  };
  const stop = f.scheduler.interruptWorker('review-task', 'stop before report');
  await entered.promise;
  const response = await f.postReport();
  assert.equal(response.status, 409);
  resume.resolve();
  assert.deepEqual(await stop, { ok: true });
});

for (const acceptEarly of [false, true]) {
test(`normal receipt cleanup terminates a real hidden root and its background child${acceptEarly ? ' even during acceptance' : ''}`, async (t) => {
  const f = await fixture(t, { tree: true });
  await f.start();
  await waitFor(() => existsSync(f.pidsFile));
  const { rootPid, childPid } = JSON.parse(readFileSync(f.pidsFile, 'utf8'));
  assert.equal(alive(rootPid), true);
  assert.equal(alive(childPid), true);
  const response = await f.postReport();
  assert.equal(response.status, 200, await response.text());
  if (acceptEarly) {
    const handle = f.scheduler.workers.get('review-task');
    const candidate = f.harness.snapshot(handle.deliveryId).candidate;
    await f.scheduler.acceptDelivery(handle.deliveryId, candidate.id);
  }
  await waitFor(() => f.scheduler.workers.get('review-task').session === null, 'receipt must release the owned tree');
  assert.equal(alive(rootPid), false);
  assert.equal(alive(childPid), false, 'root-only end must never leave the background child alive');
  assert.equal(f.host.has('review-task'), false);
});
}

test('failed post-receipt tree cleanup retains owner and blocks reuse of its capacity', async (t) => {
  const f = await fixture(t);
  await f.start();
  const session = f.scheduler.workers.get('review-task').session;
  f.host.terminateTree = async () => { throw new Error('fixture descendant exit unconfirmed'); };
  assert.equal((await f.postReport()).status, 200);
  await waitFor(() => f.events.some((e) => String(e.event?.event?.payload?.message).includes('[stop-unconfirmed]')));
  assert.equal(f.scheduler.workers.get('review-task').session, session);
  assert.equal(f.host.has('review-task'), true);
  assert.equal(f.spawned[0].pty.killed, false);
  assert.deepEqual(f.scheduler.installPlan([f.task('next-task')]), { ok: true });
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(f.spawned.length, 1, 'unconfirmed process owner still holds its slot');
  assert.equal(f.scheduler.workers.get('next-task').status, 'pending');
});

test('native read-only plans and brainstorm kickoff are rejected before any session starts', async (t) => {
  const f = await fixture(t);
  const result = f.scheduler.installPlan([f.task('readonly-task', { workspaceMode: 'read-only', writePaths: [] })]);
  assert.equal(result.ok, false);
  assert.match(result.error, /unsupported-contract.*read-only/);
  for (const expertBackendId of ['codex', 'claude-code']) {
    const kickoff = await Orchestrator.prototype.startKickoff.call({ closed: false }, {
      mode: 'brainstorm', expertBackendId, profile: { title: '调研', name: 'fixture' },
    });
    assert.equal(kickoff.ok, false);
    assert.match(kickoff.error, /只读/);
  }
  assert.equal(f.spawned.length, 0);
  assert.equal(readFileSync(join(f.cwd, 'src', 'hello.js'), 'utf8'), 'export const greeting = "v0";\n');
});
