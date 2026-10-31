import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerOwnershipService } from '../dist-electron/native-worker/ownership.js';
import { NativeWorkerRun } from '../dist-electron/native-worker/run.js';
import { NativeWorkerHookRouter } from '../dist-electron/native-worker/hook-router.js';
import { OutsideWriteMonitor } from '../dist-electron/native-worker/boundary.js';
import { recordAppCreatedWorktree, canAutoTrustAppWorktree } from '../dist-electron/native-worker/worktree-trust.js';
import { compileTaskAuthority, evaluateTaskAuthority, extendAuthorityAddendum } from '../dist-electron/task-authority.js';
import { normalizeBackendPermissionRequest } from '../dist-electron/backends/canonical-execution.js';
import { isReadOnlyNetworkCommand } from '../dist-electron/read-only-network.js';

const binding = { agent: 'claude', origin: 'worker', runtimeId: 'runtime', hostEpoch: 'host', workerId: 'worker',
  taskId: 'task', attemptId: 'attempt', permissionOwnerRef: 'local-authority', credentialRef: 'restricted-channel' };
const processIdentity = { pid: 12, startId: 'os-start-counter', bootId: 'os-boot-id' };
const report = { status: 'completed', summary: 'candidate only', files: [], tests: [], unresolved: [] };
function root(t) {
  const directory = mkdtempSync(join(tmpdir(), 'aha86-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function grant(directory, overrides = {}) {
  return compileTaskAuthority('task', 1, 1, 'plan-approved', directory, {
    writePaths: [], toolKinds: ['read', 'command'], commands: [['gh', 'issue', 'view', '1', '--repo', 'synthetic/repo']],
    workingDirectories: ['.'], environmentKeys: [], networkHosts: [], maxCommandTimeoutMs: 1000, ...overrides,
  }, Date.now());
}
function normalized(directory, command) {
  const result = normalizeBackendPermissionRequest('claude-code', { backendId: 'claude-code', taskId: 'task', attempt: 1,
    workspaceRoot: directory, nativeRequestId: 'native', toolName: 'Bash', input: { executable: command[0], argv: command.slice(1), cwd: directory } });
  assert.equal(result.ok, true); return result.request;
}
function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aha86-')), ownership = new WorkerOwnershipService(directory);
  ownership.initialize(); t.after(() => { ownership.close(); rmSync(directory, { recursive: true, force: true }); });
  const peer = Object.freeze({ channel: 'test-guard-only' }), states = [], writes = [], reports = [];
  let current = true, boundary = true, terminated = 0;
  const authority = grant(directory);
  const guard = { spawn: async () => processIdentity, verifyPeer: value => value === peer,
    verifyWriter: value => value === peer,
    write: (data, writer) => { writes.push({ data, writer }); return true; }, seal: () => {}, interrupt: async () => {},
    terminateTree: async () => { terminated++; return { confirmed: true }; }, verifyTreeExit: value => value === peer };
  const run = new NativeWorkerRun({ binding, attempt: 1, workspaceRoot: directory, ownership, guard,
    getGrant: () => authority, isCurrentAttempt: () => current, askUser: async () => 'allow',
    checkBoundary: async () => boundary, onReport: value => reports.push(value), onState: state => states.push(state),
    approvalTimeoutMs: 30, stopTimeoutMs: 1, ...overrides });
  return { directory, ownership, run, peer, guard, states, writes, reports, authority,
    setCurrent(value) { current = value; }, setBoundary(value) { boundary = value; }, get terminated() { return terminated; } };
}
const call = (id = 'call', command = ['gh', 'issue', 'edit', '1', '--repo', 'synthetic/repo', '--title', 'local-fixture']) => ({
  invocationId: id, stage: 'PreToolUse', sessionId: 'native-session', toolName: 'Bash', input: { executable: command[0], argv: command.slice(1) },
});

test('a late spawn after stop timeout cannot reopen input and is terminated again', async t => {
  const f = fixture(t); let spawned;
  f.guard.spawn = () => new Promise(resolve => { spawned = resolve; });
  const starting = f.run.start();
  assert.equal(await f.run.stop(), false);
  spawned(processIdentity);
  await assert.rejects(starting, /revoked/);
  assert.ok(f.terminated >= 2);
  assert.equal(f.run.input(f.run.basis(), 'host', 'late prompt'), false);
  assert.equal(f.ownership.lookup('claude', 'native-session').status, 'unresolved');
});

test('approval timeout, grant replacement and unavailable ownership never revive old authority', async t => {
  const f = fixture(t, { askUser: () => new Promise(() => {}), approvalTimeoutMs: 1 });
  await f.run.start(); f.run.bind(f.peer, 'native-session', f.run.basis());
  assert.equal(await f.run.requestTool(f.peer, f.run.basis(), call()), null);
  writeFileSync(f.ownership.path, 'unreadable-manifest');
  assert.equal(f.run.input(f.run.basis(), 'host', 'must stop'), false);
  assert.equal(f.states.at(-1), 'stopping'); await f.run.stop();
});

test('IF-2 uses one writer, same-file bind and CAS; corrupt/unknown manifests stay unavailable', t => {
  const f = fixture(t);
  assert.throws(() => new WorkerOwnershipService(f.directory));
  assert.equal(f.ownership.lookup('claude', 'missing').status, 'absent');
  const reserved = f.ownership.reserve(binding);
  assert.deepEqual(f.ownership.reserve(binding), reserved);
  assert.equal(f.ownership.lookup('claude', 'missing').status, 'unresolved');
  const spawned = f.ownership.attach('runtime', reserved.revision, processIdentity);
  assert.deepEqual(f.ownership.attach('runtime', reserved.revision, processIdentity), spawned);
  assert.throws(() => f.ownership.attach('runtime', reserved.revision, { ...processIdentity, startId: 'reused-pid' }), /conflict/);
  const bound = f.ownership.bind('runtime', spawned.revision, 'native-session');
  assert.deepEqual(f.ownership.bind('runtime', spawned.revision, 'native-session'), bound, 'lost acknowledgement is idempotent');
  const file = JSON.parse(readFileSync(f.ownership.path, 'utf8'));
  assert.equal(file.schemaVersion, 2); assert.equal(file.entries[0].sessionId, file.launches[0].sessionId);
  assert.throws(() => f.ownership.reserve({ ...binding, runtimeId: 'duplicate-attempt' }), /conflict/);
  const second = f.ownership.reserve({ ...binding, runtimeId: 'other', workerId: 'other-worker', taskId: 'other-task', attemptId: 'other-attempt' });
  const attached = f.ownership.attach('other', second.revision, { ...processIdentity, pid: 13 });
  assert.throws(() => f.ownership.bind('other', attached.revision, 'native-session'), /conflict/);
  writeFileSync(f.ownership.path, '{broken');
  assert.equal(f.ownership.lookup('claude', 'native-session').status, 'unavailable');
  assert.throws(() => f.ownership.initialize(), /unavailable/);
  assert.equal(readFileSync(f.ownership.path, 'utf8'), '{broken');
  writeFileSync(f.ownership.path, JSON.stringify({ ...file, schemaVersion: 99 }));
  assert.equal(f.ownership.lookup('claude', 'native-session').status, 'unavailable');
});

test('binding requires trusted peer and current host/runtime/credential; first hook can be PreToolUse', async t => {
  const f = fixture(t); await f.run.start();
  assert.equal(f.run.input(f.run.basis(), 'host', 'must wait'), false);
  assert.throws(() => f.run.bind({ ...f.peer }, 'native-session', f.run.basis()), /rejected/);
  for (const key of ['hostEpoch', 'runtimeId', 'attemptId', 'credentialRef', 'taskId']) {
    assert.throws(() => f.run.bind(f.peer, 'native-session', { ...f.run.basis(), [key]: 'old' }), /rejected/);
  }
  const router = new NativeWorkerHookRouter('claude', f.run);
  const response = await router.receive(f.peer, f.run.basis(), { session_id: 'native-session', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'README.md' } });
  assert.ok(response.permit);
  assert.equal(f.run.input(f.run.basis(), 'host', 'forged writer'), false);
  assert.equal(f.run.input(f.run.basis(), 'host', 'now bound', f.peer), true);
  f.setCurrent(false);
  assert.equal(f.run.consume(f.peer, response.permit.id, response.call), false);
  assert.throws(() => f.run.report(f.peer, f.run.basis(), report), /rejected/);
});

test('external writes approve each invocation, never reuse tool IDs or command fingerprints', async t => {
  const requests = [];
  const f = fixture(t, { askUser: async request => { requests.push(request); return 'allow'; } });
  await f.run.start(); f.run.bind(f.peer, 'native-session', f.run.basis());
  for (const command of [
    ['gh', 'issue', 'edit', '1', '--repo', 'synthetic/repo', '--title', 'a'],
    ['gh', 'issue', 'edit', '1', '--repo', 'synthetic/repo', '--title', 'b'],
    ['gh', 'api', 'repos/synthetic/repo/issues/1', '-X', 'PATCH'],
    ['git', 'push', 'synthetic-local-remote'],
    ['gh', 'my-alias'],
  ]) {
    const c = call(`call-${requests.length}`, command), p = await f.run.requestTool(f.peer, f.run.basis(), c);
    assert.ok(p); assert.equal(f.run.consume(f.peer, p.id, { ...c, input: { changed: true } }), false);
    assert.equal(f.run.consume(f.peer, p.id, c), false, 'failed consume cannot replay');
  }
  assert.equal(requests.length, 5); assert.equal(new Set(requests.map(r => r.id)).size, 5);
  assert.equal(await f.run.requestTool(f.peer, f.run.basis(), call('wrapped', ['bash', '-c', 'gh issue edit 1'])), null);
  const spoofed = call('spoofed'); spoofed.input.command = 'gh issue edit 999';
  assert.equal(await f.run.requestTool(f.peer, f.run.basis(), spoofed), null);
  const c = call('repeated'); const p = await f.run.requestTool(f.peer, f.run.basis(), c);
  assert.equal(f.run.consume(f.peer, p.id, c), true);
  assert.equal(f.run.consume(f.peer, p.id, c), false);
  assert.equal(await f.run.requestTool(f.peer, f.run.basis(), c), null);
});

test('stop wins pending approvals and consumed-late permits; no boolean/root/Stop proves tree exit', async t => {
  let answer;
  const f = fixture(t, { askUser: () => new Promise(resolve => { answer = resolve; }) });
  await f.run.start(); f.run.bind(f.peer, 'native-session', f.run.basis());
  const basis = f.run.basis(), waiting = f.run.requestTool(f.peer, basis, call());
  const stopping = f.run.stop(); answer('allow');
  assert.equal(await waiting, null); assert.equal(f.run.input(basis, 'host', 'late'), false);
  assert.equal(await f.run.requestTool(f.peer, f.run.basis(), call('late')), null);
  assert.equal(await stopping, false); assert.equal(f.states.at(-1), 'stopping'); assert.equal(f.terminated, 1);
  assert.equal(f.run.confirmTreeExit({ confirmed: true }), false);
  assert.equal(f.run.confirmTreeExit(f.peer), true); assert.equal(f.states.at(-1), 'stopped');
  assert.equal(f.ownership.lookup('claude', 'native-session').entry.ended, true);
});

test('takeover has one writer, old approvals fail, handback review cannot race stop', async t => {
  const f = fixture(t); await f.run.start(); f.run.bind(f.peer, 'native-session', f.run.basis());
  const before = f.run.basis(), c = call(), permit = await f.run.requestTool(f.peer, before, c);
  const human = f.run.takeover(before);
  assert.equal(f.run.input(before, 'host', 'stale'), false); assert.equal(f.run.input(human, 'host', 'host'), false);
  assert.equal(f.run.input(human, 'human', 'human', f.peer), true); assert.equal(f.run.consume(f.peer, permit.id, c), false);
  let reviewed;
  const handingBack = f.run.handback(human, () => new Promise(resolve => { reviewed = resolve; }));
  assert.equal(f.run.input(f.run.basis(), 'human', 'during review'), false);
  const stopping = f.run.stop(); reviewed(true);
  await assert.rejects(handingBack, /rejected/); await stopping;
  assert.equal(f.states.at(-1), 'stopping');
});

test('reports are attempt-scoped idempotent candidates and cannot resurrect stop; boundary violations stop', async t => {
  const f = fixture(t); await f.run.start(); f.run.bind(f.peer, 'native-session', f.run.basis());
  const basis = f.run.basis(), receipt = f.run.report(f.peer, basis, report);
  assert.equal(f.run.report(f.peer, basis, report), receipt); assert.equal(f.reports.length, 1);
  assert.throws(() => f.run.report(f.peer, basis, { ...report, summary: 'different' }), /conflict/);
  f.setBoundary(false);
  assert.equal(await f.run.requestTool(f.peer, basis, call()), null);
  assert.equal(f.states.at(-1), 'stopping'); assert.throws(() => f.run.report(f.peer, basis, report), /rejected/);
  await f.run.stop();
});

test('G4 detects finite local boundary changes and refuses unbounded/unverifiable snapshots', t => {
  const directory = root(t), sentinel = join(directory, 'outside.txt');
  writeFileSync(sentinel, 'initial');
  const monitor = new OutsideWriteMonitor([directory]); assert.equal(monitor.check(), false);
  monitor.capture(); assert.equal(monitor.check(), true);
  writeFileSync(sentinel, 'unauthorized'); assert.equal(monitor.check(), false);
  assert.throws(() => new OutsideWriteMonitor([directory], 1).capture(), /limit/);
});

test('auto-trust requires a main-side creation receipt and exact unchanged directory; defaults off', t => {
  const directory = root(t), tree = join(directory, 'created'); mkdirSync(tree); writeFileSync(join(tree, '.git'), 'gitdir: synthetic');
  assert.equal(canAutoTrustAppWorktree(tree, true), false);
  recordAppCreatedWorktree(tree); assert.equal(canAutoTrustAppWorktree(tree, false), false);
  assert.equal(canAutoTrustAppWorktree(tree, true), true);
  writeFileSync(join(tree, '.git'), 'gitdir: changed'); assert.equal(canAutoTrustAppWorktree(tree, true), false);
});

test('read-only + network authorizes exact scoped reads without inheriting shell/write/credential/API powers', t => {
  const directory = root(t), command = ['gh', 'issue', 'view', '1', '--repo', 'synthetic/repo'];
  const authority = grant(directory, { permissionProfile: 'read-only-network', networkHosts: ['api.github.com'] });
  const read = normalized(directory, command);
  assert.equal(evaluateTaskAuthority(authority, read).kind, 'allow');
  for (const argv of [
    ['gh', 'issue', 'edit', '1', '--repo', 'synthetic/repo'], ['gh', 'issue', 'view', '2', '--repo', 'synthetic/repo'],
    ['gh', 'api', '/repos/synthetic/repo/issues', '-X', 'POST'], ['git', 'push'], ['sh', '-c', command.join(' ')],
    [...command, '--web'], [...command, '--template', '{{exec "bad"}}'], ['gh', 'alias'],
  ]) assert.equal(evaluateTaskAuthority(authority, normalized(directory, argv)).kind, 'deny', argv.join(' '));
  for (const changes of [{ kind: 'write', writePaths: ['bad.txt'] }, { kind: 'network', networkHosts: ['api.github.com'] },
    { environmentKeys: ['GH_TOKEN'] }, { readPaths: [join(tmpdir(), 'private-token')] }]) {
    assert.notEqual(evaluateTaskAuthority(authority, { ...read, ...changes }).kind, 'allow');
  }
  assert.equal(isReadOnlyNetworkCommand([...command, '--jq', 'exec']), false);
  assert.throws(() => grant(directory, { permissionProfile: 'read-only-network', networkHosts: ['api.github.com'], writePaths: ['bad'] }), /invalid/);
  const external = normalized(directory, ['gh', 'issue', 'edit', '1']);
  assert.deepEqual(extendAuthorityAddendum(authority, external).commands, []);
});
