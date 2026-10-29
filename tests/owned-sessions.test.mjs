import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, access, readdir, stat, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { app } from 'electron';
import { registerOwnedSession } from '../dist-electron/collaboration/owned-sessions.js';
import { StationService } from '../dist-electron/collaboration/station-service.js';
import { getBackendRegistry } from '../dist-electron/backends/registry.js';
import { CodexExecution } from '../dist-electron/collaboration/execution.js';
import { GuardedCodexExecution, NativeExecution } from '../dist-electron/collaboration/native-helper.js';
import { Orchestrator } from '../dist-electron/orchestrator.js';

const input = id => ({ agent: 'codex', sessionId: id, origin: 'station', taskId: 'task-' + id, attemptId: 'attempt-' + id });
const complete = { summary: 'owned offline model fixture', stopped: false, exitConfirmed: true, turnOutcome: 'completed', contentComplete: true };

test('concurrent registry writes retain every record and leave existing adopted ownership unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-sessions-'));
  const file = join(root, 'sessions/owned.json');
  const adopted = { ...input('adopted'), origin: 'user-adopted', registeredAt: '2026-10-28T00:00:00Z', scannerMetadata: 'preserve' };
  try {
    await mkdir(join(root, 'sessions'));
    await writeFile(file, JSON.stringify([adopted]));
    await Promise.all(Array.from({ length: 24 }, (_, id) => registerOwnedSession(input('new-' + id), file)));
    const records = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(records.length, 25);
    assert.equal(new Set(records.map(row => row.sessionId)).size, 25);
    assert.deepEqual(records[0], adopted);
    assert.ok(records.slice(1).every(row => Number.isFinite(Date.parse(row.registeredAt))));
    const original = await readFile(file);
    await registerOwnedSession(input('new-0'), file);
    assert.deepEqual(await readFile(file), original, 'duplicate identity callbacks are idempotent');
    await assert.rejects(registerOwnedSession(input('adopted'), file), /已有其他归属/);
    assert.deepEqual(await readFile(file), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid JSON and invalid registry rows preserve exact original bytes and do not poison later writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-sessions-corrupt-'));
  const file = join(root, 'owned.json');
  try {
    for (const body of ['{bad owned registry', '{"sessions":[]}', '[{"agent":"codex"}]']) {
      await writeFile(file, body);
      const before = await readFile(file);
      await assert.rejects(registerOwnedSession(input('new'), file));
      assert.deepEqual(await readFile(file), before);
      await assert.rejects(access(file + '.next'), /ENOENT/);
    }
    await writeFile(file, '[]');
    await registerOwnedSession(input('new'), file);
    assert.equal(JSON.parse(await readFile(file, 'utf8'))[0].sessionId, 'new');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unknown registry schema versions, including a v2 candidate, are rejected without migration or replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-sessions-schema-'));
  const file = join(root, 'owned.json');
  try {
    for (const schemaVersion of [0, 2, 999]) {
      // These are unsupported objects, not a claim that the IF-2 draft is final.
      const body = JSON.stringify({ schemaVersion, revision: 7, entries: [], launches: [] }, null, 2) + '\n';
      await writeFile(file, body);
      const before = await readFile(file);
      await assert.rejects(registerOwnedSession(input('new'), file), /归属清单损坏/);
      assert.deepEqual(await readFile(file), before, 'unsupported versions must not become an empty legacy registry');
      assert.deepEqual(await readdir(root), ['owned.json'], 'no replacement may be staged');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a genuinely missing multi-level registry directory initializes atomically and reloaded duplicate registration preserves bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-sessions-first-write-'));
  const folder = join(root, 'missing', 'nested', 'sessions');
  const file = join(folder, 'owned.json');
  try {
    await assert.rejects(access(join(root, 'missing')), /ENOENT/);
    await registerOwnedSession(input('first'), file);
    const before = await readFile(file);
    const records = JSON.parse(before.toString('utf8'));
    assert.equal(records.length, 1);
    assert.deepEqual({ ...records[0], registeredAt: undefined }, { ...input('first'), registeredAt: undefined });
    assert.ok(Number.isFinite(Date.parse(records[0].registeredAt)));
    assert.deepEqual(await readdir(folder), ['owned.json']);
    // Each registration opens a new DurableState and reloads the durable file.
    await registerOwnedSession(input('first'), file);
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readdir(folder), ['owned.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('non-file registry paths preserve directory contents and a non-directory parent instead of creating an empty registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-sessions-nonfile-'));
  const directory = join(root, 'owned.json');
  const parentFile = join(root, 'parent-file');
  const sentinel = Buffer.from('owned path sentinel\r\n');
  try {
    await mkdir(directory);
    await writeFile(join(directory, 'sentinel.bin'), sentinel);
    await assert.rejects(registerOwnedSession(input('directory'), directory), /记录无法读取/);
    assert.equal((await stat(directory)).isDirectory(), true);
    assert.deepEqual(await readdir(directory), ['sentinel.bin']);
    assert.deepEqual(await readFile(join(directory, 'sentinel.bin')), sentinel);
    await assert.rejects(access(directory + '.next'), /ENOENT/);

    await writeFile(parentFile, sentinel);
    for (const suffix of ['owned.json', join('missing', 'nested', 'owned.json')]) {
      await assert.rejects(registerOwnedSession(input('parent-file'), join(parentFile, suffix)), /记录无法读取/);
    }
    assert.equal((await stat(parentFile)).isFile(), true);
    assert.deepEqual(await readFile(parentFile), sentinel);
    assert.deepEqual((await readdir(root)).sort(), ['owned.json', 'parent-file']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a genuinely unreadable registry rejects registration and preserves exact bytes after access returns', async t => {
  if (process.platform !== 'win32' && process.geteuid?.() === 0) {
    t.skip('root bypasses POSIX file permissions; this does not validate an unreadable-file case');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'owned-sessions-unreadable-'));
  const file = join(root, 'owned.json');
  const original = [{ ...input('existing'), registeredAt: '2026-10-29T00:00:00Z' }];
  let child, childExit, mode;
  try {
    await writeFile(file, JSON.stringify(original, null, 2) + '\n');
    const before = await readFile(file);
    if (process.platform === 'win32') {
      // Use an owned local file and Windows sharing enforcement, not chmod,
      // which does not make a Windows file unreadable to its current owner.
      const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const script = "$ErrorActionPreference='Stop'; $held=[System.IO.File]::Open($env:AHASTATION_REGISTRY_TEST_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); try {[Console]::WriteLine('held'); [Console]::Out.Flush(); [void][Console]::ReadLine()} finally {$held.Dispose()}";
      child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, AHASTATION_REGISTRY_TEST_FILE: file }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      childExit = once(child, 'exit');
      void childExit.catch(() => {});
      await new Promise((resolve, reject) => {
        let output = '', errors = '';
        const timer = setTimeout(() => reject(new Error('Owned registry file lock did not start: ' + errors)), 5000);
        child.stdout.on('data', data => {
          output += data;
          if (output.includes('held')) { clearTimeout(timer); resolve(); }
        });
        child.stderr.on('data', data => { errors = (errors + data).slice(-2000); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error('Owned registry file lock exited: ' + code + ' ' + errors)); });
      });
    } else {
      mode = (await stat(file)).mode;
      await chmod(file, 0o000);
    }
    await assert.rejects(readFile(file), error => ['EACCES', 'EPERM', 'EBUSY'].includes(error.code), 'the fixture must deny a real read');
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(registerOwnedSession(input('new'), file), /记录无法读取/);
    }
    if (child) {
      child.stdin.end('release\n');
      const [code] = await childExit;
      assert.equal(code, 0);
    } else {
      await chmod(file, mode);
    }
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readdir(root), ['owned.json'], 'a read failure must not stage an empty replacement');
    await registerOwnedSession(input('existing'), file);
    assert.deepEqual(await readFile(file), before, 'failed reads must not poison the queue or alter existing ownership');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end('release\n');
      await childExit;
    }
    if (mode !== undefined) await chmod(file, mode);
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('owned Station fixture did not finish');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('actual Station worker identity callbacks register created threads while native and unproven resumed sessions remain unclaimed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-station-identity-'));
  const oldPath = app.getPath;
  const backend = getBackendRegistry().get('codex');
  const old = { resolveBinary: backend.resolveBinary, buildEnv: backend.buildEnv,
    guardedRun: GuardedCodexExecution.prototype.run, codexRun: CodexExecution.prototype.run, nativeRun: NativeExecution.prototype.run };
  const services = [];
  try {
    app.getPath = () => root;
    backend.resolveBinary = () => '/owned-fixture/codex';
    backend.buildEnv = () => ({});
    GuardedCodexExecution.prototype.run = CodexExecution.prototype.run = NativeExecution.prototype.run = async function (request, hooks) {
      const thread = request.threadId ?? (this instanceof NativeExecution ? 'original-user-thread' : 'created-worker-thread');
      await hooks.identity(thread);
      await hooks.identity(thread, 'fixture-turn');
      return complete;
    };
    for (const kind of ['created', 'native', 'resumed']) {
      const service = new StationService(join(root, kind)); services.push(service);
      const task = { id: kind, revision: 1, meetingId: 'meeting', attemptId: 'attempt-' + kind,
        agentId: 'codex', resource: kind === 'native' ? 'native' : 'text', permission: 'read-only',
        objective: 'owned fixture', status: 'offered', targetDeviceId: 'local', inputs: [] };
      const receipt = { taskId: task.id, attemptId: task.attemptId, status: 'received', bindingRevision: 0, output: [],
        ...(kind === 'native' ? { cwd: root } : {}), ...(kind === 'resumed' ? { nativeThreadId: 'unproven-old-thread' } : {}) };
      await service.storage.update(state => {
        state.deviceId = 'local'; state.allowedAgents = ['codex']; state.snapshot.entities.task = [task]; state.receipts[task.id] = receipt;
      });
      service.localReady = true;
      service.authorize = async () => 0;
      service.send = async () => ({});
      service.deliverTask = async () => {};
      service.pump = async () => {};
      await service.startTask(task, receipt, kind === 'native', kind === 'native');
      await waitFor(() => service.storage.read().receipts[task.id].exitConfirmed === true);
    }
    const records = JSON.parse(await readFile(join(root, 'sessions/owned.json'), 'utf8'));
    assert.equal(records.length, 1);
    assert.deepEqual({ ...records[0], registeredAt: undefined }, { ...input('created-worker-thread'),
      taskId: 'created', attemptId: 'attempt-created', registeredAt: undefined });
  } finally {
    await Promise.all(services.map(service => service.shutdown()));
    app.getPath = oldPath;
    backend.resolveBinary = old.resolveBinary; backend.buildEnv = old.buildEnv;
    GuardedCodexExecution.prototype.run = old.guardedRun; CodexExecution.prototype.run = old.codexRun; NativeExecution.prototype.run = old.nativeRun;
    await rm(root, { recursive: true, force: true });
  }
});

test('Station discussion records the actual new thread once and preserves the registration across subsequent turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-discussion-identity-'));
  const oldPath = app.getPath;
  let service;
  try {
    app.getPath = () => root;
    service = new StationService(join(root, 'station'));
    await service.storage.update(state => { state.deviceId = 'local'; state.allowedAgents = ['codex']; });
    service.send = async () => ({});
    service.prepareDiscussionInput = async () => ({ text: 'owned offline discussion', images: [] });
    service.discussionExecution = () => ({ run: async (_request, hooks) => { await hooks.identity('created-discussion-thread'); return complete; }, close() {}, async stop() { return true; } });
    const meeting = { id: 'meeting', revision: 1 };
    const message = { id: 'message', revision: 1, meetingId: meeting.id, route: 'agent', targetDeviceId: 'local', targetAgentId: 'codex' };
    await service.discuss(meeting, message);
    const file = join(root, 'sessions/owned.json');
    const first = await readFile(file);
    await service.discuss(meeting, { ...message, id: 'next-message' });
    assert.deepEqual(await readFile(file), first);
    const records = JSON.parse(first.toString('utf8'));
    assert.equal(records.length, 1);
    assert.equal(records[0].sessionId, 'created-discussion-thread');
    assert.equal(records[0].taskId, message.id);
    assert.equal(records[0].attemptId, message.id);
    assert.equal(service.storage.read().discussionThreads['meeting:codex'], records[0].sessionId);
  } finally {
    await service?.shutdown();
    app.getPath = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});

test('both Station Host paths register proven new sessions using the input identity and preserve resumed ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-host-identity-'));
  const oldPath = app.getPath;
  const backend = getBackendRegistry().get('codex');
  const old = { resolveBinary: backend.resolveBinary, buildEnv: backend.buildEnv, run: GuardedCodexExecution.prototype.run };
  const services = [];
  try {
    app.getPath = () => root;
    backend.resolveBinary = () => '/owned-fixture/codex';
    backend.buildEnv = () => ({});
    GuardedCodexExecution.prototype.run = async function (request, hooks) {
      const thread = request.threadId ?? 'created-host-' + this.executionId;
      await hooks.identity(thread);
      await hooks.identity(thread, 'fixture-turn');
      return complete;
    };
    const registry = join(root, 'sessions/owned.json');
    await mkdir(join(root, 'sessions'));
    const adopted = ['unified', 'legacy'].map(kind => ({ ...input('user-' + kind), origin: 'user-adopted', registeredAt: '2026-10-28T00:00:00Z' }));
    await writeFile(registry, JSON.stringify(adopted));
    for (const kind of ['unified', 'legacy']) {
      for (const resumed of [false, true]) {
        const id = kind + (resumed ? '-resumed' : '-new');
        const service = new StationService(join(root, id)); services.push(service);
        const meeting = { id, revision: 1, hostAgentId: 'codex', coordinatorDeviceId: 'local',
          ...(kind === 'unified' ? { hostAuthority: 'original-orchestrator' } : {}) };
        const first = { id: id + '-input', revision: 1, meetingId: id, route: 'host', text: 'offline owned Host fixture' };
        await service.storage.update(state => {
          state.deviceId = 'local'; state.allowedAgents = ['codex'];
          state.snapshot.entities.meeting = [meeting]; state.snapshot.entities.message = [first];
          if (resumed) {
            if (kind === 'unified') state.originalHostSessions = { [id]: { protocol: 'codex-app-server', sessionId: 'user-' + kind } };
            else state.hostThreads = { [id]: 'user-' + kind };
          }
        });
        service.send = async () => ({});
        const host = service.coordinator(meeting);
        if (kind === 'unified') {
          // Exercise the actual guarded factory and input lifecycle while replacing only the model transport.
          host.start = async () => {};
          const session = host.guardedFactory()({ emit: event => host.event({ source: 'talker', event }) });
          host.orch = { sendUserText: text => session.sendUserText(text), hostSessionSnapshot: () => session.snapshot(),
            end() {}, async interruptHostReply() {} };
        }
        await host.input(first);
        const afterFirst = await readFile(registry);
        await host.input({ ...first, id: id + '-next-input' });
        assert.deepEqual(await readFile(registry), afterFirst, 'later turns must preserve initial ownership');
      }
    }
    const records = JSON.parse(await readFile(registry, 'utf8'));
    assert.equal(records.length, 4);
    assert.deepEqual(records.slice(0, 2), adopted);
    for (const kind of ['unified', 'legacy']) {
      const created = records.find(row => row.sessionId === 'created-host-' + kind + '-new-input');
      assert.ok(created, kind + ' actual identity must register');
      assert.equal(created.origin, 'station');
      assert.equal(created.taskId, kind + '-new-input');
      assert.equal(created.attemptId, kind + '-new-input');
    }
  } finally {
    await Promise.all(services.map(service => service.shutdown()));
    app.getPath = oldPath;
    backend.resolveBinary = old.resolveBinary; backend.buildEnv = old.buildEnv; GuardedCodexExecution.prototype.run = old.run;
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed first non-Codex SDK Host turn retains its new session before failure, including startup rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-sdk-host-failure-'));
  const oldPath = app.getPath;
  const old = { start: Orchestrator.prototype.start, snapshot: Orchestrator.prototype.hostSessionSnapshot };
  const services = [];
  try {
    app.getPath = () => root;
    const file = join(root, 'sessions/owned.json');
    await mkdir(join(root, 'sessions'));
    const adopted = { ...input('existing-sdk-user'), agent: 'claude-code', origin: 'user-adopted', registeredAt: '2026-10-28T00:00:00Z' };
    await writeFile(file, JSON.stringify([adopted]));
    for (const kind of ['error', 'ended', 'auth-required', 'startup']) {
      for (const resumed of [false, true]) {
        const id = 'sdk-' + kind + (resumed ? '-resumed' : '-new');
        const service = new StationService(join(root, id)); services.push(service);
        const meeting = { id, revision: 1, hostAgentId: 'claude-code', coordinatorDeviceId: 'local', hostAuthority: 'original-orchestrator' };
        const message = { id: id + '-input', revision: 1, meetingId: id, route: 'host', text: 'owned SDK failure fixture' };
        const snapshot = { protocol: 'claude-cli', sessionId: resumed ? adopted.sessionId : 'created-' + id };
        await service.storage.update(state => {
          state.snapshot.entities.meeting = [meeting]; state.snapshot.entities.message = [message];
          if (resumed) state.originalHostSessions = { [id]: snapshot };
        });
        service.send = async () => ({});
        const host = service.coordinator(meeting);
        if (kind === 'startup') {
          // The real UnifiedMeetingHost.start catch must capture before end() clears the Orchestrator.
          Orchestrator.prototype.start = async () => { throw new Error('owned SDK startup rejection'); };
          Orchestrator.prototype.hostSessionSnapshot = () => snapshot;
        } else {
          host.start = async () => {};
          host.orch = {
            sendUserText() { host.event({ source: 'talker', event: kind === 'ended'
              ? { kind: 'ended', reason: 'crashed' } : { kind, error: 'owned SDK turn rejection' } }); },
            hostSessionSnapshot: () => snapshot, end() {}, async interruptHostReply() {},
          };
        }
        const before = JSON.parse(await readFile(file, 'utf8')).length;
        await assert.rejects(host.input(message), /owned SDK|连接已结束/);
        const records = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(records.length, before + (resumed ? 0 : 1), id);
        assert.deepEqual(records[0], adopted);
        assert.equal(service.storage.read().originalHostSessions[id].sessionId, snapshot.sessionId);
        assert.ok(['failed', 'reconcile'].includes(service.storage.read().hostMessages[message.id]));
        if (!resumed) {
          const registered = records.find(row => row.sessionId === snapshot.sessionId);
          assert.equal(registered.agent, 'claude-code');
          assert.equal(registered.taskId, message.id);
          assert.equal(registered.attemptId, message.id);
        }
        Orchestrator.prototype.start = old.start; Orchestrator.prototype.hostSessionSnapshot = old.snapshot;
      }
    }
  } finally {
    Orchestrator.prototype.start = old.start; Orchestrator.prototype.hostSessionSnapshot = old.snapshot;
    await Promise.all(services.map(service => service.shutdown()));
    app.getPath = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});

test('SDK init registers the actual Host session while its first turn is still held and shares one capture across events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-sdk-host-init-'));
  const oldPath = app.getPath;
  let service, host, running, release;
  const captureGate = new Promise(resolve => { release = resolve; });
  let creationCalls = 0, settled = false;
  try {
    app.getPath = () => root;
    service = new StationService(join(root, 'station'));
    const meeting = { id: 'held-sdk', revision: 1, hostAgentId: 'claude-code', coordinatorDeviceId: 'local', hostAuthority: 'original-orchestrator' };
    const message = { id: 'held-sdk-input', revision: 1, meetingId: meeting.id, route: 'host', text: 'owned held SDK fixture' };
    await service.storage.update(state => {
      state.snapshot.entities.meeting = [meeting]; state.snapshot.entities.message = [message];
    });
    service.send = async () => ({});
    host = service.coordinator(meeting);
    const register = host.hooks.createdSession;
    host.hooks.createdSession = async (...args) => {
      creationCalls += 1;
      await captureGate;
      await register(...args);
    };
    let snapshot = null;
    host.start = async () => {};
    host.orch = {
      sendUserText() {
        snapshot = { protocol: 'claude-cli', sessionId: 'held-sdk-session' };
        host.event({ source: 'talker', event: { kind: 'message', message: { type: 'system', subtype: 'init', session_id: snapshot.sessionId } } });
      },
      hostSessionSnapshot: () => snapshot, end() {}, async interruptHostReply() {},
    };
    running = host.input(message);
    void running.then(() => { settled = true; }, () => { settled = true; });
    await waitFor(() => creationCalls === 1);
    for (let index = 0; index < 3; index++) {
      host.event({ source: 'talker', event: { kind: 'message', message: { type: 'system', subtype: 'status' } } });
    }
    assert.equal(creationCalls, 1, 'init and later events must reuse the pending capture');
    release();
    await host.sessionCapture;
    const records = JSON.parse(await readFile(join(root, 'sessions/owned.json'), 'utf8'));
    assert.equal(records[0].sessionId, snapshot.sessionId);
    assert.equal(records[0].taskId, message.id);
    assert.equal(records[0].attemptId, message.id);
    assert.equal(settled, false, 'ownership must be durable before the model turn ends');
    host.event({ source: 'talker', event: { kind: 'turn-status', status: 'completed' } });
    await running;
    assert.equal(creationCalls, 1);
  } finally {
    release();
    if (host?.current) host.event({ source: 'talker', event: { kind: 'turn-status', status: 'completed' } });
    await running?.catch(() => {});
    await service?.shutdown();
    app.getPath = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});
