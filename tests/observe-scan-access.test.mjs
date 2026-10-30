import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ObserveService } from '../dist-electron/observe/observe-service.js';
import { canReadProject, ScanAccessStore } from '../dist-electron/observe/scan-access.js';
import { readOwnership } from '../dist-electron/observe/ownership.js';
import { readStudioHistory } from '../dist-electron/observe/studio-history.js';
import { clientRoots } from '../dist-electron/observe/session-identity.js';
import { parseWindowsProcesses, findClientPids } from '../dist-electron/observe/process/darwin.js';
import { isBoardableObserved } from '../dist-electron/observe/board-visibility.js';

const SID = 'c1a0de00-0000-4000-8000-000000000001';
const emptyProcesses = () => ({ byPid: new Map(), childrenOf: new Map(), capturedAt: Date.now() });
const digest = async (path) => createHash('sha256').update(await fs.readFile(path)).digest('hex');
const write = async (path, data) => {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, typeof data === 'string' ? data : JSON.stringify(data));
};
async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'aha-s2-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = await fs.realpath(dir);
  const project = join(root, 'allowed');
  const other = join(root, 'other');
  await fs.mkdir(project); await fs.mkdir(other);
  const configRoots = { claude: join(root, 'claude-config'), codex: join(root, 'codex-config') };
  const claude = async (id = SID, cwd = project, title = 'Only authorized title') => {
    const path = join(configRoots.claude, 'projects', 'encoded', `${id}.jsonl`);
    await write(path, JSON.stringify({ type: 'user', sessionId: id, cwd, message: { role: 'user', content: title } }) + '\n'
      + JSON.stringify({ type: 'assistant', sessionId: id, cwd, message: { role: 'assistant', content: [] } }) + '\n');
    return path;
  };
  const codex = async (id = SID, cwd = project) => {
    const path = join(configRoots.codex, 'archived_sessions', `${id}.jsonl`);
    await write(path, JSON.stringify({ type: 'session_meta', payload: { id, cwd, source: 'cli' } }) + '\n');
    return path;
  };
  const userData = join(root, 'profile');
  const owned = join(userData, 'sessions', 'owned.json');
  let access = { enabled: true, roots: [project] };
  const published = [];
  const service = (extra = {}) => new ObserveService({ homeDir: root, configRoots, userData,
    getAccess: () => access, publish: (snap) => published.push(snap), snapshotProvider: async () => emptyProcesses(), ...extra });
  return { root, project, other, configRoots, claude, codex, userData, owned, published, service,
    setAccess: (value) => { access = value; } };
}
const entry = (origin, extra = {}) => ({ agent: 'claude', sessionId: SID, origin,
  revision: 1, registeredAt: '2026-10-29T00:00:00Z', runtimeId: 'r-1',
  ...(origin === 'worker' ? { workerId: 'w-1', taskId: 't-1', attemptId: 'a-1' } : {}), ...extra });
const registry = (entries = [], launches = []) => ({ schemaVersion: 2, revision: 1, entries, launches });
const launch = (state = 'reserved', extra = {}) => ({ runtimeId: 'r-1', hostEpoch: 'epoch', agent: 'claude',
  origin: 'worker', workerId: 'w-1', taskId: 't-1', attemptId: 'a-1', permissionOwnerRef: 'owner',
  credentialRef: 'credential-reference', revision: 1, state, ...extra });

test('fresh profile does no filesystem or process scanning before consent', async (t) => {
  const f = await fixture(t);
  let processCalls = 0, readCalls = 0;
  const original = fs.readdir;
  fs.readdir = async (...args) => { readCalls++; return original(...args); };
  t.after(() => { fs.readdir = original; });
  const service = new ObserveService({ homeDir: f.root, userData: f.userData,
    publish: (snap) => f.published.push(snap), snapshotProvider: async () => { processCalls++; return emptyProcesses(); } });
  await service.tickOnce();
  assert.equal(processCalls, 0); assert.equal(readCalls, 0);
  assert.deepEqual(f.published[0].sessions, []);
  assert.equal(f.published[0].access.enabled, false);
});

test('only granted projects receive full transcript reads; native inputs are unchanged', async (t) => {
  const f = await fixture(t);
  const permitted = await f.claude();
  const forbidden = await f.claude('other-session', f.other, 'Private other project prompt');
  const before = [await digest(permitted), await digest(forbidden)];
  const opens = new Map(); const original = fs.open;
  fs.open = async (path, ...args) => { opens.set(path, (opens.get(path) ?? 0) + 1); return original(path, ...args); };
  t.after(() => { fs.open = original; });
  const s = f.service(); await s.tickOnce();
  assert.equal(f.published[0].sessions.length, 1);
  assert.equal(f.published[0].sessions[0].title, 'Only authorized title');
  assert.equal(opens.get(forbidden), 1, 'unauthorized source gets only bounded routing metadata');
  assert.ok(opens.get(permitted) >= 3, 'authorized source gets head/tail analysis');
  assert.equal(JSON.stringify(f.published).includes('Private other project prompt'), false);
  assert.deepEqual([await digest(permitted), await digest(forbidden)], before);
  f.setAccess({ enabled: false, roots: [] }); s.invalidate(); await s.tickOnce();
  assert.deepEqual(s.sessions, []);
  assert.deepEqual(f.published.at(-1).sessions, []);
});

test('revoke during an in-flight scan wins, even after an identical directory is re-granted', async (t) => {
  const f = await fixture(t); await f.claude();
  let release, entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const s = f.service({ snapshotProvider: async () => { entered(); await gate; return emptyProcesses(); } });
  const scan = s.tickOnce(); await waiting;
  f.setAccess({ enabled: false, roots: [] }); s.invalidate();
  f.setAccess({ enabled: true, roots: [f.project] }); s.invalidate();
  release(); await scan;
  assert.equal(f.published.length, 2);
  assert.ok(f.published.every((snap) => snap.sessions.length === 0));
  await s.tickOnce(); assert.equal(s.sessions.length, 1);
});

test('consent persists separately; queued enable cannot undo a later revoke', async (t) => {
  const f = await fixture(t); const path = join(f.userData, 'sessions', 'scan-access.json');
  const store = new ScanAccessStore(path);
  await store.load(); assert.equal(store.get().enabled, false); assert.equal(store.needsPrompt, true);
  const enable = store.set({ enabled: true, roots: [f.project] });
  const disable = store.set({ enabled: false, roots: [] });
  assert.equal(store.get().enabled, false);
  await Promise.all([enable, disable]);
  const reloaded = new ScanAccessStore(path); await reloaded.load();
  assert.deepEqual(reloaded.get(), { enabled: false, roots: [] });
  assert.equal(reloaded.needsPrompt, false, 'an explicit decline must survive restart');
  await reloaded.set({ enabled: true, roots: [f.project] });
  const third = new ScanAccessStore(path); await third.load();
  assert.deepEqual(third.get(), { enabled: true, roots: [f.project] });
  assert.equal((await fs.readdir(join(f.userData, 'sessions'))).some((p) => p.endsWith('.tmp')), false);
});

test('configuration roots honor both CLI overrides and include Codex archives', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(clientRoots(f.root, { CLAUDE_CONFIG_DIR: f.configRoots.claude, CODEX_HOME: f.configRoots.codex }), f.configRoots);
  await f.codex(); const s = f.service(); await s.tickOnce();
  assert.equal(s.sessions.length, 1); assert.equal(s.sessions[0].clientKind, 'codex');
  assert.equal(s.sessions[0].state, 'unknown', 'historical file recency cannot prove process completion');
});

test('IF-2 excludes Worker and Station history, retaining adopted sessions and agent-key isolation', async (t) => {
  const f = await fixture(t); const native = await f.claude(); await f.codex();
  const before = await digest(native);
  for (const origin of ['worker', 'station']) {
    await write(f.owned, registry([entry(origin)]));
    const s = f.service(); await s.tickOnce();
    assert.deepEqual(s.sessions.map((row) => row.clientKind), ['codex']);
  }
  await write(f.owned, registry([entry('user-adopted')]));
  const s = f.service(); await s.tickOnce();
  assert.equal(s.sessions.find((row) => row.clientKind === 'claude-code').origin, 'user-adopted');
  assert.equal(await digest(native), before);
});

test('unavailable or unsupported ownership invalidates cached user classification and message content', async (t) => {
  const f = await fixture(t); await f.claude(); const s = f.service();
  await s.tickOnce(); assert.equal(s.sessions[0].origin, 'user');
  for (const bad of ['{broken', { schemaVersion: 99, entries: [] }, registry([entry('worker'), entry('worker')])]) {
    await write(f.owned, bad); await s.tickOnce();
    assert.equal(s.sessions[0].ownership, 'unresolved');
    assert.equal(s.sessions[0].state, 'unknown');
    assert.notEqual(s.sessions[0].title, 'Only authorized title');
    assert.deepEqual(f.published.at(-1).diagnostics, ['ownership-unavailable']);
  }
});

test('unbound and aborted launches remain unresolved, while a valid atomic binding is excluded', async (t) => {
  const f = await fixture(t); await f.claude();
  for (const state of ['reserved', 'spawned', 'aborted']) {
    await write(f.owned, registry([], [launch(state)]));
    const s = f.service(); await s.tickOnce();
    assert.equal(s.sessions[0].origin, 'unknown');
    assert.equal(s.sessions[0].ownership, 'unresolved');
  }
  await write(f.owned, registry([entry('worker')], [launch('bound', { sessionId: SID })]));
  assert.equal((await readOwnership(f.owned)).available, true);
  const s = f.service(); await s.tickOnce(); assert.deepEqual(s.sessions, []);
  await write(f.owned, registry([], [launch('bound', { sessionId: SID })]));
  assert.equal((await readOwnership(f.owned)).available, false, 'torn binding cannot become an empty registry');
});

test('a registry change during scanning cannot publish a newly registered internal session as user', async (t) => {
  const f = await fixture(t); await f.claude();
  const s = f.service({ snapshotProvider: async () => {
    await write(f.owned, registry([entry('worker')]));
    return emptyProcesses();
  } });
  await s.tickOnce(); assert.deepEqual(s.sessions, []);
  assert.ok(f.published.every((snap) => snap.sessions.length === 0));
  await s.tickOnce(); assert.deepEqual(s.sessions, []);
});

test('Studio history is read without recovery or mutation and internal native sessions are excluded', async (t) => {
  const f = await fixture(t); await f.claude();
  const path = join(f.userData, 'meetings', 'm-1', 'snapshot.json');
  await write(path, { schemaVersion: 3, seq: 3, state: { cwd: f.project, hosts: [], tasks: [
    { id: 'task-1', title: 'Recorded task', status: 'done', backendSession: { protocol: 'claude-sdk', sessionId: SID } },
  ] } });
  const before = await digest(path);
  const history = await readStudioHistory(f.userData, { enabled: true, roots: [f.project] });
  assert.equal(history.tasks[0].title, 'Recorded task'); assert.equal(history.internalIds.has(SID), true);
  const s = f.service(); await s.tickOnce();
  assert.deepEqual(s.sessions, []); assert.equal(f.published.at(-1).studioTasks[0].status, 'done');
  assert.equal(await digest(path), before);
  const hidden = await readStudioHistory(f.userData, { enabled: true, roots: [f.other] });
  assert.deepEqual(hidden.tasks, []);
});

test('symlink escape does not inherit a directory grant or expose a transcript', async (t) => {
  const f = await fixture(t); const link = join(f.project, 'redirect');
  await fs.symlink(f.other, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await canReadProject(link, { enabled: true, roots: [f.project] }), false);
  await f.claude(SID, link, 'Outside project'); const s = f.service(); await s.tickOnce();
  assert.deepEqual(s.sessions, []);
  // A grant tied to a canonical root cannot survive replacing it with a link.
  assert.equal(await canReadProject(link, { enabled: true, roots: [link] }), false);
  assert.equal(await canReadProject(f.project, { enabled: true, roots: [join(f.root, 'removed'), f.project] }), true);
});

test('Windows process JSON accepts list/singleton/BOM, resolves IDs and excludes own descendants', async (t) => {
  const f = await fixture(t); await f.claude();
  const row = { ProcessId: 234, ParentProcessId: 1, Name: 'claude.exe', CommandLine: `claude.exe --resume ${SID}` };
  assert.equal(parseWindowsProcesses('\uFEFF' + JSON.stringify(row)).byPid.get(234).tty, '??');
  const snapshot = parseWindowsProcesses(JSON.stringify([row, { ...row, ProcessId: 235, ParentProcessId: 234 }]));
  assert.deepEqual(findClientPids(snapshot, ['claude']), [234, 235]);
  const s = f.service({ snapshotProvider: async () => snapshot }); await s.tickOnce();
  assert.equal(s.sessions[0].pid, 234); assert.equal(s.sessions[0].state, 'idle');
  const ownPids = new Set([1]);
  const excluded = f.service({ snapshotProvider: async () => snapshot,
    getSelfExclusion: () => ({ pids: ownPids, sessionIds: new Set() }) });
  await excluded.tickOnce(); assert.deepEqual(excluded.sessions, []);
  assert.deepEqual([...ownPids], [1], 'scanner must not mutate injected exclusions');
});

test('24-hour inactivity, idle and unresolved ownership cannot count as active or waiting', () => {
  const now = Date.now();
  const base = { isNoise: false, origin: 'user', ownership: 'unowned', lastActiveAt: now };
  for (const state of ['active', 'waiting']) {
    assert.equal(isBoardableObserved({ ...base, state }, now), true);
    assert.equal(isBoardableObserved({ ...base, state, lastActiveAt: now - 86_400_000 }, now), false);
    assert.equal(isBoardableObserved({ ...base, state, ownership: 'unresolved' }, now), false);
  }
  // Current main displays a live idle window in settled, never active/attention.
  assert.equal(isBoardableObserved({ ...base, state: 'idle', pid: 22 }, now), true);
});
