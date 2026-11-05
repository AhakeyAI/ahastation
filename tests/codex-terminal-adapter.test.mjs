import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CodexTerminalBackend,
  CODEX_TERMINAL_PROFILE,
} from '../dist-electron/backends/codex-terminal-adapter.js';
import { TERMINAL_TURN_ENDED_MARKER, TerminalCliSession } from '../dist-electron/backends/terminal-cli-adapter.js';
import { PtyHost } from '../dist-electron/pty-host.js';

const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

function createFakePty() {
  return {
    pid: 7,
    writes: [],
    killed: false,
    dataHandlers: [],
    exitHandlers: [],
    onData(cb) { this.dataHandlers.push(cb); return { dispose: () => {} }; },
    onExit(cb) { this.exitHandlers.push(cb); return { dispose: () => {} }; },
    write(data) { this.writes.push(data); },
    resize() {},
    kill() { this.killed = true; },
    emitData(data) { for (const cb of [...this.dataHandlers]) cb(data); },
    emitExit(exitCode) { for (const cb of [...this.exitHandlers]) cb({ exitCode }); },
  };
}

function createFixture(t, overrides = {}) {
  const spawned = [];
  const host = new PtyHost({
    spawn: (file, args, options) => {
      const pty = createFakePty();
      spawned.push({ file, args, options, pty });
      return pty;
    },
  });
  const backend = new CodexTerminalBackend({
    host,
    resolveBinary: () => '/usr/local/bin/codex',
    timersEnabled: false,
    ...overrides,
  });
  t.after(() => host.killAll());
  return { backend, host, spawned };
}

async function createWorkspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ahastation-codex-terminal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function waitFor(predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) return resolve(undefined);
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test('codex backend id and capabilities are terminal-shaped', () => {
  const backend = new CodexTerminalBackend({ resolveBinary: () => '/x/codex' });
  assert.equal(backend.id, 'codex-terminal');
  assert.equal(backend.capabilities.executeTasks, true);
  assert.equal(backend.capabilities.coordinate, false);
  assert.equal(backend.resolveBinary(), '/x/codex');
});

test('Windows Codex launches a long multiline task without pasting it or exposing it in argv', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const { backend, spawned } = createFixture(t, { resolveBinary: () => 'C:\\fixture\\codex.exe' });
  const cwd = await createWorkspace(t);
  const runtimeDir = await createWorkspace(t);
  const taskId = 'launch-task';
  const session = backend.createSession({
    cwd,
    executionRole: 'worker',
    extra: { workerId: taskId },
    taskProfile: { backendId: 'codex-terminal' },
    nativeCliWorker: {
      mode: 'native-cli-self-approval', meetingId: 'fixture', taskId, workerId: taskId,
      attempt: 1, workspaceMode: 'git-worktree', workspaceCwd: cwd,
    },
    env: {
      AHASTATION_WORKER_URL: 'http://127.0.0.1:54321',
      AHASTATION_WORKER_TOKEN: 'fixture',
      AHASTATION_WORKER_ENTRY: 'fixture.cjs',
    },
  }, () => {});
  t.after(() => session.end());
  const task = `## Task\n${'完整中文任务正文和上下文\n'.repeat(3_500)}\nContext package: fixture-hash`;
  assert.ok(task.length > 32_767);
  assert.equal(session.stageInitialTask(task, runtimeDir), true);
  await session.start();
  const { args, options, pty } = spawned[0];
  assert.equal(options.env.AHASTATION_WORKER_BRIEF, join(runtimeDir, 'initial-task.txt'));
  assert.equal(await readFile(options.env.AHASTATION_WORKER_BRIEF, 'utf8'), task);
  assert.equal(args.at(-2), '--');
  assert.match(args.at(-1), /AHASTATION_WORKER_BRIEF/);
  assert.ok(!args.some((arg) => arg.includes('fixture-hash')));
  assert.deepEqual(pty.writes, []);
  assert.equal(session.isIdleForAutomaticInput(), false);
});

test('a Codex TERM=dumb prompt never receives the queued task', async (t) => {
  const { backend, spawned } = createFixture(t, { timersEnabled: true });
  const events = [];
  const session = backend.createSession({ cwd: await createWorkspace(t) }, event => events.push(event));
  await session.start();
  t.after(() => session.end());
  session.sendUserText('fixture task');
  const { pty } = spawned[0];
  pty.emitData('WARNING: TERM is set ');
  pty.emitData('to “dumb”.\r\nContinue anyway? [y/N]:');
  const failures = events.filter(e => e.signal?.kind === 'failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].signal.code, 'terminal-startup-blocked');
  await new Promise(resolve => setTimeout(resolve, 1_750));
  assert.deepEqual(pty.writes, [], 'task input must not answer the CLI startup prompt');
});

test('codex launches with inline-TOML Stop hook injection, no managed home', async (t) => {
  const { backend, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const session = backend.createSession(
    { cwd, extra: { workerId: 'cw-hook' } },
    () => {},
  );
  await session.start();
  assert.equal(spawned.length, 1);
  const { file, args, options } = spawned[0];
  assert.equal(file, '/usr/local/bin/codex');
  // hooks=true plus an inline Stop hook table carrying the hook command.
  const cFlagValues = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-c') cFlagValues.push(args[i + 1]);
  }
  assert.ok(cFlagValues.includes('features.hooks=true'));
  const stopTable = cFlagValues.find((v) => v.startsWith('hooks.Stop='));
  assert.ok(stopTable, 'hooks.Stop inline table must be present');
  assert.ok(stopTable.includes('terminal-stop-hook-cw-hook.cjs'));
  assert.ok(stopTable.includes('type="command"'));
  // The user's own config/auth is untouched: no CODEX_HOME override.
  assert.equal(options.env.CODEX_HOME, undefined);
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
  // The shared hook script exists in the workspace .aha dir.
  assert.ok(existsSync(join(cwd, '.aha', 'terminal-stop-hook-cw-hook.cjs')));
  session.end();
});

test('approval tier and model map to codex CLI flags', async (t) => {
  const { backend, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const s1 = backend.createSession(
    { cwd, extra: { workerId: 'cw-read' }, autoApproveScope: 'read', model: 'gpt-5.4' },
    () => {},
  );
  await s1.start();
  assert.ok(spawned[0].args.includes('--full-auto'));
  const mIdx = spawned[0].args.indexOf('-m');
  assert.equal(spawned[0].args[mIdx + 1], 'gpt-5.4');
  s1.end();

  const s2 = backend.createSession(
    { cwd, extra: { workerId: 'cw-all' }, autoApproveScope: 'all' },
    () => {},
  );
  await s2.start();
  assert.ok(spawned[1].args.includes('--dangerously-bypass-approvals-and-sandbox'));
  s2.end();

  const s3 = backend.createSession(
    { cwd, extra: { workerId: 'cw-off' } },
    () => {},
  );
  await s3.start();
  assert.ok(!spawned[2].args.includes('--full-auto'));
  assert.ok(!spawned[2].args.includes('--dangerously-bypass-approvals-and-sandbox'));
  s3.end();
});

test('task prompt is pasted once ready; Stop hook surfaces turn-ended', async (t) => {
  const { backend, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'cw-flow' } },
    (event) => events.push(event),
  );
  session.sendUserText('任务提示词');
  await session.start();
  assert.deepEqual(spawned[0].pty.writes, [
    `${PASTE_START}任务提示词${PASTE_END}`,
    '\r',
  ]);
  const eventsPath = join(cwd, '.aha', 'terminal-turn-events-cw-flow.jsonl');
  await appendFile(eventsPath, `${JSON.stringify({ kind: 'stop', at: Date.now() })}\n`);
  await waitFor(() => events.some(
    (e) => e.signal?.kind === 'progress' && e.signal.message.startsWith(TERMINAL_TURN_ENDED_MARKER),
  ));
  assert.ok(events.every((e) => e.signal?.kind !== 'ended'));
  assert.ok(events.every((e) => e.signal?.kind !== 'delivery'));
  session.end();
});

test('Codex holds task input while Stop hooks need review', async (t) => {
  const { backend, spawned } = createFixture(t, { timersEnabled: true });
  const cwd = await createWorkspace(t);
  const workerId = 'cw-hook-review';
  const events = [];
  const session = backend.createSession({ cwd, extra: { workerId } }, (event) => events.push(event));
  t.after(() => session.end());
  session.sendUserText('探查项目');
  await session.start();

  const pty = spawned[0].pty;
  pty.emitData('OpenAI Codex\r\nStop hooks\r\n1 hook needs');
  pty.emitData('\u001b[1Creview before it can run.');
  const status = TerminalCliSession.trustStatus(workerId);
  assert.equal(status.waiting, true);
  assert.ok(events.some((event) => event.signal?.message.includes('Stop hook 审核')));
  await new Promise((resolve) => setTimeout(resolve, 1_800));
  assert.deepEqual(pty.writes, []);

  pty.emitData('\u001b[2J\r\n› ');
  assert.deepEqual(pty.writes, []);
  assert.equal(TerminalCliSession.confirmTrust(workerId, status.generation).ok, true);
  await waitFor(() => pty.writes.length === 2);
  assert.deepEqual(pty.writes, [`${PASTE_START}探查项目${PASTE_END}`, '\r']);
  session.end();
});

test('end() kills the pty and removes hook files (no managed home to remove)', async (t) => {
  const { backend, host, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'cw-end' } },
    (event) => events.push(event),
  );
  await session.start();
  const ahaDir = join(cwd, '.aha');
  assert.ok(existsSync(join(ahaDir, 'terminal-stop-hook-cw-end.cjs')));

  session.end();
  assert.equal(spawned[0].pty.killed, true);
  assert.equal(host.has('cw-end'), false);
  assert.ok(!existsSync(join(ahaDir, 'terminal-stop-hook-cw-end.cjs')));
  assert.ok(!existsSync(join(ahaDir, 'terminal-turn-events-cw-end.jsonl')));
  assert.ok(events.every((e) => !(e.signal?.kind === 'ended' && e.signal.reason === 'crashed')));
  session.end();
});

test('missing codex CLI fails fast without spawning a pty', async (t) => {
  const { backend, spawned } = createFixture(t, { resolveBinary: () => null });
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'cw-nobin' } },
    (event) => events.push(event),
  );
  await session.start();
  assert.equal(spawned.length, 0);
  assert.ok(events.some(
    (e) => e.signal?.kind === 'failed' && e.signal.code === 'runtime-unavailable',
  ));
  assert.ok(events.some(
    (e) => e.signal?.kind === 'ended' && e.signal.reason === 'crashed',
  ));
  session.end();
});

test('profile metadata is consistent', () => {
  assert.equal(CODEX_TERMINAL_PROFILE.id, 'codex-terminal');
  assert.equal(typeof CODEX_TERMINAL_PROFILE.startupMessage, 'string');
  assert.ok(CODEX_TERMINAL_PROFILE.missingBinaryMessage.includes('codex'));
});
