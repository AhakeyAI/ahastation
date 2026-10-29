import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import test from 'node:test';

import { CodexBackend, describeCodexTurnError } from '../dist-electron/backends/codex-adapter.js';

function makeSession(commands, events = []) {
  return new CodexBackend().createSession({
    cwd: process.cwd(),
    extra: { meetingCommandHandler: (command) => commands.push(command) },
  }, (event) => events.push(event));
}

test('Codex worker task profile reaches native SDK thread options', async () => {
  let threadOptions;
  const thread = {
    id: 'thread-profile',
    async runStreamed() {
      return {
        events: (async function* emptyEvents() {})(),
      };
    },
  };
  class FakeCodex {
    startThread(options) {
      threadOptions = options;
      return thread;
    }
  }
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    loadSdk: async () => FakeCodex,
  });
  const taskProfile = backend.compileTaskProfile({
    schemaVersion: 1,
    backendId: 'codex',
    modelPreference: 'gpt-5.4',
    workMode: 'deep',
    contextMode: 'meeting-summary',
    timeoutMs: 1_800_000,
    maxTokenBudget: 200_000,
  }, {
    schemaVersion: 1,
    backendId: 'codex',
    runtimeVersion: '0.156.1',
  });
  const session = backend.createSession({
    cwd: process.cwd(),
    model: taskProfile.model,
    taskProfile,
    executionRole: 'worker',
  }, () => {});

  await session.start();
  assert.equal(threadOptions.model, 'gpt-5.4');
  assert.equal(threadOptions.modelReasoningEffort, 'high');
  session.end();
});

test('Codex adapter hides speak protocol frames and dispatches commands', () => {
  const commands = [];
  const session = makeSession(commands);
  const message = session.normalizeItem({
    type: 'agent_message',
    text: '欢迎回来。\n```meeting-command\n{"kind":"speak","text":"欢迎回来。"}\n```\n```meeting-command\n{"kind":"speak","text":""}\n```',
  });
  assert.equal(message, null);
  assert.deepEqual(commands, [
    { kind: 'speak', text: '欢迎回来。' },
    { kind: 'speak', text: '' },
  ]);
});

test('Codex worker items translate to semantic signals and strict WorkReport', async () => {
  const {
    mapCodexItemToWorkerSignals,
    finalizeCodexWorkerText,
  } = await import('../dist-electron/backends/codex-adapter.js');
  assert.deepEqual(
    mapCodexItemToWorkerSignals({
      id: 'cmd-1',
      type: 'commandExecution',
      command: 'npm test',
      status: 'completed',
      exitCode: 0,
      aggregatedOutput: '74 tests passed',
    }),
    [{
      kind: 'tool',
      toolName: 'Bash',
      phase: 'completed',
      detail: 'npm test',
      callId: 'cmd-1',
      output: '74 tests passed',
      exitCode: 0,
    }],
  );
  assert.deepEqual(
    mapCodexItemToWorkerSignals({
      type: 'fileChange',
      status: 'completed',
      changes: [{ path: 'src/app.ts' }],
    }),
    [{ kind: 'tool', toolName: 'Write', phase: 'completed', detail: 'src/app.ts' }],
  );
  const report = {
    status: 'completed',
    summary: 'done',
    files: [{ path: 'src/app.ts', action: 'modified' }],
    tests: [{ command: 'npm test', status: 'passed' }],
    unresolved: [],
  };
  assert.deepEqual(
    finalizeCodexWorkerText(`\`\`\`work-report\n${JSON.stringify(report)}\n\`\`\``),
    [
      { kind: 'delivery', report },
      { kind: 'ended', reason: 'completed' },
    ],
  );
  assert.equal(finalizeCodexWorkerText('done')[0].code, 'missing-work-report');
});

test('Codex adapter preserves normal text while removing non-speak command frames', () => {
  const commands = [];
  const session = makeSession(commands);
  const message = session.normalizeItem({
    type: 'agent_message',
    text: '我先安排任务。\n```meeting-command\n{"kind":"propose-plan","tasks":[]}\n```',
  });
  assert.equal(message.message.content[0].text, '我先安排任务。');
  assert.deepEqual(commands, [{ kind: 'propose-plan', tasks: [] }]);
});

test('Codex adapter acknowledges non-speak command-only output instead of leaving chat silent', () => {
  const session = makeSession([]);
  const message = session.normalizeItem({
    type: 'agent_message',
    text: '```meeting-command\n{"kind":"broadcast-hosts","question":"status?"}\n```',
  });
  assert.equal(message.message.content[0].text, '我正在处理，有结果会马上告诉你。');
});

test('Codex adapter collapses an authentication failure into one auth-required event', () => {
  const events = [];
  const session = makeSession([], events);
  assert.equal(session.normalizeEvent({
    type: 'item.completed',
    item: { id: 'error-1', type: 'error', message: 'Item error' },
  }), null);
  assert.equal(session.normalizeEvent({
    type: 'turn.failed',
    error: { message: 'unexpected status 401 Unauthorized: Missing bearer authentication' },
  }), null);
  assert.deepEqual(events, [{
    kind: 'auth-required',
    error: 'Codex 登录已失效，请完成重新认证后重连 Host。',
  }]);
});

test('Codex adapter maps the official command execution shape without losing output', () => {
  const session = makeSession([]);
  const message = session.normalizeItem({
    id: 'cmd-1',
    type: 'command_execution',
    command: 'npm test',
    aggregated_output: '74 tests passed',
    exit_code: 0,
    status: 'completed',
  });
  assert.deepEqual(message.message.content, [
    { type: 'tool_use', id: 'cmd-1', name: 'Bash', input: { command: 'npm test' } },
    { type: 'tool_result', tool_use_id: 'cmd-1', content: '74 tests passed' },
  ]);
});

test('Codex command completion has a terminal result even when output is empty', () => {
  const session = makeSession([]);
  const message = session.normalizeItem({
    id: 'cmd-empty', type: 'command_execution', command: 'false',
    aggregated_output: '', exit_code: 1, status: 'failed',
  });
  assert.deepEqual(message.message.content[1], {
    type: 'tool_result', tool_use_id: 'cmd-empty', content: '[failed; exit 1]', is_error: true,
  });
});

test('Codex adapter maps every path in the official file change shape', () => {
  const session = makeSession([]);
  const message = session.normalizeItem({
    id: 'patch-1',
    type: 'file_change',
    changes: [
      { path: 'src/a.ts', kind: 'update' },
      { path: 'src/b.ts', kind: 'add' },
    ],
    status: 'completed',
  });
  assert.deepEqual(message.message.content, [
    { type: 'tool_use', id: 'patch-1:0', name: 'Write', input: { file_path: 'src/a.ts', change_kind: 'update', status: 'completed' } },
    { type: 'tool_use', id: 'patch-1:1', name: 'Write', input: { file_path: 'src/b.ts', change_kind: 'add', status: 'completed' } },
  ]);
});

test('Codex adapter maps official MCP server, tool, arguments and result', () => {
  const session = makeSession([]);
  const message = session.normalizeItem({
    id: 'mcp-1',
    type: 'mcp_tool_call',
    server: 'meeting-worker',
    tool: 'task_done',
    arguments: { summary: 'finished' },
    result: { content: [{ type: 'text', text: 'ok' }], structured_content: null },
    status: 'completed',
  });
  assert.deepEqual(message.message.content, [
    { type: 'tool_use', id: 'mcp-1', name: 'mcp__meeting-worker__task_done', input: { summary: 'finished' } },
    { type: 'tool_result', tool_use_id: 'mcp-1', content: '[{"type":"text","text":"ok"}]' },
  ]);
});

test('Codex maps official reasoning, web search and todo items', () => {
  const session = makeSession([]);
  assert.equal(session.normalizeItem({ id: 'r1', type: 'reasoning', text: 'Checked constraints' }).message.content[0].text, 'Checked constraints');
  assert.deepEqual(session.normalizeItem({ id: 'w1', type: 'web_search', query: 'official docs' }).message.content, [
    { type: 'tool_use', id: 'w1', name: 'WebSearch', input: { query: 'official docs' } },
    { type: 'tool_result', tool_use_id: 'w1', content: 'Search completed' },
  ]);
  assert.equal(session.normalizeItem({
    id: 't1', type: 'todo_list', items: [{ text: 'Map events', completed: true }, { text: 'Ship', completed: false }],
  }).message.content[0].text, '[x] Map events\n[ ] Ship');
});

test('Codex readiness rejects when the handshake reports expired authentication', async () => {
  const events = [];
  const thread = {
    async runStreamed() {
      return {
        events: (async function* () {
          yield {
            type: 'turn.failed',
            error: { message: '401 Unauthorized: token revoked' },
          };
        })(),
      };
    },
  };
  class FakeCodex {
    startThread() { return thread; }
  }
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    loadSdk: async () => FakeCodex,
  });
  const session = backend.createSession({ cwd: process.cwd() }, (event) => events.push(event));

  await assert.rejects(session.start(), /authentication required/i);
  assert.deepEqual(events, [{
    kind: 'auth-required',
    error: 'Codex 登录已失效，请完成重新认证后重连 Host。',
  }]);
});

test('Codex captures the official thread id and resumes it on the next session', async () => {
  const calls = [];
  const makeThread = () => ({
    id: null,
    async runStreamed() {
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'thread-123' };
        yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
      })() };
    },
  });
  class FakeCodex {
    startThread(options) { calls.push(['start', options]); return makeThread(); }
    resumeThread(id, options) { calls.push(['resume', id, options]); return makeThread(); }
  }
  const backend = new CodexBackend({ resolveBinary: () => '/fake/codex', loadSdk: async () => FakeCodex });
  const first = backend.createSession({ cwd: '/workspace' }, () => {});
  await first.start();
  assert.deepEqual(first.snapshot(), { protocol: 'codex-sdk', sessionId: 'thread-123' });
  assert.equal(calls[0][1].sandboxMode, 'read-only');
  assert.equal(calls[0][1].approvalPolicy, 'never');

  const resumed = backend.createSession({ cwd: '/workspace', resumeSessionId: 'thread-123' }, () => {});
  await resumed.start();
  assert.equal(calls[1][0], 'resume');
  assert.equal(calls[1][1], 'thread-123');
  first.end();
  resumed.end();
});

test('Codex capability flags expose app-server Worker approvals without claiming MCP', () => {
  const capabilities = new CodexBackend().capabilities;
  assert.equal(capabilities.mcp, false);
  assert.equal(capabilities.permissions, true);
  assert.equal(capabilities.executeTasks, true);
});

test('Codex materializes base64 images securely and removes them after the turn', async () => {
  let finishTurn;
  const turnFinished = new Promise((resolve) => { finishTurn = resolve; });
  let imagePath;
  class FakeCodex {
    startThread() {
      let call = 0;
      return {
        id: 'thread-image',
        async runStreamed(input) {
          call += 1;
          if (call === 1) return { events: (async function* () {})() };
          assert.equal(Array.isArray(input), true);
          assert.deepEqual(input[0], { type: 'text', text: 'inspect this' });
          assert.equal(input[1].type, 'local_image');
          imagePath = input[1].path;
          assert.deepEqual(await readFile(imagePath), Buffer.from('secure-image'));
          if (process.platform !== 'win32') {
            assert.equal((await stat(imagePath)).mode & 0o777, 0o600);
          }
          return { events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
            finishTurn();
          })() };
        },
      };
    }
  }
  const backend = new CodexBackend({ resolveBinary: () => '/fake/codex', loadSdk: async () => FakeCodex });
  const session = backend.createSession({ cwd: '/workspace' }, () => {});
  await session.start();
  session.sendUserContent([
    { type: 'text', text: 'inspect this' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('secure-image').toString('base64') } },
  ]);
  await turnFinished;
  for (let i = 0; i < 20; i += 1) {
    try { await access(imagePath); } catch { break; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await assert.rejects(access(imagePath));
  session.end();
});

test('Codex interrupt cancels an image turn from the moment it is queued', async () => {
  let calls = 0;
  class FakeCodex {
    startThread() {
      return {
        id: 'thread-interrupt',
        async runStreamed() {
          calls += 1;
          return { events: (async function* () {})() };
        },
      };
    }
  }
  const backend = new CodexBackend({ resolveBinary: () => '/fake/codex', loadSdk: async () => FakeCodex });
  const session = backend.createSession({ cwd: '/workspace' }, () => {});
  await session.start();
  session.sendUserContent([{
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: Buffer.from('cancel-me').toString('base64') },
  }]);
  await session.interrupt();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, 'only the readiness turn reached the SDK');
  session.end();
});

test('Codex production app-server session becomes ready without a model turn', async () => {
  const calls = [];
  const events = [];
  let notification;
  const transport = {
    async start() { calls.push('initialize/account'); return { userAgent: 'Codex/0.156.1', account: { type: 'chatgpt' } }; },
    async openThread() { calls.push('thread/start'); return 'app-thread-1'; },
    async resumeThread(id) { calls.push(`thread/resume:${id}`); return id; },
    async startTurn(_threadId, input) {
      calls.push(['turn/start', input]);
      queueMicrotask(() => {
        notification({ method: 'item/completed', params: {
          item: { type: 'agentMessage', id: 'a1', text: 'hello from app-server' },
          threadId: 'app-thread-1', turnId: 'turn-1',
        } });
        notification({ method: 'turn/completed', params: {
          threadId: 'app-thread-1', turn: { id: 'turn-1', status: 'completed', error: null },
        } });
      });
      return 'turn-1';
    },
    async interruptTurn() {},
    close() { calls.push('close'); },
  };
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    createAppServerTransport: (options) => { notification = options.onNotification; return transport; },
  });
  const session = backend.createSession({
    cwd: '/workspace', executionRole: 'host', extra: { codexTransport: 'app-server' },
  }, (event) => events.push(event));
  await session.start();
  assert.deepEqual(calls, ['initialize/account', 'thread/start']);
  assert.deepEqual(session.snapshot(), {
    protocol: 'codex-app-server', protocolVersion: 'v2',
    sessionId: 'app-thread-1', backendVersion: '0.156.1',
  });
  session.sendUserText('actual user input');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[2][0], 'turn/start');
  assert.equal(events[0].message.message.content[0].text, 'hello from app-server');
  session.end();
});

test('Codex app-server host emits turn-status around the turn lifecycle', async () => {
  const events = [];
  let notification;
  const transport = {
    async start() { return { userAgent: 'Codex/0.156.1', account: { type: 'chatgpt' } }; },
    async openThread() { return 'app-thread-ts'; },
    async resumeThread(id) { return id; },
    async startTurn() {
      queueMicrotask(() => {
        notification({ method: 'turn/started', params: {
          threadId: 'app-thread-ts', turn: { id: 'turn-ts', status: 'inProgress' },
        } });
        notification({ method: 'turn/completed', params: {
          threadId: 'app-thread-ts', turn: { id: 'turn-ts', status: 'completed', error: null },
        } });
      });
      return 'turn-ts';
    },
    async interruptTurn() {},
    close() {},
  };
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    createAppServerTransport: (options) => { notification = options.onNotification; return transport; },
  });
  const session = backend.createSession({
    cwd: '/workspace', executionRole: 'host', extra: { codexTransport: 'app-server' },
  }, (event) => events.push(event));
  await session.start();
  session.sendUserText('hi');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    { kind: 'turn-status', status: 'started' },
    { kind: 'turn-status', status: 'completed' },
  ]);
  session.end();
});

test('Codex app-server worker does not emit turn-status events', async () => {
  const events = [];
  let notification;
  const transport = {
    async start() { return { userAgent: 'Codex/0.156.1', account: { type: 'chatgpt' } }; },
    async openThread() { return 'app-thread-wts'; },
    async resumeThread(id) { return id; },
    async startTurn() {
      queueMicrotask(() => {
        notification({ method: 'turn/started', params: {
          threadId: 'app-thread-wts', turn: { id: 'turn-wts', status: 'inProgress' },
        } });
        notification({ method: 'turn/completed', params: {
          threadId: 'app-thread-wts', turn: { id: 'turn-wts', status: 'completed', error: null },
        } });
      });
      return 'turn-wts';
    },
    async interruptTurn() {},
    close() {},
  };
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    createAppServerTransport: (options) => { notification = options.onNotification; return transport; },
  });
  const session = backend.createSession({
    cwd: '/workspace', executionRole: 'worker', extra: { codexTransport: 'app-server' },
  }, (event) => events.push(event));
  await session.start();
  session.sendUserText('do work');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((e) => e.kind === 'turn-status'), false);
  session.end();
});

test('Codex app-server receives the compiled task model and reasoning effort', async () => {
  let openOptions;
  const transport = {
    async start() {
      return { userAgent: 'Codex/0.156.1', account: { type: 'chatgpt' } };
    },
    async openThread(options) {
      openOptions = options;
      return 'app-thread-profile';
    },
    async resumeThread(id) { return id; },
    async startTurn() { return 'turn-unused'; },
    async interruptTurn() {},
    close() {},
  };
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    createAppServerTransport: () => transport,
  });
  const taskProfile = backend.compileTaskProfile({
    schemaVersion: 1,
    backendId: 'codex',
    modelPreference: 'gpt-5.4',
    workMode: 'deep',
    contextMode: 'meeting-summary',
    timeoutMs: 1_800_000,
    maxTokenBudget: 200_000,
  }, {
    schemaVersion: 1,
    backendId: 'codex',
    runtimeVersion: '0.156.1',
  });
  const session = backend.createSession({
    cwd: '/workspace',
    executionRole: 'worker',
    model: taskProfile.model,
    taskProfile,
    extra: { codexTransport: 'app-server' },
  }, () => {});

  await session.start();
  assert.equal(openOptions.model, 'gpt-5.4');
  assert.equal(openOptions.modelReasoningEffort, 'high');
  session.end();
});

test('Codex app-server Worker emits no provider messages and synthesizes WorkReport', async () => {
  let notify;
  const events = [];
  const report = {
    status: 'completed',
    summary: 'implemented',
    files: [{ path: 'src/app.ts', action: 'modified' }],
    tests: [{ command: 'npm test', status: 'passed' }],
    unresolved: [],
  };
  const transport = {
    async start() { return { userAgent: 'Codex/0.156.1', account: { type: 'chatgpt' } }; },
    async openThread() { return 'codex-worker'; },
    async resumeThread(id) { return id; },
    async startTurn() {
      queueMicrotask(() => {
        notify({ method: 'item/completed', params: {
          item: {
            type: 'agentMessage',
            id: 'worker-output',
            text: `working\n\`\`\`work-report\n${JSON.stringify(report)}\n\`\`\``,
          },
        } });
        notify({ method: 'turn/completed', params: {
          turn: { id: 'turn-worker', status: 'completed', error: null },
        } });
      });
      return 'turn-worker';
    },
    async interruptTurn() {},
    close() {},
  };
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    createAppServerTransport(options) {
      notify = options.onNotification;
      return transport;
    },
  });
  const session = backend.createSession({
    cwd: '/workspace',
    executionRole: 'worker',
    extra: { codexTransport: 'app-server' },
  }, (event) => events.push(event));
  await session.start();
  session.sendUserText('do it');
  const deadline = Date.now() + 1_000;
  while (!events.some((event) => event.kind === 'worker-signal'
    && event.signal.kind === 'ended') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(events.some((event) => event.kind === 'message'), false);
  assert.deepEqual(events, [
    { kind: 'worker-signal', signal: { kind: 'progress', message: 'working' } },
    { kind: 'worker-signal', signal: { kind: 'delivery', report } },
    { kind: 'worker-signal', signal: { kind: 'ended', reason: 'completed' } },
  ]);
  session.end();
});

test('Codex app-server maps command approval through the common permission contract', async () => {
  let requestApproval;
  const events = [];
  const transport = {
    async start() { return { userAgent: 'Codex/0.156.1', account: { type: 'chatgpt' } }; },
    async openThread() { return 'codex-permission'; },
    async resumeThread(id) { return id; },
    async startTurn() { return 'turn-permission'; },
    async interruptTurn() {},
    close() {},
  };
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    createAppServerTransport(options) {
      requestApproval = options.onRequest;
      return transport;
    },
  });
  const session = backend.createSession({
    cwd: '/workspace',
    executionRole: 'worker',
    extra: { codexTransport: 'app-server' },
  }, (event) => events.push(event));
  await session.start();
  const responsePromise = requestApproval({
    id: 'approval-7',
    method: 'item/commandExecution/requestApproval',
    params: {
      itemId: 'item-shell',
      command: 'npm test',
      cwd: '/workspace',
      reason: 'run acceptance tests',
    },
  });
  assert.deepEqual(events[0], {
    kind: 'permission-request',
    id: 'codex:1:approval-7',
    toolName: 'Bash',
    input: {
      command: 'npm test',
      cwd: '/workspace',
      reason: 'run acceptance tests',
      commandActions: [],
      additionalPermissions: null,
    },
    toolUseID: 'item-shell',
  });
  session.resolvePermission('codex:1:approval-7', 'allow');
  assert.deepEqual(await responsePromise, { decision: 'accept' });
  session.end();
});

test('Codex approved commands wait for host baselines and fail on out-of-scope writes', async () => {
  let requestApproval;
  let notify;
  let releaseBefore;
  const events = [];
  const calls = [];
  const guard = {
    before(commandId) {
      calls.push(['before', commandId]);
      return new Promise((resolve) => { releaseBefore = resolve; });
    },
    async after(commandId) {
      calls.push(['after', commandId]);
      const error = new Error('modified: test/escape.ts');
      error.code = 'approved-command-scope-violation';
      throw error;
    },
    cancel() {},
    clear() {},
  };
  const transport = {
    async start() { return { userAgent: 'Codex/0.156.1', account: { type: 'chatgpt' } }; },
    async openThread() { return 'codex-guard'; },
    async resumeThread(id) { return id; },
    async startTurn() { return 'turn-guard'; },
    async interruptTurn() {},
    close() {},
  };
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    createAppServerTransport(options) {
      requestApproval = options.onRequest;
      notify = options.onNotification;
      return transport;
    },
  });
  const session = backend.createSession({
    cwd: '/workspace',
    executionRole: 'worker',
    extra: { codexTransport: 'app-server', approvedCommandGuard: guard },
  }, (event) => events.push(event));
  await session.start();
  let response;
  const responsePromise = requestApproval({
    id: 'approval-guard',
    method: 'item/commandExecution/requestApproval',
    params: { itemId: 'command-guard', command: 'npm test', cwd: '/workspace' },
  }).then((value) => { response = value; });
  session.resolvePermission('codex:1:approval-guard', 'allow');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(response, undefined);
  releaseBefore();
  await responsePromise;
  assert.deepEqual(response, { decision: 'accept' });
  notify({ method: 'item/completed', params: { item: {
    type: 'commandExecution', id: 'command-guard', command: 'npm test', status: 'completed', exitCode: 0,
  } } });
  const deadline = Date.now() + 1_000;
  while (!events.some((event) => event.kind === 'worker-signal'
    && event.signal.kind === 'failed') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(calls, [['before', 'command-guard'], ['after', 'command-guard']]);
  const failure = events.find((event) => event.kind === 'worker-signal' && event.signal.kind === 'failed');
  assert.equal(failure.signal.code, 'approved-command-scope-violation');
  assert.equal(failure.signal.retryable, false);
  assert.equal(events.some((event) => event.kind === 'worker-signal'
    && event.signal.kind === 'tool' && event.signal.phase === 'completed'), false);
  session.end();
});

test('Codex app-server crash denies pending approvals and releases Worker waiters', async () => {
  let requestApproval;
  let exit;
  const events = [];
  const transport = {
    async start() { return { userAgent: 'Codex/0.156.1', account: { type: 'chatgpt' } }; },
    async openThread() { return 'codex-crash'; },
    async resumeThread(id) { return id; },
    async startTurn() { return 'turn-crash'; },
    async interruptTurn() {},
    close() {},
  };
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    createAppServerTransport(options) {
      requestApproval = options.onRequest;
      exit = options.onExit;
      return transport;
    },
  });
  const session = backend.createSession({
    cwd: '/workspace',
    executionRole: 'worker',
    extra: { codexTransport: 'app-server' },
  }, (event) => events.push(event));
  await session.start();
  const response = requestApproval({
    id: 'approval-crash',
    method: 'item/fileChange/requestApproval',
    params: { itemId: 'file-change', reason: 'write output' },
  });

  exit(new Error('process vanished'));

  assert.deepEqual(await response, { decision: 'decline' });
  assert.deepEqual(events.slice(-3), [
    { kind: 'permission-cancelled', id: 'codex:1:approval-crash' },
    {
      kind: 'worker-signal',
      signal: {
        kind: 'failed',
        code: 'codex-app-server-exited',
        message: 'Codex app-server error: process vanished',
        retryable: true,
      },
    },
    { kind: 'worker-signal', signal: { kind: 'ended', reason: 'crashed' } },
  ]);
  session.end();
});

test('Codex app-server surfaces an acknowledgement for command-only host output', async () => {
  let notification;
  const events = [];
  const commands = [];
  const transport = {
    async start() { return { userAgent: 'Codex/0.156.1', account: { type: 'chatgpt' } }; },
    async openThread() { return 'app-thread-command'; },
    async resumeThread(id) { return id; },
    async startTurn() {
      queueMicrotask(() => {
        notification({ method: 'item/completed', params: {
          item: {
            type: 'agentMessage', id: 'command-only',
            text: '```meeting-command\n{"kind":"broadcast-hosts","question":"status?"}\n```',
          },
        } });
        notification({ method: 'turn/completed', params: {
          turn: { id: 'turn-command', status: 'completed', error: null },
        } });
      });
      return 'turn-command';
    },
    async interruptTurn() {},
    close() {},
  };
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    createAppServerTransport: (options) => { notification = options.onNotification; return transport; },
  });
  const session = backend.createSession({
    cwd: '/workspace',
    extra: {
      codexTransport: 'app-server',
      meetingCommandHandler: (command) => commands.push(command),
    },
  }, (event) => events.push(event));
  await session.start();
  session.sendUserText('ask experts');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands, [{ kind: 'broadcast-hosts', question: 'status?' }]);
  assert.equal(events[0].message.message.content[0].text, '我正在处理，有结果会马上告诉你。');
  session.end();
});

test('Codex app-server interrupt shares the authoritative turn completion waiter', async () => {
  let notify;
  let turnNumber = 0;
  const transport = {
    async start() { return { userAgent: 'Codex/0.156.1', account: { type: 'chatgpt' } }; },
    async openThread() { return 'thread-interrupt'; },
    async resumeThread(id) { return id; },
    async startTurn() { turnNumber += 1; return `turn-${turnNumber}`; },
    async interruptTurn(_threadId, turnId) {
      queueMicrotask(() => notify({ method: 'turn/completed', params: {
        threadId: 'thread-interrupt', turn: { id: turnId, status: 'interrupted', error: null },
      } }));
    },
    close() {},
  };
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    createAppServerTransport: (options) => { notify = options.onNotification; return transport; },
  });
  const session = backend.createSession({
    cwd: '/workspace', extra: { codexTransport: 'app-server' },
  }, () => {});
  await session.start();
  session.sendUserText('long turn');
  await new Promise((resolve) => setImmediate(resolve));
  await session.interrupt();
  session.sendUserText('next turn');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(turnNumber, 2, 'the queue advances after authoritative interrupted completion');
  session.end();
});

test('Codex app-server steering queues the next turn after interrupt acknowledgement', async () => {
  let notify;
  let turnNumber = 0;
  let interruptedTurn;
  const transport = {
    async start() { return { userAgent: 'Codex/0.156.1', account: { type: 'chatgpt' } }; },
    async openThread() { return 'thread-steer'; },
    async resumeThread(id) { return id; },
    async startTurn() {
      turnNumber += 1;
      return `turn-${turnNumber}`;
    },
    async interruptTurn(_threadId, turnId) {
      interruptedTurn = turnId;
    },
    close() {},
  };
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    createAppServerTransport: (options) => {
      notify = options.onNotification;
      return transport;
    },
  });
  const session = backend.createSession({
    cwd: '/workspace',
    executionRole: 'worker',
    extra: { codexTransport: 'app-server' },
  }, () => {});
  await session.start();
  session.sendUserText('long turn');
  await new Promise((resolve) => setImmediate(resolve));

  await session.interrupt('steer');
  assert.equal(interruptedTurn, 'turn-1');
  session.sendUserText('steering update');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(turnNumber, 1, 'steering must remain behind the interrupted native turn');

  notify({
    method: 'turn/completed',
    params: {
      threadId: 'thread-steer',
      turn: { id: 'turn-1', status: 'interrupted', error: null },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(turnNumber, 2, 'queued steering starts after authoritative turn completion');
  session.end();
});

// --- Model suggestions and unsupported-model diagnostics -------------------

test('Codex model suggestions never include third-party IDs the service rejects', () => {
  const { models } = new CodexBackend().capabilities;
  assert.ok(models.includes('gpt-5.4'), 'first-party suggestions remain available');
  assert.equal(models.some((model) => model.toLowerCase().includes('glm')), false,
    'glm-* IDs 400 under ChatGPT-account auth and must not be suggested');
});

test('an unsupported-model 400 becomes an actionable message, other errors pass through', () => {
  const raw = "The 'glm-5.2' model is not supported when signed in with ChatGPT.";
  const described = describeCodexTurnError(raw);
  assert.ok(described.startsWith(raw), 'the raw service detail is preserved');
  assert.ok(described.includes('\"glm-5.2\"'), 'the rejected model ID is named');
  assert.ok(described.includes('gpt-5.x'), 'the message suggests a supported model family');
  assert.ok(described.includes('API key'), 'the message suggests the API-key escape hatch');

  const unrelated = 'stream disconnected before completion';
  assert.equal(describeCodexTurnError(unrelated), unrelated);
});


test('Codex fileChange approval resolves paths via the itemId cache (A-16)', async () => {
  const events = [];
  let notification;
  let onRequest;
  const transport = {
    async start() { return { userAgent: 'Codex/0.156.1', account: { type: 'chatgpt' } }; },
    async openThread() { return 'app-thread-fc'; },
    async resumeThread(id) { return id; },
    async startTurn() { return 'turn-fc'; },
    async interruptTurn() {},
    close() {},
  };
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    createAppServerTransport: (options) => {
      notification = options.onNotification;
      onRequest = options.onRequest;
      return transport;
    },
  });
  const session = backend.createSession({
    cwd: '/workspace', executionRole: 'worker', extra: { codexTransport: 'app-server' },
  }, (event) => events.push(event));
  await session.start();

  notification({ method: 'item/started', params: {
    item: {
      type: 'fileChange',
      id: 'fc1',
      changes: [{ path: 'src/a.js', kind: 'update' }, { path: 'src/b.js', kind: 'add' }],
    },
    threadId: 'app-thread-fc', turnId: 'turn-fc',
  } });

  const pending = onRequest({ method: 'item/fileChange/requestApproval', id: 11, params: {
    itemId: 'fc1', reason: 'needs to write outside the sandbox', grantRoot: null,
  } });
  const request = events.find((event) => event.kind === 'permission-request');
  assert.ok(request, 'fileChange approval reaches the host');
  assert.deepEqual(request.input.paths, ['src/a.js', 'src/b.js']);
  assert.equal(request.toolUseID, 'fc1');

  session.resolvePermission(request.id, 'allow');
  assert.deepEqual(await pending, { decision: 'accept' });

  const unknown = onRequest({ method: 'item/fileChange/requestApproval', id: 12, params: {
    itemId: 'fc-unknown', reason: null, grantRoot: null,
  } });
  const unknownRequest = events.filter((event) => event.kind === 'permission-request').at(-1);
  assert.equal('paths' in unknownRequest.input, false, 'uncorrelated approvals stay path-less (and thus deniable)');
  session.resolvePermission(unknownRequest.id, 'deny');
  assert.deepEqual(await unknown, { decision: 'decline' });
  session.end();
});


test('Codex stop revokes unanswered approvals and declines new ones (A-20)', async () => {
  const events = [];
  let notification;
  let onRequest;
  const transport = {
    async start() { return { userAgent: 'Codex/0.156.1', account: { type: 'chatgpt' } }; },
    async openThread() { return 'app-thread-stop'; },
    async resumeThread(id) { return id; },
    async startTurn() { return 'turn-stop'; },
    async interruptTurn() {
      queueMicrotask(() => notification({ method: 'turn/completed', params: {
        threadId: 'app-thread-stop', turn: { id: 'turn-stop', status: 'completed', error: null },
      } }));
    },
    close() {},
  };
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    createAppServerTransport: (options) => {
      notification = options.onNotification;
      onRequest = options.onRequest;
      return transport;
    },
  });
  const session = backend.createSession({
    cwd: '/workspace', executionRole: 'worker', extra: { codexTransport: 'app-server' },
  }, (event) => events.push(event));
  await session.start();
  session.sendUserText('run a command');
  await new Promise((resolve) => setImmediate(resolve));

  const pending = onRequest({ method: 'item/commandExecution/requestApproval', id: 21, params: {
    itemId: 'cmd-1', command: 'npm test', cwd: '/workspace',
  } });
  const pendingResult = Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error('approval was not revoked on stop')), 1_000)),
  ]);

  await session.interrupt('user');
  assert.deepEqual(await pendingResult, { decision: 'decline' });
  assert.equal(events.some((event) => event.kind === 'permission-cancelled'), true);
  assert.equal(events.some((event) => event.kind === 'worker-signal'
    && event.signal.kind === 'ended' && event.signal.reason === 'interrupted'), true);

  const requestCount = events.filter((event) => event.kind === 'permission-request').length;
  const late = await onRequest({ method: 'item/commandExecution/requestApproval', id: 22, params: {
    itemId: 'cmd-2', command: 'rm -rf build', cwd: '/workspace',
  } });
  assert.deepEqual(late, { decision: 'decline' }, 'approvals after stop are declined immediately');
  assert.equal(events.filter((event) => event.kind === 'permission-request').length, requestCount);
  session.end();
});
