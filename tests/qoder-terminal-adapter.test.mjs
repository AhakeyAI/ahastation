import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { appendFileSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  QoderTerminalBackend,
  QODER_TERMINAL_PROFILE,
  parseQoderTranscriptLine,
  qoderProjectSlug,
  qoderTranscriptMatchesPrompt,
  resolveQoderTranscriptCandidates,
} from '../dist-electron/backends/qoder-terminal-adapter.js';
import {
  hostTerminalWorkerId,
  stripAnsi,
} from '../dist-electron/backends/terminal-cli-adapter.js';
import { PtyHost } from '../dist-electron/pty-host.js';

const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

function createFakePty(pid = 7) {
  return {
    pid,
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
      const pty = createFakePty(7 + spawned.length);
      spawned.push({ file, args, options, pty });
      return pty;
    },
  });
  const backend = new QoderTerminalBackend({
    host,
    resolveBinary: () => '/usr/local/bin/qodercli',
    timersEnabled: false,
    ...overrides,
  });
  t.after(() => host.killAll());
  return { backend, host, spawned };
}

async function createWorkspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ahastation-qoder-terminal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('terminal host PTY ids are isolated by meeting and host', () => {
  assert.notEqual(
    hostTerminalWorkerId('meeting-a', 'qoder'),
    hostTerminalWorkerId('meeting-b', 'qoder'),
  );
  assert.equal(hostTerminalWorkerId('meeting-a', 'qoder'), 'host-terminal-meeting-a-qoder');
});

test('qoder backend id and capabilities are terminal-shaped', () => {
  const backend = new QoderTerminalBackend({ resolveBinary: () => '/x/qodercli' });
  assert.equal(backend.id, 'qoder-terminal');
  assert.equal(backend.capabilities.executeTasks, true);
  assert.equal(backend.capabilities.coordinate, false);
  assert.equal(backend.resolveBinary(), '/x/qodercli');
});

test('qoder launches with -w workspace and no hook registration', async (t) => {
  const { backend, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const session = backend.createSession(
    { cwd, extra: { workerId: 'qw-basic' } },
    () => {},
  );
  await session.start();
  assert.equal(spawned.length, 1);
  const { file, args, options } = spawned[0];
  assert.equal(file, '/usr/local/bin/qodercli');
  assert.deepEqual(args.slice(0, 2), ['-w', cwd]);
  assert.equal(options.cwd, cwd);
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
  // Hookless: the shared events file still exists (skeleton-managed) but no
  // CLI flag references the hook script.
  assert.ok(!args.some((a) => a.includes('terminal-stop-hook')));
  session.end();
});

test('approval tier and model map to qoder CLI flags', async (t) => {
  const { backend, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const s1 = backend.createSession(
    { cwd, extra: { workerId: 'qw-read' }, autoApproveScope: 'read', model: 'auto' },
    () => {},
  );
  await s1.start();
  const atIdx = spawned[0].args.indexOf('--allowed-tools');
  assert.ok(atIdx > 0);
  assert.ok(spawned[0].args[atIdx + 1].includes('Read'));
  const mIdx = spawned[0].args.indexOf('--model');
  assert.equal(spawned[0].args[mIdx + 1], 'auto');
  s1.end();

  const s2 = backend.createSession(
    { cwd, extra: { workerId: 'qw-all' }, autoApproveScope: 'all' },
    () => {},
  );
  await s2.start();
  assert.ok(spawned[1].args.includes('--yolo'));
  s2.end();

  const s3 = backend.createSession(
    { cwd, extra: { workerId: 'qw-off' } },
    () => {},
  );
  await s3.start();
  assert.ok(!spawned[2].args.includes('--yolo'));
  assert.ok(!spawned[2].args.includes('--allowed-tools'));
  s3.end();
});

test('task prompt is pasted once ready; hookless => no automatic turn events', async (t) => {
  const { backend, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'qw-flow' } },
    (event) => events.push(event),
  );
  session.sendUserText('任务提示词');
  await session.start();
  assert.deepEqual(spawned[0].pty.writes, [
    `${PASTE_START}任务提示词${PASTE_END}`,
    '\x1b[?2004l', // detach bracketed paste before sending the real Enter key
    '\r',
  ]);
  // Startup progress only; never an automatic ended/delivery signal.
  assert.ok(events.some((e) => e.signal?.kind === 'progress'));
  assert.ok(events.every((e) => e.signal?.kind !== 'ended'));
  assert.ok(events.every((e) => e.signal?.kind !== 'delivery'));
  session.end();
});

test('end() kills the pty and cleans the skeleton hook files', async (t) => {
  const { backend, host, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'qw-end' } },
    (event) => events.push(event),
  );
  await session.start();
  const ahaDir = join(cwd, '.aha');
  assert.ok(existsSync(join(ahaDir, 'terminal-turn-events-qw-end.jsonl')));

  session.end();
  assert.equal(spawned[0].pty.killed, true);
  assert.equal(host.has('qw-end'), false);
  assert.ok(!existsSync(join(ahaDir, 'terminal-stop-hook-qw-end.cjs')));
  assert.ok(!existsSync(join(ahaDir, 'terminal-turn-events-qw-end.jsonl')));
  assert.ok(events.every((e) => !(e.signal?.kind === 'ended' && e.signal.reason === 'crashed')));
  session.end();
});

test('missing qodercli fails fast without spawning a pty', async (t) => {
  const { backend, spawned } = createFixture(t, { resolveBinary: () => null });
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'qw-nobin' } },
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
  assert.equal(QODER_TERMINAL_PROFILE.id, 'qoder-terminal');
  assert.equal(typeof QODER_TERMINAL_PROFILE.startupMessage, 'string');
  assert.ok(QODER_TERMINAL_PROFILE.missingBinaryMessage.includes('qodercli'));
  // Hookless by design.
  assert.equal(QODER_TERMINAL_PROFILE.registerTurnHook, undefined);
});

test('stripAnsi removes CSI/OSC sequences and normalizes carriage returns', () => {
  assert.equal(stripAnsi('\x1b[1mBold\x1b[22m plain'), 'Bold plain');
  assert.equal(stripAnsi('a\r\nb\rc'), 'a\nb\nc');
  assert.equal(stripAnsi('\x1b]0;title\x07visible'), 'visible');
  assert.equal(stripAnsi(`\x1b[200~pasted\x1b[201~`), 'pasted');
});

test('login gate retains input until explicit user readiness', async (t) => {
  const { backend, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'qw-authwall' } },
    (event) => events.push(event),
  );
  session.sendUserText('任务提示词');
  await session.start();
  // timersEnabled=false → the queued prompt is pasted and submitted immediately.
  assert.equal(spawned[0].pty.writes.length, 3);

  // The qodercli 1.0.47 login gate, sampled from a real pty recording
  // (script -q): the TUI paints word-granularity runs, so after stripAnsi the
  // copy is GLUED ("Signintogetstarted") and carries the CLI's own typo
  // ("PlaseAuth", not "Please Auth").
  spawned[0].pty.emitData(
    '\x1b[1m Qoder CLI v1.0.47\x1b[22m  \x1b[31mNo Login PlaseAuth\x1b[39m\n'
    + 'WelcometoQoderCLI\nSignintogetstarted,orexittheapplication.\n'
    + '❯1.Signintocontinue   2.Exittheapplication\n',
  );
  const pending = events.filter((e) => e.signal?.message?.startsWith('[terminal-input-pending]'));
  assert.equal(pending.length, 1);
  assert.ok(pending[0].signal.message.includes('qodercli'));

  // Further input is dropped — paste + \r must not reach the login menu.
  session.sendUserText('后续输入');
  assert.equal(spawned[0].pty.writes.length, 3);

  // Idempotent: repeated login-gate frames do not re-emit the failure.
  spawned[0].pty.emitData('No Login PlaseAuth');
  assert.equal(events.filter((e) => e.signal?.message?.startsWith('[terminal-input-pending]')).length, 1);
  assert.equal(session.resumePendingInput(), true);
  assert.equal(spawned[0].pty.writes.length, 6);
  assert.equal(session.resumePendingInput(), false);
  session.end();
});

test('prompt waits for the input-box pattern, not the boot frame', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { backend, spawned } = createFixture(t, { timersEnabled: true });
  const cwd = await createWorkspace(t);
  const session = backend.createSession(
    { cwd, extra: { workerId: 'qw-readygate' } },
    () => {},
  );
  session.sendUserText('帮我看下这个skill');
  await session.start();

  // Boot phase: the "Authenticating" page draws frames for seconds before
  // the input box exists. Pasting here is what swallowed prompts in prod.
  spawned[0].pty.emitData('Authenticating\n⠋ Waitingforauthentication...\n');
  t.mock.timers.tick(25_000); // past the legacy 5s fallback, under the 30s one
  assert.equal(spawned[0].pty.writes.length, 0);

  // Input box placeholder (painted glued by the real TUI) unlocks the
  // paste — but only after output goes quiet (READY_QUIESCE_MS = 2.5s), so
  // boot repaints (MCP/skills/self-update) cannot swallow it.
  spawned[0].pty.emitData('> Typeyourmessageor@path/to/file\nAutoModel·ctx 0%\n');
  t.mock.timers.tick(2_000);
  assert.equal(spawned[0].pty.writes.length, 0); // still inside the quiesce window
  // A late boot frame re-arms the quiesce timer.
  spawned[0].pty.emitData('2MCPservers· 29 skills\n');
  t.mock.timers.tick(2_499);
  assert.equal(spawned[0].pty.writes.length, 0);
  t.mock.timers.tick(1);
  assert.equal(spawned[0].pty.writes.length, 1);
  assert.ok(spawned[0].pty.writes[0].includes('帮我看下这个skill'));
  t.mock.timers.tick(400); // SUBMIT_DELAY_MS
  assert.deepEqual(spawned[0].pty.writes.slice(1), ['\x1b[?2004l', '\r']);
  session.end();
});

test('ready deadline retains the prompt instead of pasting blindly', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { backend, spawned } = createFixture(t, { timersEnabled: true });
  const cwd = await createWorkspace(t);
  const session = backend.createSession(
    { cwd, extra: { workerId: 'qw-readyfallback' } },
    () => {},
  );
  session.sendUserText('兜底任务');
  await session.start();

  spawned[0].pty.emitData('some output that never shows the input box\n');
  t.mock.timers.tick(29_999);
  assert.equal(spawned[0].pty.writes.length, 0);
  t.mock.timers.tick(2); // READY_FALLBACK_PATTERN_MS = 30s
  assert.equal(spawned[0].pty.writes.length, 0);
  assert.equal(session.resumePendingInput(), true);
  assert.equal(spawned[0].pty.writes.length, 1);
  t.mock.timers.tick(400);
  assert.deepEqual(spawned[0].pty.writes.slice(1), ['\x1b[?2004l', '\r']);
  session.end();
});

test('normal TUI output and login-related task text never trip the auth wall', async (t) => {
  const { backend, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'qw-noauth' } },
    (event) => events.push(event),
  );
  await session.start();
  spawned[0].pty.emitData('Qoder CLI v1.0.47\n Tips for getting started\n> ready\n');
  // A task conversation about login pages must not false-positive: neither
  // "Sign in to continue" copy nor a bare "no login" phrase is an anchor.
  spawned[0].pty.emitData('我帮你实现登录页，包含 Sign in to continue 按钮文案');
  spawned[0].pty.emitData('目前产品没有登录页：there is no login page yet, keep it that way');
  assert.ok(events.every((e) => e.signal?.kind !== 'failed'));
  session.end();
});

// ── Session transcript tailer ────────────────────────────────────────────────

async function waitForEvent(cond, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function createTranscriptFixture(t, cwd) {
  const home = await mkdtemp(join(tmpdir(), 'ahastation-qoder-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const slug = qoderProjectSlug(cwd);
  const dir = join(home, '.qoder', 'projects', slug);
  const logsDir = join(home, '.qoder', 'logs', 'sessions', slug);
  await mkdir(dir, { recursive: true });
  return { home, dir, logsDir };
}

test('qoderProjectSlug mirrors the qodercli project-dir layout', () => {
  assert.equal(qoderProjectSlug('/Users/jiakun/cc_skills/x'), '-Users-jiakun-cc-skills-x');
  assert.equal(
    qoderProjectSlug('/Users/jiakun/.qoderwork-workspace/mn49'),
    '-Users-jiakun--qoderwork-workspace-mn49',
  );
});

test('qoder transcript prompt matcher tolerates the persisted paste detach suffix', () => {
  const prompt = '[direct user mention from meeting chat]\n介绍这个 skill';
  const row = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: `${prompt}\u001b[?2004l` },
  });
  assert.equal(qoderTranscriptMatchesPrompt(row, [prompt]), true);
  assert.equal(qoderTranscriptMatchesPrompt(row, ['另一个会话']), false);
});

test('qoder transcript resolver maps the spawned PID to its project transcript', async (t) => {
  const cwd = await createWorkspace(t);
  const { home, dir, logsDir } = await createTranscriptFixture(t, cwd);
  const sessionId = 'session-owned-by-pid';
  const segmentsDir = join(logsDir, sessionId, 'segments');
  await mkdir(segmentsDir, { recursive: true });
  writeFileSync(join(segmentsDir, '2026-09-22T16-10-52-p73.jsonl'), '{}\n');

  // Current layout: transcript/ subdirectory; neither file exists yet so the
  // resolver defaults to the new path.
  assert.deepEqual(resolveQoderTranscriptCandidates({ cwd, env: { HOME: home } }, 73), [{
    path: join(dir, 'transcript', `${sessionId}.jsonl`),
    trusted: true,
  }]);
});

test('parseQoderTranscriptLine surfaces assistant text and turn end only', () => {
  const textRow = JSON.stringify({
    type: 'assistant',
    uuid: 'a-1',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '你好，世界' }],
      stop_reason: 'end_turn',
    },
  });
  assert.deepEqual(parseQoderTranscriptLine(textRow), {
    id: 'a-1',
    text: '你好，世界',
    turnEnded: true,
  });

  const thinkingRow = JSON.stringify({
    type: 'assistant',
    uuid: 'a-2',
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: '……' }],
      stop_reason: null,
    },
  });
  assert.deepEqual(parseQoderTranscriptLine(thinkingRow), {
    id: 'a-2',
    text: '',
    turnEnded: false,
  });

  // tool_use stop: the turn is still in flight — not a completion.
  const toolRow = JSON.stringify({
    type: 'assistant',
    uuid: 'a-3',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Read', input: {} }],
      stop_reason: 'tool_use',
    },
  });
  assert.deepEqual(parseQoderTranscriptLine(toolRow), {
    id: 'a-3',
    text: '',
    turnEnded: false,
  });

  assert.equal(
    parseQoderTranscriptLine(JSON.stringify({ type: 'user', uuid: 'u-1', message: { content: 'hi' } })),
    null,
  );
  assert.equal(parseQoderTranscriptLine(JSON.stringify({ type: 'workspace-directories' })), null);
  assert.equal(parseQoderTranscriptLine('{"type":"assistant","uui'), null); // torn row
  assert.equal(
    parseQoderTranscriptLine(JSON.stringify({ type: 'assistant', message: { content: [] } })),
    null,
  ); // no uuid — cannot dedupe, skip
});

test('qoder tailer streams replies from the session transcript into events', async (t) => {
  const { backend } = createFixture(t);
  const cwd = await createWorkspace(t);
  const { home, dir } = await createTranscriptFixture(t, cwd);
  const transcriptPath = join(dir, 'session-live.jsonl');
  writeFileSync(transcriptPath, JSON.stringify({ type: 'runtime-config', at: 1 }) + '\n');

  const events = [];
  const session = backend.createSession(
    { cwd, env: { HOME: home }, extra: { workerId: 'qw-tail' } },
    (event) => events.push(event),
  );
  await session.start();
  t.after(() => session.end());

  session.sendUserText('帮我看下这个 skill');
  assert.ok(
    events.some((e) => e.kind === 'turn-status' && e.status === 'started'),
    'paste opens the started/completed pair',
  );

  appendFileSync(transcriptPath, [
    JSON.stringify({ type: 'user', uuid: 'u-1', message: { role: 'user', content: '帮我看下这个 skill' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a-1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '…' }], stop_reason: null } }),
    JSON.stringify({ type: 'assistant', uuid: 'a-2', message: { role: 'assistant', content: [{ type: 'text', text: '这个 skill 用来做回归测试。' }], stop_reason: 'end_turn' } }),
  ].join('\n') + '\n');

  assert.ok(
    await waitForEvent(() => events.some((e) => e.kind === 'turn-status' && e.status === 'completed')),
    'tailer closes the turn',
  );
  const messages = events.filter((e) => e.kind === 'message');
  assert.equal(messages.length, 1, 'only the text row surfaces');
  assert.equal(messages[0].message.type, 'assistant');
  assert.equal(messages[0].message.message.content[0].text, '这个 skill 用来做回归测试。');

  // A transcript rewrite re-appending the same uuid must not duplicate.
  appendFileSync(transcriptPath, JSON.stringify({ type: 'assistant', uuid: 'a-2', message: { role: 'assistant', content: [{ type: 'text', text: '这个 skill 用来做回归测试。' }], stop_reason: 'end_turn' } }) + '\n');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(events.filter((e) => e.kind === 'message').length, 1);
});

test('qoder tailer follows the PID-linked live session transcript', async (t) => {
  const { backend } = createFixture(t);
  const cwd = await createWorkspace(t);
  const { home, dir, logsDir } = await createTranscriptFixture(t, cwd);
  const events = [];
  const session = backend.createSession(
    { cwd, env: { HOME: home }, extra: { workerId: 'qw-live' } },
    (event) => events.push(event),
  );
  await session.start();
  t.after(() => session.end());
  session.sendUserText('读取 live transcript');

  const sessionId = 'live-session';
  const segmentsDir = join(logsDir, sessionId, 'segments');
  await mkdir(segmentsDir, { recursive: true });
  writeFileSync(join(segmentsDir, 'segment-p7.jsonl'), '{}\n');
  writeFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify({
    type: 'assistant',
    uuid: 'live-answer',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'PID 精确归属的回答' }],
      stop_reason: 'end_turn',
    },
  }) + '\n');

  assert.ok(await waitForEvent(() => events.some((event) => (
    event.kind === 'message'
      && event.message.message.content[0].text === 'PID 精确归属的回答'
  ))));
  assert.ok(events.some((event) => event.kind === 'turn-status' && event.status === 'completed'));
});

test('qoder tailer holds a torn trailing row until its append completes', async (t) => {
  const { backend } = createFixture(t);
  const cwd = await createWorkspace(t);
  const { home, dir } = await createTranscriptFixture(t, cwd);
  const transcriptPath = join(dir, 'session-torn.jsonl');
  writeFileSync(transcriptPath, '');

  const events = [];
  const session = backend.createSession(
    { cwd, env: { HOME: home }, extra: { workerId: 'qw-torn' } },
    (event) => events.push(event),
  );
  await session.start();
  t.after(() => session.end());
  session.sendUserText('测试半行回收');
  appendFileSync(transcriptPath, JSON.stringify({
    type: 'user',
    uuid: 'u-torn',
    message: { role: 'user', content: '测试半行回收' },
  }) + '\n');

  const full = JSON.stringify({ type: 'assistant', uuid: 'a-9', message: { role: 'assistant', content: [{ type: 'text', text: '完整回答' }], stop_reason: 'end_turn' } }) + '\n';
  const cut = Math.floor(full.length / 2);
  appendFileSync(transcriptPath, full.slice(0, cut));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(!events.some((e) => e.kind === 'message'), 'half a row stays buffered');

  appendFileSync(transcriptPath, full.slice(cut));
  assert.ok(await waitForEvent(() => events.some((e) => e.kind === 'message')));
  assert.ok(events.some((e) => e.kind === 'turn-status' && e.status === 'completed'));
});

test('qoder tailer follows session-file rotation across turns', async (t) => {
  // Regression: qodercli writes a NEW session jsonl per turn (each with its
  // own header). The tailer must keep discovering files for the whole session
  // and stream every turn's answer — not lock one file at spawn and go deaf to
  // later files (the production symptom where the terminal answered but the
  // meeting chat never updated).
  const { backend } = createFixture(t);
  const cwd = await createWorkspace(t);
  const { home, dir } = await createTranscriptFixture(t, cwd);

  const events = [];
  const session = backend.createSession(
    { cwd, env: { HOME: home }, extra: { workerId: 'qw-rotate' } },
    (event) => events.push(event),
  );
  await session.start();
  t.after(() => session.end());

  // Turn 1 lands in its own file created after spawn.
  session.sendUserText('第一轮问题');
  const turn1 = join(dir, 'turn-1.jsonl');
  writeFileSync(turn1, [
    JSON.stringify({ type: 'runtime-config', at: 1 }),
    JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: '第一轮问题' } }),
    JSON.stringify({ type: 'assistant', uuid: 't1', message: { role: 'assistant', content: [{ type: 'text', text: '第一轮回答' }], stop_reason: 'end_turn' } }),
  ].join('\n') + '\n');
  assert.ok(
    await waitForEvent(() => events.some((e) => e.kind === 'message' && e.message.message.content[0].text === '第一轮回答')),
    'turn 1 streams from the first rotated file',
  );

  // Turn 2 rotates to a brand-new file — the tailer must adopt it too.
  session.sendUserText('第二轮问题');
  const turn2 = join(dir, 'turn-2.jsonl');
  writeFileSync(turn2, [
    JSON.stringify({ type: 'runtime-config', at: 2 }),
    JSON.stringify({ type: 'user', uuid: 'u2', message: { role: 'user', content: '第二轮问题' } }),
    JSON.stringify({ type: 'assistant', uuid: 't2', message: { role: 'assistant', content: [{ type: 'text', text: '第二轮回答' }], stop_reason: 'end_turn' } }),
  ].join('\n') + '\n');
  assert.ok(
    await waitForEvent(() => events.some((e) => e.kind === 'message' && e.message.message.content[0].text === '第二轮回答')),
    'turn 2 streams from the newly-rotated file',
  );
  assert.equal(events.filter((e) => e.kind === 'message').length, 2, 'no cross-file duplication');
});

test('qoder tailer keeps simultaneous same-cwd sessions isolated by PID', async (t) => {
  const { backend } = createFixture(t);
  const cwd = await createWorkspace(t);
  const { home, dir, logsDir } = await createTranscriptFixture(t, cwd);
  const eventsA = [];
  const eventsB = [];
  const sessionA = backend.createSession(
    { cwd, env: { HOME: home }, extra: { workerId: 'qw-concurrent-a' } },
    (event) => eventsA.push(event),
  );
  const sessionB = backend.createSession(
    { cwd, env: { HOME: home }, extra: { workerId: 'qw-concurrent-b' } },
    (event) => eventsB.push(event),
  );
  await sessionA.start();
  await sessionB.start();
  t.after(() => sessionA.end());
  t.after(() => sessionB.end());
  sessionA.sendUserText('会话 A');
  sessionB.sendUserText('会话 B');

  for (const [sessionId, pid, answer] of [
    ['pid-session-a', 7, '只属于 A 的回答'],
    ['pid-session-b', 8, '只属于 B 的回答'],
  ]) {
    const segmentsDir = join(logsDir, sessionId, 'segments');
    await mkdir(segmentsDir, { recursive: true });
    writeFileSync(join(segmentsDir, `segment-p${pid}.jsonl`), '{}\n');
    writeFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify({
      type: 'assistant',
      uuid: `answer-${pid}`,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: answer }],
        stop_reason: 'end_turn',
      },
    }) + '\n');
  }

  assert.ok(await waitForEvent(() => (
    eventsA.some((event) => event.kind === 'message')
      && eventsB.some((event) => event.kind === 'message')
  )));
  assert.deepEqual(
    eventsA.filter((event) => event.kind === 'message').map((event) => event.message.message.content[0].text),
    ['只属于 A 的回答'],
  );
  assert.deepEqual(
    eventsB.filter((event) => event.kind === 'message').map((event) => event.message.message.content[0].text),
    ['只属于 B 的回答'],
  );
});

test('qoder tailer ignores transcripts written before this session spawned', async (t) => {
  const { backend } = createFixture(t);
  const cwd = await createWorkspace(t);
  const { home, dir } = await createTranscriptFixture(t, cwd);
  const transcriptPath = join(dir, 'session-old.jsonl');
  writeFileSync(
    transcriptPath,
    JSON.stringify({ type: 'assistant', uuid: 'old-1', message: { role: 'assistant', content: [{ type: 'text', text: '上一轮的旧回答' }], stop_reason: 'end_turn' } }) + '\n',
  );
  const backdated = new Date(Date.now() - 60_000);
  utimesSync(transcriptPath, backdated, backdated);

  const events = [];
  const session = backend.createSession(
    { cwd, env: { HOME: home }, extra: { workerId: 'qw-old' } },
    (event) => events.push(event),
  );
  await session.start();
  t.after(() => session.end());
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(
    !events.some((e) => e.kind === 'message'),
    'a previous session\'s transcript stays untouched',
  );
});
