import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkerScheduler } from '../dist-electron/worker-scheduler.js';
import { MeetingRepository } from '../dist-electron/meeting-repository.js';
import { TaskMailbox } from '../dist-electron/task-mailbox.js';
import { TaskWorkspaceManager } from '../dist-electron/task-workspace.js';
import { DeliveryHarness } from '../dist-electron/delivery-harness.js';
import { runWorkerCli } from '../dist-electron/worker-cli.js';
import { WorkerCliBridge } from '../dist-electron/worker-cli-bridge.js';
import { TerminalCliSession } from '../dist-electron/backends/terminal-cli-adapter.js';
import { PtyHost } from '../dist-electron/pty-host.js';
import { prepareFrozenDeliveryCandidate } from '../dist-electron/delivery-candidate.js';
import { CoordinatorReviewDriver } from '../dist-electron/coordinator-review-driver.js';

const execute = promisify(execFile);
async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for worker');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('two terminal routes use a real CLI bridge, durable questions and exact code reports', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aha 双 CLI '));
  const repo = join(root, 'repo');
  await mkdir(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8' });
  git('init');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'base');
  const repository = new MeetingRepository('cli-test', 0, { rootDir: join(root, 'journal') });
  const mailbox = new TaskMailbox(repository);
  const sessions = [];
  const reports = [];
  const coordinator = [];
  const events = [];
  const reviewDriver = new CoordinatorReviewDriver({
    append: (type, payload) => repository.append(type, payload),
    flush: () => repository.flush(), notifyCoordinator() {},
  });
  const harness = new DeliveryHarness({
    executionMode: 'external',
    verifier: { async verify(_order, report) { reports.push(report); return { passed: true, checks: [] }; } },
    reviewer: { async review() { return { passed: true, findings: [] }; } },
    candidatePreparer: { prepare: (order, report, verification) => prepareFrozenDeliveryCandidate({ order, report, verification }) },
    reviewDriver,
    integrator: { async integrate() { throw new Error('User has not accepted'); } },
  });
  const scheduler = new WorkerScheduler({
    cwd: repo, meetingId: 'cli-test', autoApproveScope: 'off',
    taskMailbox: mailbox, deliveryHarness: harness,
    workspaceManager: new TaskWorkspaceManager('cli-test', repo, { worktreeRoot: join(root, 'worktrees') }),
    sessionFactory() { throw new Error('Must use the selected backend'); },
    resolveSessionFactory(backendId) {
      return (opts) => {
        const session = { backendId, opts, inputs: [],
          async start() {}, sendUserText(text) { this.inputs.push(text); },
          sendUserContent() {}, resolvePermission() {}, async interrupt() {}, end() {},
        };
        sessions.push(session);
        return session;
      };
    },
    emit(event) { events.push(event); },
    buildWorkerMcp() { return {}; },
    getTalker() { return { sendUserText(text) { coordinator.push(text); } }; },
    isClosed() { return false; }, getSpeechFilterMode() { return 'strict'; },
    flushEvents: () => repository.flush(),
  });
  t.after(async () => {
    scheduler.endAll();
    await repository.flush();
    await rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(scheduler.installPlan([
    { id: 'a', title: 'Codex', prompt: 'implement a', deps: [], executorBackendId: 'codex-terminal', workspaceMode: 'git-worktree', writePaths: ['a 文件.txt'] },
    { id: 'b', title: 'Qoder', prompt: 'implement b', deps: [], executorBackendId: 'qoder-terminal', workspaceMode: 'git-worktree', writePaths: ['b 文件.txt'] },
  ]), { ok: true });
  await waitFor(() => sessions.length === 2 && sessions.every((s) => s.inputs.length)).catch((error) => {
    throw new Error(`${error.message}: ${JSON.stringify(events.slice(-4))}`);
  });
  assert.deepEqual(sessions.map((s) => s.backendId).sort(), ['codex-terminal', 'qoder-terminal']);
  assert.notEqual(sessions[0].opts.cwd, sessions[1].opts.cwd);
  const first = sessions.find((s) => s.backendId === 'codex-terminal');
  const env = { ...process.env, ...first.opts.envOverride };
  const questionFile = join(root, '问题.json');
  await writeFile(questionFile, JSON.stringify({ question: 'Which output format?' }));
  const question = await runWorkerCli(['ask', '--file', questionFile], env);
  assert.equal(question.kind, 'question');
  assert.ok(coordinator.some((text) => text.includes('Which output format?')));
  await scheduler.queueFollowUp('a', 'Use plain text');
  const inbox = await runWorkerCli(['inbox'], env);
  assert.ok(inbox.messages.some((message) => message.payload.text === 'Use plain text'));
  assert.equal(first.inputs.length, 1, 'mail must not be pasted into a CLI that is running tools');
  for (const session of sessions) {
    const id = session.opts.sessionOptions.workerId;
    await writeFile(join(session.opts.cwd, `${id} 文件.txt`), 'result');
    const report = { status: 'completed', summary: `implemented ${id}`, files: [{ path: `${id} 文件.txt`, action: 'created' }], tests: [], unresolved: [] };
    const workerEnv = { ...process.env, ...session.opts.envOverride };
    await writeFile(workerEnv.AHASTATION_WORKER_REPORT, JSON.stringify({ ...report, files: [] }));
    await assert.rejects(runWorkerCli(['report'], workerEnv), /do not match/);
    await writeFile(workerEnv.AHASTATION_WORKER_REPORT, JSON.stringify(report));
    const cli = await execute(process.execPath, [workerEnv.AHASTATION_WORKER_ENTRY, 'report'], { env: workerEnv, windowsHide: true });
    assert.equal(JSON.parse(cli.stdout).status, 'received');
    assert.equal((await runWorkerCli(['report'], workerEnv)).duplicate, true);
    await assert.rejects(scheduler.receiveTerminalReport(id, 2, report), /no longer active/);
  }
  await waitFor(() => reports.length === 2);
  await waitFor(() => reviewDriver.snapshot().length === 2);
  assert.ok(reviewDriver.snapshot().every((review) => review.candidate.manifest.files.length === 1));
  const journal = await readFile(join(root, 'journal', 'events.jsonl'), 'utf8');
  assert.equal(journal.split('\n').filter((line) => line.includes('"kind":"report"')).length, 2);
  assert.ok(reports.every((report) => report.files.length === 1));
  assert.ok(events.some((e) => e.event.kind === 'delivery-status'));
});

test('native PTY receives a task and runs the bundled Worker CLI without a model', async (t) => {
  const bridge = new WorkerCliBridge();
  const host = new PtyHost();
  let question;
  const binding = await bridge.bind({
    async ask(text) { question = text; return { id: 'question-1' }; },
    async report() { throw new Error('Not used'); }, async inbox() { return { messages: [] }; },
  });
  const script = join(binding.runtimeDir, 'offline-agent.cjs');
  await writeFile(script, `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('OFFLINE_AGENT_READY');
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk.toString();
  if (!input.includes('\\r')) return;
  process.stdin.removeAllListeners('data');
  const file = join(__dirname, 'question.json');
  writeFileSync(file, JSON.stringify({question: input.includes('offline task') ? 'task received' : 'wrong task'}));
  const child = spawn(process.execPath, [process.env.AHASTATION_WORKER_ENTRY, 'ask', '--file', file], {env: process.env, stdio: 'inherit', windowsHide:true});
  child.on('exit', () => process.stdout.write('OFFLINE_CLI_FINISHED'));
});
`);
  const session = new TerminalCliSession({
    id: 'offline-terminal', capabilities: {}, displayLabel: 'Offline',
    resolveBinary: () => process.execPath, buildCliArgs: () => [script],
    readyPattern: /OFFLINE_AGENT_READY/, startupMessage: 'Starting offline fixture', missingBinaryMessage: 'Missing Node',
  }, {
    cwd: binding.runtimeDir, env: { ...process.env, ...binding.env },
    extra: { workerId: 'offline-pty', workerRuntimeDir: binding.runtimeDir },
  }, () => {}, { host, resolveBinary: () => process.execPath });
  t.after(() => { session.end(); host.killAll(); binding.dispose(); bridge.close(); });
  await session.start();
  session.sendUserText('offline task');
  await waitFor(() => question === 'task received');
  await waitFor(() => host.replayBuffer('offline-pty')?.toString().includes('OFFLINE_CLI_FINISHED'));
  assert.equal(session.resumePendingInput(), false, 'initial prompt may only be delivered once');
  session.end();
  assert.equal(host.has('offline-pty'), false);
});
