import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeTerminalBackend } from '../dist-electron/backends/claude-terminal-adapter.js';
import { CodexTerminalBackend } from '../dist-electron/backends/codex-terminal-adapter.js';

test('controlled native tasks fail before binary resolution, file writes, PTY spawn or queued prompt injection', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aha85-admission-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const Backend of [ClaudeTerminalBackend, CodexTerminalBackend]) {
    for (const config of [{ executionRole: 'worker' }, { taskProfile: {} }]) {
      let sideEffects = 0;
      const backend = new Backend({ host: { spawn() { sideEffects++; throw new Error('must not spawn'); }, kill() {} },
        resolveBinary() { sideEffects++; throw new Error('must not resolve'); }, timersEnabled: false });
      const session = backend.createSession({ cwd: root, ...config }, () => {});
      session.sendUserText('must never be injected');
      await assert.rejects(session.start(), /unsupported-contract/);
      assert.equal(sideEffects, 0);
      assert.equal(existsSync(join(root, '.aha')), false);
      session.end();
    }
    for (const badEnv of [
      { AHA_CONTROLLED_SESSION: '1' },
      { AHA_HOOK_SOCKET: '\\\\.\\pipe\\aha-old' },
      { AHA_SESSION_TOKEN: 'secret' },
    ]) {
      let sideEffects = 0;
      const backend = new Backend({
        host: { spawn() { sideEffects++; throw new Error('must not spawn'); }, kill() {} },
        resolveBinary() { sideEffects++; throw new Error('must not resolve'); },
        timersEnabled: false,
      });
      const session = backend.createSession({
        cwd: root,
        executionRole: 'worker',
        env: badEnv,
        nativeCliWorker: {
          mode: 'native-cli-self-approval',
          meetingId: 'm1',
          taskId: 't1',
          workerId: 't1',
          attempt: 1,
          workspaceCwd: root,
          terminalId: 't1',
        },
      }, () => {});
      await assert.rejects(session.start(), /unsupported-contract/);
      assert.equal(sideEffects, 0);
      session.end();
    }
  }
});

test('bound native-cli-self-approval workers pass admission without bypass flags or Host permit authority', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aha85-admitted-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { backendRuntimeSchema } = await import('../dist-electron/backends/task-profile.js');
  for (const [Backend, backendId] of [
    [ClaudeTerminalBackend, 'claude-code-terminal'],
    [CodexTerminalBackend, 'codex-terminal'],
  ]) {
    let spawned = null;
    const backend = new Backend({
      host: {
        spawn(id, opts) { spawned = { id, ...opts }; return 12345; },
        onData() { return () => {}; },
        onExit() { return () => {}; },
        write() { return true; },
        kill() {},
      },
      resolveBinary: () => '/fake/cli',
      timersEnabled: false,
    });
    const runtime = backendRuntimeSchema.parse({
      schemaVersion: 1,
      backendId,
      runtimeVersion: '1.0.0',
    });
    const effectiveProfile = backend.compileTaskProfile({
      schemaVersion: 1,
      backendId,
      workMode: 'balanced',
      contextMode: 'meeting-summary',
      timeoutMs: 60_000,
      maxTokenBudget: 50_000,
    }, runtime);
    const baseConfig = {
      cwd: root,
      extra: { workerId: `w-${backendId}` },
      executionRole: 'worker',
      taskProfile: effectiveProfile,
      nativeCliWorker: {
        mode: 'native-cli-self-approval',
        meetingId: 'm-1',
        taskId: `w-${backendId}`,
        workerId: `w-${backendId}`,
        attempt: 1,
        workspaceCwd: root,
        terminalId: `w-${backendId}`,
      },
    };
    const withoutCreds = backend.createSession(baseConfig, () => {});
    await assert.rejects(withoutCreds.start(), /unsupported-contract:.*AHASTATION_WORKER_/);
    withoutCreds.end();

    const withBypass = backend.createSession({
      ...baseConfig,
      autoApproveScope: 'full',
      env: {
        AHASTATION_WORKER_URL: 'http://127.0.0.1:43210',
        AHASTATION_WORKER_TOKEN: 'tok-test',
        AHASTATION_WORKER_ENTRY: '/fake/worker-cli.js',
      },
    }, () => {});
    await assert.rejects(withBypass.start(), /unsupported-contract:.*autoApproveScope/);
    withBypass.end();

    const session = backend.createSession({
      ...baseConfig,
      env: {
        AHASTATION_WORKER_URL: 'http://127.0.0.1:43210',
        AHASTATION_WORKER_TOKEN: 'tok-test',
        AHASTATION_WORKER_ENTRY: '/fake/worker-cli.js',
      },
    }, () => {});
    await session.start();
    assert.ok(spawned, `${backendId} should spawn PTY`);
    const joinedArgs = spawned.args.join(' ');
    assert.doesNotMatch(joinedArgs, /dangerously-bypass|dangerously-skip|bypassPermissions|--full-auto/);
    session.end();
  }
});
