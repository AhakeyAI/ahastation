import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkerScheduler } from '../dist-electron/worker-scheduler.js';
import { ClaudeCodeBackend } from '../dist-electron/backends/claude-code-adapter.js';
import { CodexBackend } from '../dist-electron/backends/codex-adapter.js';
import { WorkerCliBridge } from '../dist-electron/worker-cli-bridge.js';
import { CODEX_TERMINAL_PROFILE } from '../dist-electron/backends/codex-terminal-adapter.js';
import { CLAUDE_TERMINAL_PROFILE } from '../dist-electron/backends/claude-terminal-adapter.js';
import { KIMI_TERMINAL_PROFILE } from '../dist-electron/backends/kimi-terminal-adapter.js';
import { QODER_TERMINAL_PROFILE } from '../dist-electron/backends/qoder-terminal-adapter.js';
import { TerminalCliBackend } from '../dist-electron/backends/terminal-cli-adapter.js';

test('automatic workers use each native CLI permission mode without disabling Codex sandboxing', () => {
  const config = { cwd: process.cwd(), executionRole: 'worker', unattended: true, autoApproveScope: 'off' };
  const codex = CODEX_TERMINAL_PROFILE.buildCliArgs(config);
  assert.equal(codex[codex.indexOf('--ask-for-approval') + 1], 'never');
  assert.equal(codex[codex.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(!codex.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(CLAUDE_TERMINAL_PROFILE.buildCliArgs(config).includes('--dangerously-skip-permissions'));
  assert.ok(KIMI_TERMINAL_PROFILE.buildCliArgs(config).includes('--auto'));
  assert.ok(QODER_TERMINAL_PROFILE.buildCliArgs(config).includes('--yolo'));
  const host = { ...config, executionRole: 'host' };
  assert.ok(!CLAUDE_TERMINAL_PROFILE.buildCliArgs(host).includes('--dangerously-skip-permissions'));
  assert.ok(!QODER_TERMINAL_PROFILE.buildCliArgs(host).includes('--yolo'));
});

test('automatic worker permission requests never call Host or application authority evaluation', async () => {
  const resolutions = [];
  const scheduler = new WorkerScheduler({
    cwd: process.cwd(), emit() {}, approvalMode: 'auto', autoApproveScope: 'off',
    sessionFactory() { throw new Error('no process expected'); }, buildWorkerMcp() { return {}; },
    getTalker() { throw new Error('Host must not participate'); },
    isClosed: () => false, getSpeechFilterMode: () => 'off',
    normalizePermissionRequest() { throw new Error('application must not reinterpret native tools'); },
    persistPermissionDecision() { throw new Error('no approval journal expected'); },
  });
  const handle = { session: { resolvePermission(...args) { resolutions.push(args); } } };
  await scheduler.handlePermissionRequest(handle, {
    kind: 'permission-request', id: 'native', toolName: 'NativeTool', input: {}, toolUseID: 'native',
  });
  assert.deepEqual(resolutions, [['native', 'allow', 'auto-approval']]);
  const running = {
    id: 'native', status: 'running', session: {
      sendUserText() { throw new Error('no Host nudge expected'); },
    },
    live: { lastUpdateTs: 0 }, bufferedUpdates: [],
  };
  scheduler.workers.set('native', running);
  scheduler.queueWorkerUpdate(running, 'native tool progress');
  scheduler.sweepStalls();
  assert.deepEqual(running.bufferedUpdates, []);
  assert.equal(running.flushTimer, undefined);
  assert.equal(running.status, 'running');
});

test('native Claude workers retain user hooks, skills and MCP instead of a broker settings overlay', async () => {
  let input;
  const query = {
    initializationResult: async () => ({ session_id: 'native-worker' }),
    [Symbol.asyncIterator]() { return this; }, next() { return new Promise(() => {}); },
    async interrupt() {}, async setPermissionMode() {}, close() {},
  };
  const backend = new ClaudeCodeBackend({ queryFactory: (value) => { input = value; return query; } });
  const events = [];
  const session = backend.createSession({
    cwd: process.cwd(), executionRole: 'worker', unattended: true,
    skills: 'all', mcpServers: { nativeServer: { command: 'native-mcp' } },
  }, (event) => events.push(event));
  try {
    await session.start();
    assert.equal(input.options.permissionMode, 'bypassPermissions');
    assert.equal(input.options.settingsPath, undefined);
    assert.equal(input.options.skills, 'all');
    assert.ok(input.options.mcpServers.nativeServer);
    assert.deepEqual(input.options.settingSources, ['user', 'project', 'local']);
    const decision = await input.options.canUseTool('NativeTool', { value: 1 }, { toolUseID: 'tool' });
    assert.equal(decision.behavior, 'allow');
    assert.ok(!events.some((event) => event.kind === 'permission-request'));
  } finally { session.end(); }
});

test('native Codex SDK worker policy does not require Host permission callbacks', async () => {
  let options;
  class FakeCodex {
    startThread(value) {
      options = value;
      return { id: 'native-worker', runStreamed: async () => ({ events: (async function* () {})() }) };
    }
  }
  const backend = new CodexBackend({ resolveBinary: () => '/fake/codex', loadSdk: async () => FakeCodex });
  const session = backend.createSession({ cwd: process.cwd(), executionRole: 'worker', unattended: true }, () => {});
  try {
    await session.start();
    assert.equal(options.approvalPolicy, 'never');
    assert.equal(options.sandboxMode, 'workspace-write');
  } finally { session.end(); }
});

test('automatic worker communication accepts the final report without asking Host during execution', async () => {
  const bridge = new WorkerCliBridge();
  let questions = 0;
  let reports = 0;
  const binding = await bridge.bind({
    ask: async () => { questions++; }, inbox: async () => ({ messages: [] }),
    report: async () => { reports++; return { status: 'received' }; },
  }, { completionOnly: true });
  const request = async (body) => {
    const response = await fetch(binding.env.AHASTATION_WORKER_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${binding.env.AHASTATION_WORKER_TOKEN}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.doesNotMatch(binding.prompt, /aha-worker ask/);
    const question = await request({ command: 'ask', question: 'approve this tool?' });
    assert.equal(question.status, 400);
    assert.match(question.body.error, /final WorkReport/);
    assert.equal(questions, 0);
    const report = await request({ command: 'report', report: { status: 'completed', summary: 'done', files: [], tests: [], unresolved: [] } });
    assert.equal(report.body.result.status, 'received');
    assert.equal(reports, 1);
  } finally { binding.dispose(); bridge.close(); }
});

test('native terminal workers keep CLI config homes and hooks without application overlays', async () => {
  for (const profile of [CODEX_TERMINAL_PROFILE, CLAUDE_TERMINAL_PROFILE, KIMI_TERMINAL_PROFILE, QODER_TERMINAL_PROFILE]) {
    let launch;
    const backend = new TerminalCliBackend({ ...profile, sessionTranscript: undefined,
      registerTurnHook() { throw new Error('native Worker must retain its own hooks/config'); },
    }, { resolveBinary: () => '/fake/cli', timersEnabled: false, host: {
      spawn(_id, spec) { launch = spec; return 7; },
      onData() { return () => {}; }, onExit() { return () => {}; }, kill() {},
    } });
    const session = backend.createSession({ cwd: process.cwd(), executionRole: 'worker', unattended: true,
      env: { KIMI_CODE_HOME: 'user-native-home' }, extra: { workerId: `native-${profile.id}` },
    }, () => {});
    try {
      await session.start();
      assert.equal(launch.env.KIMI_CODE_HOME, 'user-native-home');
      assert.ok(!launch.args.includes('--settings'));
      assert.ok(!launch.args.some((arg) => arg.startsWith('hooks.Stop=')));
    } finally { session.end(); }
  }
});
