// Native CLI Worker N1–N8 verification suite (native-cli-self-approval mode).
// Uses hidden, owned fixtures (`windowsHide: true`), isolated temporary git
// repositories/worktrees, and real loopback `aha-worker` CLI invocations
// without accessing personal ~/.codex or ~/.claude credentials.

import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';

import { ClaudeTerminalBackend } from '../dist-electron/backends/claude-terminal-adapter.js';
import { CodexTerminalBackend } from '../dist-electron/backends/codex-terminal-adapter.js';
import {
  getBackendRegistry,
  resetBackendRegistry,
} from '../dist-electron/backends/registry.js';
import {
  TERMINAL_INPUT_PENDING_MARKER,
  TERMINAL_TASK_COMPLETE_MARKER,
  TERMINAL_TURN_ENDED_MARKER,
  TerminalCliSession,
} from '../dist-electron/backends/terminal-cli-adapter.js';
import { MeetingRepository } from '../dist-electron/meeting-repository.js';
import { Orchestrator } from '../dist-electron/orchestrator.js';
import { PtyHost } from '../dist-electron/pty-host.js';
import { removeBackendAuth, setBackendAuth, updateSettings } from '../dist-electron/store.js';
import { TaskMailbox } from '../dist-electron/task-mailbox.js';
import { assessTaskRecovery } from '../dist-electron/task-recovery.js';
import { TaskWorkspaceManager } from '../dist-electron/task-workspace.js';
import { resolveDefaultWorkerBackendId } from '../dist-electron/worker-backend-default.js';
import { WorkerScheduler } from '../dist-electron/worker-scheduler.js';
import {
  isWorkerBackendReady,
  resolvePlanDefaultWorkerBackendId,
  validatePlanDraft,
} from '../src/lib/plan-validation.ts';
import { isNativeCliWorkerBackendId } from '../src/lib/terminal-backends.ts';
import { testMeetingsPath } from './electron-stub-impl.mjs';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

function createTempGitRepo(t, prefix = 'aha-n1n8-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const repoDir = join(root, 'repo');
  const worktreesDir = join(root, 'worktrees');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'native-cli-test@example.com']);
  git(repoDir, ['config', 'user.name', 'Native CLI Test']);
  git(repoDir, ['config', 'commit.gpgsign', 'false']);
  git(repoDir, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repoDir, 'package.json'), '{"name":"aha-native-test","private":true,"type":"module"}\n', 'utf8');
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'hello.js'), 'export const greeting = "v0";\n', 'utf8');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'initial']);
  const cleanup = async () => {
    try {
      git(repoDir, ['worktree', 'prune']);
    } catch {
      // ignore cleanup failures
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { root, repoDir, worktreesDir, cleanup };
}

function createVersionStub(t, dir, name, versionOutput) {
  const stubPath = join(dir, `${name}.mjs`);
  writeFileSync(
    stubPath,
    `if (process.argv.includes('--version')) { console.log(${JSON.stringify(versionOutput)}); process.exit(0); }\nsetInterval(() => {}, 1000);\n`,
    'utf8',
  );
  return stubPath;
}

function createFakePty(pid = 42000) {
  return {
    pid,
    writes: [],
    killed: false,
    dataHandlers: [],
    exitHandlers: [],
    onData(cb) {
      this.dataHandlers.push(cb);
      return { dispose: () => {} };
    },
    onExit(cb) {
      this.exitHandlers.push(cb);
      return { dispose: () => {} };
    },
    write(data) {
      this.writes.push(data);
    },
    resize() {},
    kill() {
      if (this.killed) return;
      this.killed = true;
      this.emitExit(0);
    },
    emitData(data) {
      for (const cb of [...this.dataHandlers]) cb(data);
    },
    emitExit(exitCode) {
      for (const cb of [...this.exitHandlers]) cb({ exitCode });
    },
  };
}

function createStubCoordinatorBackend(id = 'claude-code') {
  return {
    id,
    capabilities: {
      coordinate: true,
      executeTasks: true,
      displayName: 'Stub Coordinator',
      iconId: 'claude',
      mcp: true,
      permissions: true,
      systemPrompt: true,
      skills: true,
      interrupt: true,
    },
    resolveBinary: () => '/fake/coordinator',
    buildEnv: (_auth, extra) => ({ ...(extra ?? {}) }),
    validateAuth: async () => ({ ok: true }),
    checkAuthStatus: async () => ({ loggedIn: true }),
    compileTaskProfile(requested, runtime) {
      return {
        schemaVersion: 1,
        backendId: id,
        runtimeVersion: runtime.runtimeVersion,
        model: requested.modelPreference ?? 'auto',
        unsupported: [],
        downgraded: [],
        capabilityHash: '0'.repeat(64),
      };
    },
    normalizePermissionRequest() {
      return { ok: false, diagnostic: 'stub', requiresUser: true };
    },
    createSession() {
      return {
        async start() {},
        end() {},
        sendUserText() {},
        sendUserContent() {},
        resolvePermission() {},
        async interrupt() {},
      };
    },
  };
}

async function runAhaWorkerShim(env, args) {
  const shimName = process.platform === 'win32' ? 'aha-worker.cmd' : 'aha-worker';
  const pathDirs = String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const shimPath = pathDirs.map((d) => join(d, shimName)).find((p) => existsSync(p));
  assert.ok(shimPath, `aha-worker shim must exist on worker PATH (${pathDirs.join(delimiter)})`);
  const isCmd = process.platform === 'win32';
  const file = isCmd ? (process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe') : shimPath;
  const cmdLine = `"${shimPath}" ${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`;
  const fullArgs = isCmd ? ['/d', '/s', '/c', `"${cmdLine}"`] : args;
  try {
    const { stdout } = await execFileAsync(file, fullArgs, {
      env,
      cwd: env.PWD || process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: isCmd,
      timeout: 10_000,
    });
    return { status: 0, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    return {
      status: err.code ?? err.status ?? 1,
      stdout: String(err.stdout ?? '').trim(),
      stderr: String(err.stderr ?? err.message ?? '').trim(),
    };
  }
}

async function runWorkerEntryDirect(env, args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [env.AHASTATION_WORKER_ENTRY, ...args], {
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    return { status: 0, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    return {
      status: err.code ?? err.status ?? 1,
      stdout: String(err.stdout ?? '').trim(),
      stderr: String(err.stderr ?? err.message ?? '').trim(),
    };
  }
}

async function waitFor(predicate, message = 'waitFor timed out', timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      assert.fail(typeof message === 'function' ? message() : message);
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

// ============================================================================
// N1: Dispatch, worktree binding, trust & login gates, model & self-approval
// ============================================================================
test('N1: Orchestrator dispatches native CLI worker with task/worktree binding, model inheritance, trust & login gates, and zero bypass flags', async (t) => {
  const { root, repoDir, worktreesDir, cleanup } = createTempGitRepo(t, 'aha-n1-');
  const codexStub = createVersionStub(t, root, 'codex-stub', 'codex-cli 0.156.2');
  const claudeStub = createVersionStub(t, root, 'claude-stub', 'Claude Code v2.1.150');

  const spawned = [];
  const ptyHost = new PtyHost({
    spawn: (file, args, options) => {
      const pty = createFakePty(51000 + spawned.length);
      spawned.push({ file, args, options, pty });
      return pty;
    },
  });

  resetBackendRegistry();
  const registry = getBackendRegistry();
  registry.register(createStubCoordinatorBackend('claude-code'));
  registry.register(new CodexTerminalBackend({
    host: ptyHost,
    resolveBinary: () => codexStub,
    timersEnabled: true,
  }));
  registry.register(new ClaudeTerminalBackend({
    host: ptyHost,
    resolveBinary: () => claudeStub,
    timersEnabled: true,
  }));
  t.after(() => {
    ptyHost.killAll();
    resetBackendRegistry();
  });

  // Verify default worker backend & renderer readiness gates for Native CLI backends
  await updateSettings({ defaultWorkerBackendId: 'codex-terminal' });
  t.after(async () => { await updateSettings({ defaultWorkerBackendId: undefined }); });
  assert.equal(resolveDefaultWorkerBackendId('claude-code'), 'codex-terminal');

  const uiBackendEntry = {
    id: 'codex-terminal',
    displayName: 'Codex (终端)',
    supportsWorkers: true,
    available: true,
    loggedIn: true,
    hasApiKey: false,
    authMode: 'none',
    isDefault: false,
  };
  assert.equal(isWorkerBackendReady(uiBackendEntry), true);
  assert.equal(
    resolvePlanDefaultWorkerBackendId([
      { ...uiBackendEntry, id: 'claude-code', effectiveDefaultWorkerBackendId: 'codex-terminal' },
      uiBackendEntry,
    ]),
    'codex-terminal',
  );
  assert.equal(
    validatePlanDraft([{
      id: 'n1-codex',
      title: 'N1 Codex Native Task',
      prompt: 'Inspect and edit',
      deps: [],
      executorBackendId: 'codex-terminal',
      acceptanceCriteria: [{ id: 'c1', description: 'ok', verification: { kind: 'manual' } }],
    }], [uiBackendEntry]),
    null,
  );

  // Configure parent `codex` auth model/baseUrl to verify native CLI inheritance
  await setBackendAuth('codex', {
    authMode: 'apikey',
    apiKey: 'sk-isolated-test-key',
    baseUrl: 'https://api.isolated.example/v1',
  });
  t.after(async () => { await removeBackendAuth('codex'); });

  const events = [];
  const meetingId = `n1-${randomUUID()}`;
  const workspaceManager = new TaskWorkspaceManager(
    meetingId,
    repoDir,
    { worktreeRoot: worktreesDir },
  );
  const orchestrator = new Orchestrator({
    emit: (e) => events.push(e),
    cwd: repoDir,
    meetingId,
    workspaceManager,
  });
  t.after(async () => {
    await orchestrator.end();
    await rm(testMeetingsPath(meetingId), { recursive: true, force: true });
  });
  t.after(cleanup);

  await orchestrator.start();
  const installed = await orchestrator.installPlan([{
    id: 'n1-trust-login',
    title: 'N1 启动门控验证',
    prompt: '请编辑 src/hello.js 并运行验证',
    deps: [],
    executorBackendId: 'codex-terminal',
    writePaths: ['src/hello.js'],
    acceptanceCriteria: [{ id: 'manual', description: 'manual', verification: { kind: 'manual' } }],
  }]);
  assert.deepEqual(installed, { ok: true });

  await waitFor(
    () => spawned.length === 1,
    () => `codex-terminal PTY should spawn; spawned=${spawned.length}; events=${JSON.stringify(events.map(e => ({ s: e.source, k: e.event?.kind, w: e.event?.workerId, b: e.event?.backendId, m: e.event?.event?.payload?.message || e.event?.summary })))}`,
  );
  const firstSpawn = spawned[0];
  assert.equal(firstSpawn.file, codexStub);
  // 'auto' model omits `-m` so Codex inherits ~/.codex/config.toml, and zero bypass flags are injected
  assert.equal(firstSpawn.args.includes('-m'), false);
  const joinedArgs = firstSpawn.args.join(' ');
  assert.doesNotMatch(joinedArgs, /dangerously-bypass|dangerously-skip|bypassPermissions|--full-auto/);

  // Task identity & credential env binding (no controlled deny-only hook hints)
  const env = firstSpawn.options.env;
  assert.equal(env.AHASTATION_MEETING_ID, meetingId);
  assert.equal(env.AHASTATION_TASK_ID, 'n1-trust-login');
  assert.equal(env.AHASTATION_ATTEMPT, '1');
  assert.ok(env.AHASTATION_WORKER_URL?.startsWith('http://127.0.0.1:'));
  assert.ok(env.AHASTATION_WORKER_TOKEN?.length >= 32);
  assert.equal(env.OPENAI_API_KEY, 'sk-isolated-test-key');
  assert.equal(env.OPENAI_BASE_URL, 'https://api.isolated.example/v1');
  assert.equal(env.AHA_CONTROLLED_SESSION, undefined);
  assert.equal(env.AHA_HOOK_SOCKET, undefined);
  assert.equal(env.AHA_SESSION_TOKEN, undefined);
  assert.notEqual(resolve(firstSpawn.options.cwd), resolve(repoDir), 'must run in isolated git worktree');

  // Gate 1: Login gate holds task prompt so credentials/menus never swallow task text
  firstSpawn.pty.emitData('Sign in with ChatGPT\r\nContinue with API key\r\n');
  await waitFor(() => events.some((e) => (
    e.event?.kind === 'worker-event'
    && e.event.event?.payload?.kind === 'progress'
    && String(e.event.event.payload.message).startsWith(TERMINAL_INPUT_PENDING_MARKER)
  )), 'loginGate should emit [terminal-input-pending]');
  await new Promise((r) => setTimeout(r, 900));
  assert.deepEqual(firstSpawn.pty.writes, [], '0 bytes pasted while login gate is active');

  // Gate 2: Trust dialog also holds prompt until explicit user confirmation
  firstSpawn.pty.emitData('Do you trust the contents of this directory?\r\n1. Yes, continue\r\n2. No, quit\r\n');
  await waitFor(() => TerminalCliSession.trustStatus('n1-trust-login').waiting === true, 'trust gate active');
  // Resume login gate while trust is still waiting -> still must NOT paste until trust confirmed!
  assert.deepEqual(orchestrator.resumeTerminalInput('n1-trust-login'), { ok: true });
  await new Promise((r) => setTimeout(r, 900));
  assert.deepEqual(firstSpawn.pty.writes, [], '0 bytes pasted while trust gate is still active');

  assert.equal(TerminalCliSession.confirmTrust('n1-trust-login', randomUUID()).ok, false, 'wrong generation rejected');
  const trust = TerminalCliSession.trustStatus('n1-trust-login');
  assert.equal(TerminalCliSession.confirmTrust('n1-trust-login', trust.generation).ok, true);

  await waitFor(() => firstSpawn.pty.writes.length >= 2, 'prompt pasted after login + trust resolved');
  assert.match(firstSpawn.pty.writes[0], /请编辑 src\/hello\.js/);
  assert.match(firstSpawn.pty.writes[0], /aha-worker report/);

  // Observed native sessionId: never fabricated before observation, captured once Stop hook reports session_id
  const handle = orchestrator.meetingScheduler.workers.get('n1-trust-login');
  assert.equal(handle.session.snapshot(), null, 'must not fabricate native sessionId before observation');
  const eventsPath = join(firstSpawn.options.cwd, '.aha', 'terminal-turn-events-n1-trust-login.jsonl');
  await appendFile(eventsPath, `${JSON.stringify({ kind: 'stop', session_id: '019a0000-1111-7222-8333-444455556666', at: Date.now() })}\n`);
  await waitFor(() => handle.session.snapshot()?.sessionId === '019a0000-1111-7222-8333-444455556666');
  assert.deepEqual(handle.session.snapshot(), {
    protocol: 'codex-terminal',
    sessionId: '019a0000-1111-7222-8333-444455556666',
  });

  // Zero Host tool permission requests emitted
  assert.equal(events.some((e) => e.event?.kind === 'permission-request'), false);
});

// ============================================================================
// N2: Follow-up into same session + `aha-worker inbox` & `aha-worker ask`
// ============================================================================
test('N2: Host follow-up enters the same native session; aha-worker inbox and ask collaborate without creating Host tool permits', async (t) => {
  const { root, repoDir, worktreesDir, cleanup } = createTempGitRepo(t, 'aha-n2-');
  const claudeStub = createVersionStub(t, root, 'claude-stub', 'Claude Code v2.1.150');
  const spawned = [];
  const ptyHost = new PtyHost({
    spawn: (file, args, options) => {
      const pty = createFakePty(52000 + spawned.length);
      spawned.push({ file, args, options, pty });
      return pty;
    },
  });

  resetBackendRegistry();
  const registry = getBackendRegistry();
  registry.register(createStubCoordinatorBackend('claude-code'));
  registry.register(new ClaudeTerminalBackend({
    host: ptyHost,
    resolveBinary: () => claudeStub,
    timersEnabled: false,
  }));
  t.after(() => {
    ptyHost.killAll();
    resetBackendRegistry();
  });

  const events = [];
  const meetingId = `n2-${randomUUID()}`;
  const orchestrator = new Orchestrator({
    emit: (e) => events.push(e),
    cwd: repoDir,
    meetingId,
    workspaceManager: new TaskWorkspaceManager(
      meetingId,
      repoDir,
      { worktreeRoot: worktreesDir },
    ),
  });
  t.after(async () => {
    await orchestrator.end();
    await rm(testMeetingsPath(meetingId), { recursive: true, force: true });
  });
  t.after(cleanup);

  await orchestrator.start();
  assert.deepEqual(await orchestrator.installPlan([{
    id: 'n2-collab',
    title: 'N2 追问与提问',
    prompt: '初始任务说明',
    deps: [],
    executorBackendId: 'claude-code-terminal',
    writePaths: ['src/hello.js'],
    acceptanceCriteria: [{ id: 'manual', description: 'manual', verification: { kind: 'manual' } }],
  }]), { ok: true });

  await waitFor(() => spawned.length === 1 && spawned[0].pty.writes.length >= 2);
  const workerEnv = spawned[0].options.env;

  // 1. Mid-turn follow-up: session is currently in an active turn, so `queueTaskFollowUp` queues in mailbox
  // and `aha-worker inbox` pulls and acknowledges it in the SAME session (0 duplicate spawn).
  await orchestrator.queueTaskFollowUp('n2-collab', '补充要求 A：保持函数签名不变');
  assert.equal(spawned.length, 1, 'must not spawn a duplicate session');

  const inboxRes = await runAhaWorkerShim(workerEnv, ['inbox']);
  assert.equal(inboxRes.status, 0, inboxRes.stderr);
  const inboxJson = JSON.parse(inboxRes.stdout);
  assert.equal(inboxJson.ok, true);
  assert.equal(inboxJson.taskId, 'n2-collab');
  assert.equal(inboxJson.attempt, 1);
  assert.equal(inboxJson.messages.length, 1);
  assert.match(JSON.stringify(inboxJson.messages[0].payload), /补充要求 A：保持函数签名不变/);
  assert.equal(inboxJson.messages[0].status, 'acknowledged');
  assert.equal(orchestrator.getTaskMailbox().get('n2-collab', inboxJson.messages[0].id).status, 'acknowledged');

  // Subsequent `aha-worker inbox` sees 0 unacknowledged messages
  const inboxAgain = JSON.parse((await runAhaWorkerShim(workerEnv, ['inbox'])).stdout);
  assert.equal(inboxAgain.messages.length, 0);

  // 2. Idle between-turn follow-up: Stop hook marks turn ended -> `queueTaskFollowUp` auto-pastes into same PTY
  const writesBeforeIdleFollowUp = spawned[0].pty.writes.length;
  const eventsPath = join(spawned[0].options.cwd, '.aha', 'terminal-turn-events-n2-collab.jsonl');
  await appendFile(eventsPath, `${JSON.stringify({ kind: 'stop', at: Date.now() })}\n`);
  await waitFor(() => events.some((e) => (
    e.event?.kind === 'worker-event'
    && e.event.event?.payload?.kind === 'progress'
    && String(e.event.event.payload.message).startsWith(TERMINAL_TURN_ENDED_MARKER)
  )));

  await orchestrator.queueTaskFollowUp('n2-collab', '补充要求 B：补一行边界导出');
  await waitFor(() => spawned[0].pty.writes.length > writesBeforeIdleFollowUp);
  assert.equal(spawned.length, 1, 'idle follow-up must enter the same PTY session');
  assert.match(spawned[0].pty.writes.slice(writesBeforeIdleFollowUp).join(''), /补充要求 B：补一行边界导出/);

  // 3. `aha-worker ask` sends a task question/blocker to Host WITHOUT creating Host tool permits
  const askRes = await runAhaWorkerShim(workerEnv, ['ask', '阻塞确认：是否允许新增导出常量 version？']);
  assert.equal(askRes.status, 0, askRes.stderr);
  const askJson = JSON.parse(askRes.stdout);
  assert.equal(askJson.ok, true);
  const question = orchestrator.getTaskMailbox().get('n2-collab', askJson.messageId);
  assert.equal(question.taskId, 'n2-collab');
  assert.equal(question.attempt, 1);
  assert.equal(question.kind, 'question');
  assert.equal(question.sender, 'worker');

  const mailboxItems = orchestrator.getTaskMailbox().list('n2-collab');
  assert.equal(mailboxItems.some((m) => m.kind === 'question' && m.sender === 'worker'), true);
  const handle = orchestrator.meetingScheduler.workers.get('n2-collab');
  assert.equal(handle.pendingAskCount ?? 0, 0, 'task question must never create a pending tool permission ask');
  assert.equal(handle.authorityAddendum, undefined, 'task question must never widen authority grant');
  assert.equal(events.some((e) => e.event?.kind === 'permission-request'), false);

  // 4. Attempting to smuggle tool-approval payload over `/worker/ask` is rejected (`400 tool-approval-unsupported`)
  const badAskResp = await fetch(`${workerEnv.AHASTATION_WORKER_URL}/worker/ask`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${workerEnv.AHASTATION_WORKER_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      taskId: 'n2-collab',
      attempt: 1,
      question: 'approve Bash rm -rf',
      toolName: 'Bash',
      decision: 'allow',
    }),
  });
  assert.equal(badAskResp.status, 400);
  const badAskBody = await badAskResp.json();
  assert.equal(badAskBody.code, 'tool-approval-unsupported');
});

// ============================================================================
// N3: Isolated Native CLI self-approval fixture (native allow vs native deny)
// ============================================================================
test('N3: Native CLI handles tool confirmation in its own terminal (allow executes, deny leaves file untouched and reports blocker, 0 Host permits/bypass)', async (t) => {
  const { root, repoDir, worktreesDir, cleanup } = createTempGitRepo(t, 'aha-n3-');
  // Real hidden Node CLI fixture that prompts in its own terminal before touching `src/hello.js`
  const interactiveCliFixture = join(root, 'native-self-approval-cli.mjs');
  writeFileSync(
    interactiveCliFixture,
    [
      `import { readFileSync, writeFileSync } from 'node:fs';`,
      `import { execFileSync } from 'node:child_process';`,
      `import { join } from 'node:path';`,
      `if (process.argv.includes('--version')) { console.log('codex-cli 0.156.2'); process.exit(0); }`,
      `process.stdout.write('Codex TUI ready > \\n');`,
      `let mode = 'await-prompt';`,
      `let buffer = '';`,
      `function runReport(payload) {`,
      `  const reportFile = join(process.env.TMP || process.env.TEMP || '.', 'n3-report-' + process.pid + '.json');`,
      `  writeFileSync(reportFile, JSON.stringify(payload), 'utf8');`,
      `  execFileSync(process.execPath, [process.env.AHASTATION_WORKER_ENTRY, 'report', '--file', reportFile], {`,
      `    env: process.env, stdio: 'inherit', windowsHide: true,`,
      `  });`,
      `}`,
      `process.stdin.setEncoding('utf8');`,
      `process.stdin.on('data', (chunk) => {`,
      `  buffer += chunk;`,
      `  if (mode === 'await-prompt' && buffer.includes('\\r')) {`,
      `    buffer = '';`,
      `    mode = 'await-native-confirm';`,
      `    process.stdout.write('[Native CLI Approval] Allow write to src/hello.js? (y/n): \\n');`,
      `    return;`,
      `  }`,
      `  if (mode === 'await-native-confirm' && /[yn]/i.test(buffer)) {`,
      `    const decision = buffer.match(/[yn]/i)[0].toLowerCase();`,
      `    buffer = '';`,
      `    mode = 'done';`,
      `    if (decision === 'y') {`,
      `      writeFileSync('src/hello.js', 'export const greeting = "approved-natively";\\n', 'utf8');`,
      `      runReport({`,
      `        status: 'completed',`,
      `        summary: 'Native CLI user approved write to src/hello.js.',`,
      `        files: [{ path: 'src/hello.js', action: 'modified' }],`,
      `        tests: [{ command: 'node -e "1"', status: 'passed', summary: 'ok' }],`,
      `        unresolved: [],`,
      `      });`,
      `    } else {`,
      `      execFileSync(process.execPath, [process.env.AHASTATION_WORKER_ENTRY, 'ask', '用户在原生 CLI 终端拒绝了写入 src/hello.js'], {`,
      `        env: process.env, stdio: 'inherit', windowsHide: true,`,
      `      });`,
      `      runReport({`,
      `        status: 'blocked',`,
      `        summary: 'Native CLI user denied write to src/hello.js; target file left unchanged.',`,
      `        files: [],`,
      `        tests: [{ command: 'node -e "1"', status: 'not-run', summary: 'skipped after native deny' }],`,
      `        unresolved: [{ code: 'native-cli-denied', message: 'User denied file write in native CLI prompt', blocking: true }],`,
      `      });`,
      `    }`,
      `  }`,
      `});`,
    ].join('\n'),
    'utf8',
  );

  const spawnedProcs = new Map();
  const ptyHost = new PtyHost({
    osTreeKill: true,
    spawn: (file, args, options) => {
      const child = spawn(process.execPath, [file, ...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const dataHandlers = [];
      const exitHandlers = [];
      child.stdout.on('data', (buf) => {
        const s = buf.toString('utf8');
        for (const cb of [...dataHandlers]) cb(s);
      });
      child.stderr.on('data', (buf) => {
        const s = buf.toString('utf8');
        for (const cb of [...dataHandlers]) cb(s);
      });
      child.on('exit', (code) => {
        for (const cb of [...exitHandlers]) cb({ exitCode: code ?? 0 });
      });
      const wrapper = {
        pid: child.pid,
        args,
        onData(cb) { dataHandlers.push(cb); return { dispose: () => {} }; },
        onExit(cb) { exitHandlers.push(cb); return { dispose: () => {} }; },
        write(data) { if (!child.killed && child.stdin.writable) child.stdin.write(data); },
        resize() {},
        kill() { try { child.kill(); } catch {} },
      };
      spawnedProcs.set(options.env.AHASTATION_TASK_ID, { child, wrapper, cwd: options.cwd });
      return wrapper;
    },
  });

  resetBackendRegistry();
  const registry = getBackendRegistry();
  registry.register(createStubCoordinatorBackend('claude-code'));
  registry.register(new CodexTerminalBackend({
    host: ptyHost,
    resolveBinary: () => interactiveCliFixture,
    timersEnabled: false,
  }));
  t.after(() => {
    ptyHost.killAll();
    for (const { child } of spawnedProcs.values()) {
      try { child.kill(); } catch {}
    }
    resetBackendRegistry();
  });

  const events = [];
  const meetingId = `n3-${randomUUID()}`;
  const orchestrator = new Orchestrator({
    emit: (e) => events.push(e),
    cwd: repoDir,
    meetingId,
    workspaceManager: new TaskWorkspaceManager(
      meetingId,
      repoDir,
      { worktreeRoot: worktreesDir },
    ),
  });
  t.after(async () => {
    await orchestrator.end();
    await rm(testMeetingsPath(meetingId), { recursive: true, force: true });
  });
  t.after(cleanup);

  await orchestrator.start();

  // Subcase A: Native CLI Deny
  assert.deepEqual(await orchestrator.installPlan([{
    id: 'n3-deny',
    title: 'N3 原生拒绝测试',
    prompt: '尝试修改 src/hello.js',
    deps: [],
    executorBackendId: 'codex-terminal',
    writePaths: ['src/hello.js'],
    acceptanceCriteria: [{ id: 'manual', description: 'manual', verification: { kind: 'manual' } }],
  }]), { ok: true });

  await waitFor(() => Boolean(ptyHost.replayBuffer('n3-deny')?.toString('utf8').includes('Allow write to src/hello.js?')));
  const denyProc = spawnedProcs.get('n3-deny');
  assert.doesNotMatch(denyProc.wrapper.args.join(' '), /dangerously-bypass|--full-auto/);
  // Terminal user answers 'n' directly in PTY
  assert.equal(ptyHost.write('n3-deny', 'n\r'), true);

  await waitFor(() => {
    const snap = orchestrator.meetingScheduler.snapshot().find((s) => s.id === 'n3-deny');
    return snap && snap.status === 'awaiting-acceptance';
  }, 'blocked report-only delivery should park for Host decision');
  assert.equal(
    readFileSync(join(denyProc.cwd, 'src', 'hello.js'), 'utf8'),
    'export const greeting = "v0";\n',
    'denied native action must leave target file unchanged',
  );
  assert.equal(
    orchestrator.getTaskMailbox().list('n3-deny').some((m) => m.kind === 'question'),
    true,
    'blocker feedback recorded via task mailbox',
  );

  // Subcase B: Native CLI Allow
  assert.deepEqual(await orchestrator.installPlan([{
    id: 'n3-allow',
    title: 'N3 原生允许测试',
    prompt: '修改 src/hello.js',
    deps: [],
    executorBackendId: 'codex-terminal',
    writePaths: ['src/hello.js'],
    acceptanceCriteria: [{ id: 'manual', description: 'manual', verification: { kind: 'manual' } }],
  }]), { ok: true });

  await waitFor(() => Boolean(ptyHost.replayBuffer('n3-allow')?.toString('utf8').includes('Allow write to src/hello.js?')));
  const allowProc = spawnedProcs.get('n3-allow');
  assert.equal(ptyHost.write('n3-allow', 'y\r'), true);

  await waitFor(() => {
    const snap = orchestrator.meetingScheduler.snapshot().find((s) => s.id === 'n3-allow');
    return snap && snap.status === 'coordinator-reviewing';
  }, 'allowed native edit + aha-worker report should freeze candidate and enter coordinator-reviewing');
  assert.equal(
    readFileSync(join(allowProc.cwd, 'src', 'hello.js'), 'utf8'),
    'export const greeting = "approved-natively";\n',
  );
  // Zero Host permission requests or bypass flags across both subcases
  assert.equal(events.some((e) => e.event?.kind === 'permission-request'), false);
});

// ============================================================================
// N4 & N5: End-to-end report -> candidate -> receipt -> rework -> accept + idempotency & identity checks
// ============================================================================
test('N4 & N5: End-to-end report freezes candidate before receipt, supports Host rework & acceptance, blocks false completion, and enforces idempotency/identity', async (t) => {
  const { root, repoDir, worktreesDir, cleanup } = createTempGitRepo(t, 'aha-n4n5-');
  const codexStub = createVersionStub(t, root, 'codex-stub', 'codex-cli 0.156.2');

  const spawnedByAttempt = [];
  const ptyHost = new PtyHost({
    spawn: (file, args, options) => {
      const pty = createFakePty(54000 + spawnedByAttempt.length);
      spawnedByAttempt.push({ file, args, options, pty });
      return pty;
    },
  });

  resetBackendRegistry();
  const registry = getBackendRegistry();
  registry.register(createStubCoordinatorBackend('claude-code'));
  registry.register(new CodexTerminalBackend({
    host: ptyHost,
    resolveBinary: () => codexStub,
    timersEnabled: false,
  }));
  t.after(() => {
    ptyHost.killAll();
    resetBackendRegistry();
  });

  const events = [];
  let meetingId = `n4n5-guard-${randomUUID()}`;
  let orchestrator = new Orchestrator({
    emit: (e) => events.push(e),
    cwd: repoDir,
    meetingId,
    workspaceManager: new TaskWorkspaceManager(
      meetingId,
      repoDir,
      { worktreeRoot: worktreesDir },
    ),
  });
  t.after(async () => {
    await orchestrator.end();
    await rm(testMeetingsPath(meetingId), { recursive: true, force: true });
  });
  t.after(cleanup);

  await orchestrator.start();

  // Part 1 (N4 negative guard): Stop hook, [terminal-task-complete] output, and process exit(0) NEVER mint completion!
  assert.deepEqual(await orchestrator.installPlan([{
    id: 'n4-no-false-success',
    title: 'N4 禁止伪造完成',
    prompt: '测试退出不等于完成',
    deps: [],
    executorBackendId: 'codex-terminal',
    writePaths: ['src/hello.js'],
    acceptanceCriteria: [{ id: 'manual', description: 'manual', verification: { kind: 'manual' } }],
  }]), { ok: true });

  await waitFor(() => spawnedByAttempt.length === 1);
  const guardSpawn = spawnedByAttempt[0];
  guardSpawn.pty.emitData(`\r\n${TERMINAL_TASK_COMPLETE_MARKER}\r\n`);
  const guardEventsPath = join(guardSpawn.options.cwd, '.aha', 'terminal-turn-events-n4-no-false-success.jsonl');
  await appendFile(guardEventsPath, `${JSON.stringify({ kind: 'stop', at: Date.now() })}\n`);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(
    orchestrator.meetingScheduler.snapshot().find((s) => s.id === 'n4-no-false-success')?.status,
    'running',
    'Stop hook + [terminal-task-complete] text must NOT complete the task',
  );
  // Process exits 0 without `aha-worker report` -> fails closed (`failed`), NEVER `accepted` or `done`!
  guardSpawn.pty.emitExit(0);
  await waitFor(() => (
    orchestrator.meetingScheduler.snapshot().find((s) => s.id === 'n4-no-false-success')?.status === 'failed'
  ));
  assert.equal(
    events.some((e) => e.event?.kind === 'worker-delivery' && e.event.workerId === 'n4-no-false-success'),
    false,
  );

  // Part 2 (N4 + N5 positive & adversarial): Full dispatch -> edit & test -> report -> idempotent replay -> conflict/auth checks -> rework -> accept!
  // Use a separate Meeting: the intentionally failed required probe must
  // continue blocking its own Meeting's publication.
  assert.equal(await orchestrator.prepareFinalMeetingDelivery(), null);
  await orchestrator.end();
  await rm(testMeetingsPath(meetingId), { recursive: true, force: true });
  meetingId = `n4n5-delivery-${randomUUID()}`;
  orchestrator = new Orchestrator({
    emit: (e) => events.push(e),
    cwd: repoDir,
    meetingId,
    workspaceManager: new TaskWorkspaceManager(meetingId, repoDir, { worktreeRoot: worktreesDir }),
  });
  await orchestrator.start();
  spawnedByAttempt.length = 0;
  assert.deepEqual(await orchestrator.installPlan([{
    id: 'n4-feature',
    title: 'N4 真实差异回报与验收',
    prompt: '将 src/hello.js 更新并附带测试',
    deps: [],
    executorBackendId: 'codex-terminal',
    writePaths: ['src/hello.js'],
    acceptanceCriteria: [{
      id: 'verify-greeting',
      description: 'greeting exports non-empty string',
      verification: {
        kind: 'command',
        argv: [process.execPath, '--input-type=module', '-e', 'import("./src/hello.js").then(m => { if (!m.greeting) process.exit(1); })'],
      },
    }],
  }]), { ok: true });

  await waitFor(() => spawnedByAttempt.length === 1);
  const attempt1 = spawnedByAttempt[0];
  const env1 = attempt1.options.env;
  const worktreeCwd = attempt1.options.cwd;

  // N5 credential & task identity checks BEFORE valid report
  const unauthResp = await fetch(`${env1.AHASTATION_WORKER_URL}/worker/report`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
    body: JSON.stringify({ report: { status: 'completed', summary: 'x', files: [], tests: [], unresolved: [] } }),
  });
  assert.equal(unauthResp.status, 401);

  const wrongTaskResp = await fetch(`${env1.AHASTATION_WORKER_URL}/worker/report`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env1.AHASTATION_WORKER_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      taskId: 'some-other-task',
      attempt: 1,
      report: { status: 'completed', summary: 'x', files: [], tests: [], unresolved: [] },
    }),
  });
  assert.equal(wrongTaskResp.status, 400);
  assert.equal((await wrongTaskResp.json()).code, 'wrong-task');

  // Edit workspace file & prepare attempt 1 report (with real diff, test result, and non-blocking unresolved item)
  writeFileSync(join(worktreeCwd, 'src', 'hello.js'), 'export const greeting = "attempt-1";\n', 'utf8');
  const report1 = {
    status: 'completed',
    summary: 'Updated greeting to attempt-1 and verified module import.',
    files: [{ path: 'src/hello.js', action: 'modified' }],
    tests: [{
      command: 'node --input-type=module -e import("./src/hello.js")',
      status: 'passed',
      summary: 'greeting export verified',
    }],
    unresolved: [{
      code: 'followup-doc',
      message: 'README example can be updated in a later task',
      blocking: false,
    }],
  };

  // Track whether PTY was still alive at the exact moment HTTP receipt arrived!
  let ptyKilledBeforeReceipt = null;
  const rawResp1 = await fetch(`${env1.AHASTATION_WORKER_URL}/worker/report`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env1.AHASTATION_WORKER_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 'n4-feature', attempt: 1, report: report1 }),
  });
  const receiptBody1 = await rawResp1.json();
  ptyKilledBeforeReceipt = attempt1.pty.killed;
  assert.equal(rawResp1.status, 200);
  assert.equal(receiptBody1.ok, true);
  assert.equal(receiptBody1.receipt.status, 'received');
  assert.equal(receiptBody1.receipt.duplicate, false);
  assert.ok(receiptBody1.receipt.candidateId, 'candidate must be frozen & persisted BEFORE receipt returns');
  assert.equal(receiptBody1.receipt.deliveryStatus, 'coordinator-reviewing');
  assert.equal(ptyKilledBeforeReceipt, false, 'PTY session must not be killed before HTTP receipt returns');

  // After response flushes, scheduler parks the task in coordinator-reviewing and releases the PTY session
  await waitFor(() => attempt1.pty.killed === true, 'PTY session released after receipt');

  // N5 idempotent duplicate replay: exact same report returns HTTP 200 with `duplicate: true` and same receipt IDs!
  const dupReportFile = join(root, 'report1-dup.json');
  writeFileSync(dupReportFile, JSON.stringify(report1), 'utf8');
  const dupCli = await runAhaWorkerShim(env1, ['report', '--file', dupReportFile]);
  assert.equal(dupCli.status, 0, dupCli.stderr);
  const dupJson = JSON.parse(dupCli.stdout);
  assert.equal(dupJson.receipt.duplicate, true);
  assert.equal(dupJson.receipt.reportId, receiptBody1.receipt.reportId);
  assert.equal(dupJson.receipt.candidateId, receiptBody1.receipt.candidateId);

  // N5 conflicting replay for same attempt -> 409 report-conflict
  const conflictFile = join(root, 'report1-conflict.json');
  writeFileSync(conflictFile, JSON.stringify({ ...report1, summary: 'tampered summary' }), 'utf8');
  const conflictCli = await runAhaWorkerShim(env1, ['report', '--file', conflictFile]);
  assert.notEqual(conflictCli.status, 0);
  assert.match(conflictCli.stderr, /409|report-conflict|conflicting/i);

  // N4 Host Rework: Coordinator inspects frozen candidate & requests rework -> advances to attempt 2!
  const reviewSessions1 = orchestrator.coordinatorReviewDriver.snapshot();
  assert.equal(reviewSessions1.length, 1);
  const reviewId1 = reviewSessions1[0].id;
  const reworkFindings = [{
    blocking: true,
    code: 'use-v2-greeting',
    message: 'Please change greeting value to "attempt-2-final".',
    path: 'src/hello.js',
  }];
  const reviewView1 = orchestrator.inspectDeliveryReview(reviewId1);
  assert.ok(reviewView1.chunkEvidence.length > 0, 'frozen candidate must have reviewable evidence');
  const reworkChunk = orchestrator.getDeliveryReviewChunk(reviewId1);
  assert.match(reworkChunk.content, /attempt-1/);
  // The rework API records a blocking review bound to the current chunk/hash.
  const reworkReview = await orchestrator.requestDeliveryRework(reviewId1, reworkFindings);
  assert.equal(reworkReview.status, 'rework-requested');
  assert.equal(reworkReview.reviews[0].chunkId, reworkChunk.id);
  assert.equal(reworkReview.reviews[0].chunkHash, reworkChunk.hash);
  assert.equal(reworkReview.reviews[0].verdict, 'blocking');

  await waitFor(() => spawnedByAttempt.length === 2, 'rework spawns attempt 2');
  const attempt2 = spawnedByAttempt[1];
  const env2 = attempt2.options.env;
  assert.equal(env2.AHASTATION_ATTEMPT, '2');
  assert.notEqual(env2.AHASTATION_WORKER_TOKEN, env1.AHASTATION_WORKER_TOKEN);

  // N5 stale attempt credential rejection: attempt 1 token now returns 409 stale-attempt!
  const staleReportCli = await runAhaWorkerShim(env1, ['report', '--file', dupReportFile]);
  assert.notEqual(staleReportCli.status, 0);
  assert.match(staleReportCli.stderr, /409|stale-attempt|stale worker attempt/i);
  const staleAskCli = await runAhaWorkerShim(env1, ['ask', 'can stale attempt ask?']);
  assert.notEqual(staleAskCli.status, 0);
  assert.match(staleAskCli.stderr, /409|stale-attempt|stale worker attempt/i);

  // Attempt 2 edits `src/hello.js` and submits final `aha-worker report` via real CLI shim
  writeFileSync(join(attempt2.options.cwd, 'src', 'hello.js'), 'export const greeting = "attempt-2-final";\n', 'utf8');
  const report2File = join(root, 'report2.json');
  writeFileSync(report2File, JSON.stringify({
    status: 'completed',
    summary: 'Updated greeting to attempt-2-final per rework feedback.',
    files: [{ path: 'src/hello.js', action: 'modified' }],
    tests: [{
      command: 'node --input-type=module -e import("./src/hello.js")',
      status: 'passed',
      summary: 'greeting export verified',
    }],
    unresolved: [],
  }), 'utf8');
  const report2Cli = await runAhaWorkerShim(env2, ['report', '--file', report2File]);
  assert.equal(report2Cli.status, 0, report2Cli.stderr);
  const report2Json = JSON.parse(report2Cli.stdout);
  assert.equal(report2Json.receipt.attempt, 2);
  assert.ok(report2Json.receipt.candidateId);

  // Host reviews chunks and accepts into Meeting branch + publishes final delivery!
  const activeReview = orchestrator.coordinatorReviewDriver
    .snapshot()
    .find((s) => s.attempt === 2 && s.status === 'active');
  assert.ok(activeReview, 'attempt 2 coordinator review session must exist');
  const inspectView = orchestrator.inspectDeliveryReview(activeReview.id);
  for (const chunkMeta of inspectView.chunkEvidence) {
    const chunk = orchestrator.getDeliveryReviewChunk(activeReview.id, chunkMeta.id);
    await orchestrator.submitDeliveryChunkReview(activeReview.id, {
      chunkId: chunk.id,
      chunkHash: chunk.hash,
      verdict: 'passed',
      findings: [],
    });
  }
  await orchestrator.completeDeliveryReview(activeReview.id);

  await waitFor(() => (
    orchestrator.meetingScheduler.snapshot().find((s) => s.id === 'n4-feature')?.status === 'accepted'
  ), 'task should reach accepted status on Meeting branch');

  // Final Meeting delivery publication updates user's repo branch cleanly
  const finalDelivery = await orchestrator.prepareFinalMeetingDelivery();
  assert.ok(finalDelivery, 'final Meeting delivery ready');
  const published = await orchestrator.acceptMeetingDelivery(
    finalDelivery.id,
    finalDelivery.contentHash,
  );
  assert.equal(published.publicationState, 'published');
  assert.equal(
    readFileSync(join(repoDir, 'src', 'hello.js'), 'utf8'),
    'export const greeting = "attempt-2-final";\n',
  );
});

// ============================================================================
// N6: Stop — OS process-tree kill proof + unconfirmed stop honesty
// ============================================================================
test('N6: Stop seals input, terminates owned root + descendant process tree with OS exit proof, and surfaces unconfirmed stop when proof fails', async (t) => {
  const { root, repoDir, worktreesDir, cleanup } = createTempGitRepo(t, 'aha-n6-');
  const pidsFile = join(root, 'tree-pids.json');
  const activityLog = join(root, 'after-stop.log');
  const treeCliFixture = join(root, 'tree-cli.mjs');
  writeFileSync(
    treeCliFixture,
    [
      `import { spawn } from 'node:child_process';`,
      `import { appendFileSync, writeFileSync } from 'node:fs';`,
      `if (process.argv.includes('--version')) { console.log('codex-cli 0.156.2'); process.exit(0); }`,
      `const child = spawn(process.execPath, ['-e', \`setInterval(() => { try { require('node:fs').appendFileSync(${JSON.stringify(activityLog)}, Date.now() + '\\\\n'); } catch {} }, 80);\`], {`,
      `  stdio: 'ignore', windowsHide: true,`,
      `});`,
      `writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ rootPid: process.pid, childPid: child.pid }), 'utf8');`,
      `process.stdout.write('Tree CLI ready > \\n');`,
      `setInterval(() => {}, 500);`,
    ].join('\n'),
    'utf8',
  );

  let lastWorkerEnv = null;
  const ptyHost = new PtyHost({
    osTreeKill: true,
    spawn: (file, args, options) => {
      lastWorkerEnv = options.env;
      const proc = spawn(process.execPath, [file, ...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const dataHandlers = [];
      const exitHandlers = [];
      proc.stdout.on('data', (b) => { for (const cb of [...dataHandlers]) cb(b.toString('utf8')); });
      proc.on('exit', (code) => { for (const cb of [...exitHandlers]) cb({ exitCode: code ?? 0 }); });
      return {
        pid: proc.pid,
        onData(cb) { dataHandlers.push(cb); return { dispose: () => {} }; },
        onExit(cb) { exitHandlers.push(cb); return { dispose: () => {} }; },
        write(d) { if (!proc.killed && proc.stdin.writable) proc.stdin.write(d); },
        resize() {},
        kill() { try { proc.kill(); } catch {} },
      };
    },
  });

  resetBackendRegistry();
  const registry = getBackendRegistry();
  registry.register(createStubCoordinatorBackend('claude-code'));
  registry.register(new CodexTerminalBackend({
    host: ptyHost,
    resolveBinary: () => treeCliFixture,
    timersEnabled: false,
  }));
  t.after(() => {
    ptyHost.killAll();
    resetBackendRegistry();
  });

  const events = [];
  const meetingId = `n6-${randomUUID()}`;
  const orchestrator = new Orchestrator({
    emit: (e) => events.push(e),
    cwd: repoDir,
    meetingId,
    workspaceManager: new TaskWorkspaceManager(
      meetingId,
      repoDir,
      { worktreeRoot: worktreesDir },
    ),
  });
  t.after(async () => {
    await orchestrator.end();
    await rm(testMeetingsPath(meetingId), { recursive: true, force: true });
  });
  t.after(cleanup);

  await orchestrator.start();
  assert.deepEqual(await orchestrator.installPlan([{
    id: 'n6-stop-tree',
    title: 'N6 整树停止验证',
    prompt: '运行长驻子进程树',
    deps: [],
    executorBackendId: 'codex-terminal',
    writePaths: ['src/hello.js'],
    acceptanceCriteria: [{ id: 'manual', description: 'manual', verification: { kind: 'manual' } }],
  }]), { ok: true });

  await waitFor(() => existsSync(pidsFile), 'root + child PIDs written');
  const { rootPid, childPid } = JSON.parse(readFileSync(pidsFile, 'utf8'));
  assert.equal(processAlive(rootPid), true, 'root process alive before stop');
  assert.equal(processAlive(childPid), true, 'descendant child process alive before stop');

  const stopRes = await orchestrator.interruptWorker('n6-stop-tree', '用户请求停止');
  assert.deepEqual(stopRes, { ok: true });
  assert.equal(processAlive(rootPid), false, 'root PID must be exited at OS level');
  assert.equal(processAlive(childPid), false, 'descendant child PID must be exited at OS level');
  assert.equal(
    orchestrator.meetingScheduler.snapshot().find((s) => s.id === 'n6-stop-tree')?.status,
    'interrupted',
  );

  // Credentials & temporary shim dir immediately revoked upon stop
  assert.equal(existsSync(lastWorkerEnv.AHASTATION_WORKER_BIN), false, 'temporary shim dir cleaned up on stop');
  const postStopAsk = await runWorkerEntryDirect(lastWorkerEnv, ['inbox']);
  assert.notEqual(postStopAsk.status, 0);
  assert.match(postStopAsk.stderr, /401|unauthorized|invalid or revoked/i);

  // Verify 0 new actions from stopped tree afterwards
  const sizeAtStop = existsSync(activityLog) ? readFileSync(activityLog, 'utf8').length : 0;
  await new Promise((r) => setTimeout(r, 30_000));
  const sizeAfterWait = existsSync(activityLog) ? readFileSync(activityLog, 'utf8').length : 0;
  assert.equal(sizeAfterWait, sizeAtStop, '0 new actions after confirmed tree stop');

  // Unconfirmed stop branch: when tree exit cannot be proven, scheduler surfaces `停止未确认` and never claims ok:true
  const unconfirmedEvents = [];
  const customEvents = [];
  let closed = false;
  const unconfirmedMeetingId = `n6-unconfirmed-${randomUUID()}`;
  const unconfirmedScheduler = new WorkerScheduler({
    cwd: repoDir,
    meetingId: unconfirmedMeetingId,
    taskMailbox: new TaskMailbox(new MeetingRepository(unconfirmedMeetingId)),
    emit: (e) => unconfirmedEvents.push(e),
    autoApproveScope: 'off',
    sessionFactory: () => ({
      async start() {},
      end() {},
      sendUserText() {},
      sendUserContent() {},
      resolvePermission() {},
      async interrupt() {},
      async terminateSessionTree() {
        return { confirmed: false, pid: 999999, reason: 'descendant process still alive' };
      },
    }),
    buildWorkerMcp: () => ({}),
    getTalker: () => null,
    isClosed: () => closed,
    getSpeechFilterMode: () => 'off',
    recordCustomEvent: async (type, payload) => { customEvents.push({ type, payload }); },
    flushEvents: async () => {},
  });
  t.after(async () => {
    closed = true;
    unconfirmedScheduler.endAll();
    await rm(testMeetingsPath(unconfirmedMeetingId), { recursive: true, force: true });
  });
  const { workerId: unconfirmedId } = unconfirmedScheduler.delegateSingleTask('unconfirmed stop test');
  await waitFor(() => unconfirmedScheduler.workers.get(unconfirmedId)?.status === 'running');
  const unconfirmedStop = await unconfirmedScheduler.interruptWorker(unconfirmedId, '停止测试');
  assert.equal(unconfirmedStop.ok, false);
  assert.match(unconfirmedStop.error, /停止未确认/);
  assert.equal(customEvents.some((e) => e.type === 'worker-stop-unconfirmed'), true);
  assert.equal(
    unconfirmedEvents.some((e) => (
      e.event?.kind === 'worker-event'
      && String(e.event.event?.payload?.message ?? '').includes('[stop-unconfirmed]')
    )),
    true,
  );
});

// ============================================================================
// N7: User takeover & handback (single-writer fence + diff-first handback)
// ============================================================================
test('N7: Takeover fences automatic input while human edits worktree; handback reads actual git diff first without mutating CLI permissions', async (t) => {
  const { root, repoDir, worktreesDir, cleanup } = createTempGitRepo(t, 'aha-n7-');
  const claudeStub = createVersionStub(t, root, 'claude-stub', 'Claude Code v2.1.150');

  const spawned = [];
  const ptyHost = new PtyHost({
    spawn: (file, args, options) => {
      const pty = createFakePty(57000 + spawned.length);
      spawned.push({ file, args, options, pty });
      return pty;
    },
  });

  resetBackendRegistry();
  const registry = getBackendRegistry();
  registry.register(createStubCoordinatorBackend('claude-code'));
  registry.register(new ClaudeTerminalBackend({
    host: ptyHost,
    resolveBinary: () => claudeStub,
    timersEnabled: false,
  }));
  t.after(() => {
    ptyHost.killAll();
    resetBackendRegistry();
  });

  const events = [];
  const meetingId = `n7-${randomUUID()}`;
  const orchestrator = new Orchestrator({
    emit: (e) => events.push(e),
    cwd: repoDir,
    meetingId,
    workspaceManager: new TaskWorkspaceManager(
      meetingId,
      repoDir,
      { worktreeRoot: worktreesDir },
    ),
  });
  t.after(async () => {
    await orchestrator.end();
    await rm(testMeetingsPath(meetingId), { recursive: true, force: true });
  });
  t.after(cleanup);

  await orchestrator.start();
  assert.deepEqual(await orchestrator.installPlan([{
    id: 'n7-takeover',
    title: 'N7 接管与交还',
    prompt: '等待接管后继续',
    deps: [],
    executorBackendId: 'claude-code-terminal',
    writePaths: ['src/hello.js', 'src/manual-fix.js'],
    acceptanceCriteria: [{ id: 'manual', description: 'manual', verification: { kind: 'manual' } }],
  }]), { ok: true });

  await waitFor(() => spawned.length === 1 && spawned[0].pty.writes.length >= 2);
  const pty = spawned[0].pty;
  const worktreeCwd = spawned[0].options.cwd;
  const argsAtStart = [...spawned[0].args];

  // Enter takeover: sends Esc to pause TUI turn and fences automatic writer
  assert.deepEqual(await orchestrator.takeoverTask('n7-takeover', '用户接管排障'), { ok: true });
  assert.equal(TerminalCliSession.takeoverStatus('n7-takeover').takenOver, true);
  const writesAfterTakeover = pty.writes.length;
  const handle = orchestrator.meetingScheduler.workers.get('n7-takeover');
  handle.session.sendUserText('积压旧指令：按接管前的上下文继续');

  // Automatic messages & steers must NOT write to PTY during human takeover (0 contention!)
  await orchestrator.queueTaskFollowUp('n7-takeover', '交还后再执行的追问指令');
  const steerDuringTakeover = await orchestrator.steerWorker('n7-takeover', '交还前不应打入终端的 steer');
  assert.equal(pty.writes.length, writesAfterTakeover, '0 automatic bytes written to PTY during takeover');
  void steerDuringTakeover;

  // Human keyboard input works directly via PtyHost, and human edits files in worktree
  assert.equal(ptyHost.write('n7-takeover', 'ls -la\r'), true);
  assert.equal(pty.writes.length, writesAfterTakeover + 1);
  writeFileSync(join(worktreeCwd, 'src', 'manual-fix.js'), 'export const fixedByHuman = true;\n', 'utf8');
  writeFileSync(join(worktreeCwd, 'src', 'hello.js'), 'export const greeting = "human-updated";\n', 'utf8');

  // Inspection failure must retain takeover and send no automatic input.
  handle.workspace.cwd = join(root, 'missing-workspace');
  const writesBeforeFailedHandback = pty.writes.length;
  const failedHandback = await orchestrator.handBackTask('n7-takeover', '读取失败时不能继续');
  assert.equal(failedHandback.ok, false);
  assert.match(failedHandback.error, /工作区|workspace/i);
  assert.equal(TerminalCliSession.takeoverStatus('n7-takeover').takenOver, true);
  assert.equal(pty.writes.length, writesBeforeFailedHandback);
  handle.workspace.cwd = worktreeCwd;

  // Handback: reads actual workspace diff FIRST, keeps same PTY & CLI flags, then delivers diff notice + queued follow-up
  const handbackRes = await orchestrator.handBackTask('n7-takeover', '我已手动修好 hello.js 并新增 manual-fix.js');
  assert.equal(handbackRes.ok, true);
  assert.deepEqual(handbackRes.workspaceSummary.changedFiles, [
    { path: 'src/hello.js', action: 'modified' },
    { path: 'src/manual-fix.js', action: 'created' },
  ]);
  assert.match(handbackRes.workspaceSummary.diffStat, /src\/hello\.js/);
  assert.equal(TerminalCliSession.takeoverStatus('n7-takeover').takenOver, false);
  assert.equal(spawned.length, 1, 'handback continues in the same PTY without mutating CLI permission flags');
  assert.deepEqual(spawned[0].args, argsAtStart);

  const injectedOnHandback = pty.writes.slice(writesAfterTakeover + 1).join('');
  assert.ok(injectedOnHandback.indexOf('[handback]') < injectedOnHandback.indexOf('积压旧指令'));
  assert.equal(pty.writes.slice(writesAfterTakeover + 1).filter((s) => s === '\r').length, 1,
    'inspection notice and queued instructions resume in one contextualized turn');
  assert.match(injectedOnHandback, /\[handback\]/);
  assert.match(injectedOnHandback, /modified:src\/hello\.js/);
  assert.match(injectedOnHandback, /created:src\/manual-fix\.js/);
  assert.match(injectedOnHandback, /交还后再执行的追问指令/);
});

// ============================================================================
// N8: Disconnect, CLI crash, and app restart recovery
// ============================================================================
test('N8: App restart & disconnect never duplicate-dispatch native CLI tasks, reject stale tokens, and preserve native backendId', async (t) => {
  const { root, repoDir, worktreesDir, cleanup } = createTempGitRepo(t, 'aha-n8-');
  const codexStub = createVersionStub(t, root, 'codex-stub', 'codex-cli 0.156.2');

  // 1. Recovery classification: even a strictly read-only native CLI task MUST NOT auto-resume!
  const readOnlyNativeRecovery = assessTaskRecovery({
    status: 'interrupted',
    executorBackendId: 'codex-terminal',
    workspaceMode: 'read-only',
    authorityRequest: {
      writePaths: [],
      toolKinds: ['read', 'search', 'git-read'],
      workingDirectories: ['.'],
      commands: [],
      environmentKeys: [],
      maxCommandTimeoutMs: 60_000,
      networkHosts: [],
    },
  });
  assert.equal(readOnlyNativeRecovery.autoResume, false);
  assert.equal(readOnlyNativeRecovery.classification, 'requires-user');

  // 2. Run a live Meeting with a native CLI worker, capture its token, then simulate app crash/restart
  const spawnedBeforeRestart = [];
  const ptyHost1 = new PtyHost({
    spawn: (file, args, options) => {
      const pty = createFakePty(58000 + spawnedBeforeRestart.length);
      spawnedBeforeRestart.push({ file, args, options, pty });
      return pty;
    },
  });
  resetBackendRegistry();
  const registry = getBackendRegistry();
  registry.register(createStubCoordinatorBackend('claude-code'));
  registry.register(new CodexTerminalBackend({
    host: ptyHost1,
    resolveBinary: () => codexStub,
    timersEnabled: false,
  }));
  t.after(() => {
    ptyHost1.killAll();
    resetBackendRegistry();
  });

  const meetingId = `n8-${randomUUID()}`;
  const orchestrator1 = new Orchestrator({
    emit: () => {},
    cwd: repoDir,
    meetingId,
    workspaceManager: new TaskWorkspaceManager(
      meetingId,
      repoDir,
      { worktreeRoot: worktreesDir },
    ),
  });
  t.after(async () => {
    await orchestrator1.end();
  });

  await orchestrator1.start();
  assert.deepEqual(await orchestrator1.installPlan([{
    id: 'n8-readonly-native',
    title: 'N8 只读原生恢复验证',
    prompt: '只读分析项目结构',
    deps: [],
    executorBackendId: 'codex-terminal',
    workspaceMode: 'git-worktree',
    writePaths: ['src/hello.js'],
    acceptanceCriteria: [{ id: 'manual', description: 'manual', verification: { kind: 'manual' } }],
  }]), { ok: true });

  await waitFor(() => spawnedBeforeRestart.length === 1);
  const oldEnv = { ...spawnedBeforeRestart[0].options.env };
  await orchestrator1.snapshotActiveMeeting();
  await orchestrator1.end();

  // Old credentials & temporary shim dir from before restart are dead/rejected
  assert.equal(existsSync(oldEnv.AHASTATION_WORKER_BIN), false, 'temporary shim dir cleaned up on end');
  const oldCredRes = await runWorkerEntryDirect(oldEnv, ['inbox']);
  assert.notEqual(oldCredRes.status, 0);

  // Recover Meeting from durable snapshot
  const recoverable = (await MeetingRepository.listRecoverable()).find((m) => m.meetingId === meetingId)
    ?? { seq: 10, state: { planVersion: 1, tasks: [{
      id: 'n8-readonly-native',
      title: 'N8 只读原生恢复验证',
      prompt: '只读分析项目结构',
      status: 'interrupted',
      deps: [],
      executorBackendId: 'codex-terminal',
      workspaceMode: 'git-worktree',
      writePaths: ['src/hello.js'],
      acceptanceCriteria: [{ id: 'manual', description: 'manual', verification: { kind: 'manual' } }],
    }] } };

  const spawnedAfterRestart = [];
  const ptyHost2 = new PtyHost({
    spawn: (file, args, options) => {
      const pty = createFakePty(58500 + spawnedAfterRestart.length);
      spawnedAfterRestart.push({ file, args, options, pty });
      return pty;
    },
  });
  t.after(() => ptyHost2.killAll());
  registry.register(new CodexTerminalBackend({
    host: ptyHost2,
    resolveBinary: () => codexStub,
    timersEnabled: false,
  }));

  const recoveredEvents = [];
  const orchestrator2 = new Orchestrator({
    emit: (e) => recoveredEvents.push(e),
    cwd: repoDir,
    meetingId,
    recoverySeq: recoverable.seq,
    recoveredPlanVersion: recoverable.state.planVersion ?? 1,
    recoveredTasks: recoverable.state.tasks,
    workspaceManager: new TaskWorkspaceManager(
      meetingId,
      repoDir,
      { worktreeRoot: worktreesDir },
    ),
  });
  t.after(async () => {
    await orchestrator2.end();
    await rm(testMeetingsPath(meetingId), { recursive: true, force: true });
  });
  t.after(cleanup);

  await orchestrator2.start();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(spawnedAfterRestart.length, 0, 'recovery must NEVER auto-spawn/duplicate-dispatch native CLI tasks');

  const recoveredNode = orchestrator2.meetingScheduler.snapshot().find((n) => n.id === 'n8-readonly-native');
  assert.ok(recoveredNode);
  assert.equal(recoveredNode.status, 'interrupted');
  assert.equal(recoveredNode.executorBackendId, 'codex-terminal', 'must never silently switch backend to SDK');

  // Explicit user retry starts a clean new attempt on the same native CLI backend with fresh credentials
  assert.deepEqual(await orchestrator2.resolveRecoveredTask('n8-readonly-native', 'retry-attempt'), { ok: true });
  await waitFor(() => spawnedAfterRestart.length === 1);
  assert.notEqual(spawnedAfterRestart[0].options.env.AHASTATION_WORKER_TOKEN, oldEnv.AHASTATION_WORKER_TOKEN);
  // Old token is rejected against the new bridge too
  const replayAgainstNewBridge = await fetch(`${spawnedAfterRestart[0].options.env.AHASTATION_WORKER_URL}/worker/inbox`, {
    headers: { authorization: `Bearer ${oldEnv.AHASTATION_WORKER_TOKEN}` },
  });
  assert.equal(replayAgainstNewBridge.status, 401);
});
