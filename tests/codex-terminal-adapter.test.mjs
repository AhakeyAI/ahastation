import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CodexTerminalBackend,
  CODEX_TERMINAL_PROFILE,
} from '../dist-electron/backends/codex-terminal-adapter.js';
import {
  TERMINAL_TASK_COMPLETE_MARKER,
  TERMINAL_TURN_ENDED_MARKER,
} from '../dist-electron/backends/terminal-cli-adapter.js';
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
  const sharedHookDir = mkdtempSync(join(tmpdir(), 'ahastation-codex-hooks-'));
  const backend = new CodexTerminalBackend({
    host,
    resolveBinary: () => '/usr/local/bin/codex',
    timersEnabled: false,
    sharedHookDir,
    ...overrides,
  });
  t.after(() => {
    host.killAll();
    rmSync(sharedHookDir, { recursive: true, force: true });
  });
  return { backend, host, spawned, sharedHookDir };
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

function stopTableOf(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-c' && args[i + 1].startsWith('hooks.Stop=')) return args[i + 1];
  }
  return undefined;
}

test('codex launches with inline-TOML Stop hook injection, no managed home', async (t) => {
  const { backend, spawned, sharedHookDir } = createFixture(t);
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
  assert.ok(cFlagValues.includes('hooks=true'));
  const stopTable = cFlagValues.find((v) => v.startsWith('hooks.Stop='));
  assert.ok(stopTable, 'hooks.Stop inline table must be present');
  assert.ok(stopTable.includes('terminal-stop-hook.cjs'));
  assert.ok(stopTable.includes('type="command"'));
  // The user's own config/auth is untouched: no CODEX_HOME override.
  assert.equal(options.env.CODEX_HOME, undefined);
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
  // One shared script; the session's events file comes in through the env.
  assert.ok(existsSync(join(sharedHookDir, 'terminal-stop-hook.cjs')));
  assert.equal(
    options.env.AHA_TERMINAL_EVENTS_PATH,
    join(cwd, '.aha', 'terminal-turn-events-cw-hook.jsonl'),
  );
  session.end();
});

test('every Codex Worker gets the same hook command, so Codex asks to trust it once', async (t) => {
  // N5095 round 3 (2026-11-04): a per-Worker script path made Codex show
  // "Hooks need review" for each new Worker.
  const { backend, spawned } = createFixture(t);
  const first = backend.createSession({ cwd: await createWorkspace(t), extra: { workerId: 'cw-a' } }, () => {});
  const second = backend.createSession({ cwd: await createWorkspace(t), extra: { workerId: 'cw-b' } }, () => {});
  await first.start();
  await second.start();
  assert.equal(stopTableOf(spawned[0].args), stopTableOf(spawned[1].args));
  assert.notEqual(
    spawned[0].options.env.AHA_TERMINAL_EVENTS_PATH,
    spawned[1].options.env.AHA_TERMINAL_EVENTS_PATH,
  );
  first.end();
  second.end();
});

test('the shared Stop hook writes to the events file named by its environment', async (t) => {
  const { backend, sharedHookDir } = createFixture(t);
  const cwd = await createWorkspace(t);
  const session = backend.createSession({ cwd, extra: { workerId: 'cw-run' } }, () => {});
  await session.start();
  const eventsPath = join(cwd, '.aha', 'terminal-turn-events-cw-run.jsonl');
  const run = spawnSync(process.execPath, [join(sharedHookDir, 'terminal-stop-hook.cjs')], {
    input: JSON.stringify({ last_assistant_message: `完成 ${TERMINAL_TASK_COMPLETE_MARKER}` }),
    env: { ...process.env, AHA_TERMINAL_EVENTS_PATH: eventsPath },
  });
  assert.equal(run.status, 0, String(run.stderr));
  const [line] = readFileSync(eventsPath, 'utf8').trim().split('\n');
  assert.equal(JSON.parse(line).marker, true);

  // Without the env var (a stray Codex outside AhaStation) it does nothing.
  const stray = spawnSync(process.execPath, [join(sharedHookDir, 'terminal-stop-hook.cjs')], {
    input: '{}',
    env: { ...process.env, AHA_TERMINAL_EVENTS_PATH: '' },
  });
  assert.equal(stray.status, 0, String(stray.stderr));
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
  const updateIdx = spawned[0].args.indexOf('check_for_update_on_startup=false');
  assert.equal(spawned[0].args[updateIdx - 1], '-c', 'the startup update menu is turned off');
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

test('the Codex trust dialog holds the prompt until the user answers it', async (t) => {
  const { backend, spawned } = createFixture(t, { timersEnabled: true });
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession({ cwd, extra: { workerId: 'w-codex-trust' } }, (event) => events.push(event));
  session.sendUserText('打开记事本');
  await session.start();
  const pty = spawned[0].pty;
  // Wrapped the way a narrow stage terminal drew it on N5095 (2026-11-03).
  // Pasting here made Codex exit with "timed out discarding buffered terminal input".
  pty.emitData('  settings can run     \r\n  code automatically,  \r\n  even without a       \r\n'
    + '  model request.       \r\n  Continue only if     \r\n  you trust these      \r\n'
    + '  files. Your trust    \r\n  decision will be     \r\n  saved.\r\n'
    + '\u203a 1. Trust and continue\r\n  2. Quit\r\n');
  await new Promise((r) => setTimeout(r, 2_000));
  assert.deepEqual(pty.writes, [], 'nothing may be pasted while the dialog is up');
  assert.ok(events.some((e) => e.signal?.kind === 'progress' && /信任/.test(e.signal.message)));

  await new Promise((r) => setTimeout(r, 900));
  pty.emitData('\u001b[2J\u203a Ask Codex to do anything');
  await waitFor(() => pty.writes.length >= 2, 8_000);
  assert.equal(pty.writes[0], `${PASTE_START}打开记事本${PASTE_END}`);
  session.end();
});

test('the Codex update menu holds the prompt until the user answers it', async (t) => {
  const { backend, spawned } = createFixture(t, { timersEnabled: true });
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession({ cwd, extra: { workerId: 'w-codex-update' } }, (event) => events.push(event));
  session.sendUserText('打开记事本');
  await session.start();
  const pty = spawned[0].pty;
  // Both N5095 Workers crashed on this menu (2026-11-04).
  pty.emitData('  \u2728 Update available!\r\n  0.130.0 -> 0.131.0\r\n'
    + '\u203a 1. Update now (runs\r\n     `npm install -g\r\n     @openai/codex`)\r\n'
    + '  2. Skip\r\n  3. Skip until next\r\n     version\r\n  Press enter to continue\r\n');
  await new Promise((r) => setTimeout(r, 2_000));
  assert.deepEqual(pty.writes, [], 'nothing may be pasted while the menu is up');
  assert.ok(events.some((e) => e.signal?.kind === 'progress' && /更新提示/.test(e.signal.message)));

  await new Promise((r) => setTimeout(r, 900));
  pty.emitData('\u001b[2J\u203a Ask Codex to do anything');
  await waitFor(() => pty.writes.length >= 2, 8_000);
  assert.equal(pty.writes[0], `${PASTE_START}打开记事本${PASTE_END}`);
  session.end();
});

test('the Codex hooks review holds the prompt until the user answers it', async (t) => {
  const { backend, spawned } = createFixture(t, { timersEnabled: true });
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession({ cwd, extra: { workerId: 'w-codex-hooks' } }, (event) => events.push(event));
  session.sendUserText('打开记事本');
  await session.start();
  const pty = spawned[0].pty;
  // As drawn on N5095 (2026-11-04).
  pty.emitData('  Hooks need review\r\n  1 hook is new or changed.\r\n'
    + '\u203a 1. Review hooks\r\n  2. Trust all and continue\r\n'
    + "  3. Continue without trusting (hooks won't run)\r\n  enter confirm \u00b7 esc skip\r\n");
  await new Promise((r) => setTimeout(r, 2_000));
  assert.deepEqual(pty.writes, [], 'nothing may be pasted while the review is up');
  assert.ok(events.some((e) => e.signal?.kind === 'progress' && /hooks/.test(e.signal.message)));

  await new Promise((r) => setTimeout(r, 900));
  pty.emitData('\u001b[2J\u203a Ask Codex to do anything');
  await waitFor(() => pty.writes.length >= 2, 8_000);
  assert.equal(pty.writes[0], `${PASTE_START}打开记事本${PASTE_END}`);
  session.end();
});

test('end() kills the pty and removes its events file but keeps the shared hook', async (t) => {
  const { backend, host, spawned, sharedHookDir } = createFixture(t);
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'cw-end' } },
    (event) => events.push(event),
  );
  await session.start();
  const ahaDir = join(cwd, '.aha');
  const sharedHook = join(sharedHookDir, 'terminal-stop-hook.cjs');
  assert.ok(existsSync(sharedHook));

  session.end();
  assert.equal(spawned[0].pty.killed, true);
  assert.equal(host.has('cw-end'), false);
  assert.ok(existsSync(sharedHook), 'other Workers still use the shared hook');
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
