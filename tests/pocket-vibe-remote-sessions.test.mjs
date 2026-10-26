import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { app, ipcMain } from 'electron';
import { PocketVibeBackend, fetchPocketVibeRemoteSessions, extractPocketVibeResultText } from '../dist-electron/backends/pocket-vibe-adapter.js';
import { parsePocketVibeRemoteHosts, remoteSessionKey, resolveRemoteTarget, remoteMentionIds } from '../dist-electron/backends/pocket-vibe-target.js';
import { getBackendRegistry } from '../dist-electron/backends/registry.js';
import { Orchestrator } from '../dist-electron/orchestrator.js';
import { MeetingRepository } from '../dist-electron/meeting-repository.js';
import { setOpenTabs, getSettings, updateSettings, setBackendAuth, flushSettingsWrites } from '../dist-electron/store.js';
import { SessionRegistry } from '../dist-electron/sessions.js';
import { registerSessionsIpc, flushOpenTabsNow } from '../dist-electron/ipc/sessions.js';
import { registerSessionIpc } from '../dist-electron/ipc/session.js';
import { registerAttachmentsIpc } from '../dist-electron/ipc/attachments.js';
import { readdir } from 'node:fs/promises';

const root = await mkdtemp(join(tmpdir(), 'station-remote-test-'));
app.getPath = () => root;
test.after(async () => { await rm(root, { recursive: true, force: true }); });
const target = (id = 'native-a', overrides = {}) => ({
  agent_id: 'desktop-codex', provider: 'codex', session_id: id,
  cwd: 'C:\\remote\\project', title: `Remote ${id}`, computer_name: 'Desktop', ...overrides,
  device_id: overrides.device_id ?? 'fixture-device',
});
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
async function waitFor(fn) {
  for (let i = 0; i < 600; i++) { if (fn()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail('timed out waiting for fixture');
}
function directoryFixture() {
  return { ok: true, status: 'connected', sessions: [target(), target('native-b', { agent_id: 'desktop-claude', provider: 'claude', cwd: '/remote/b' }), target('native-c')],
    agents: [{ agent_id: 'desktop-codex', device_id: 'fixture-device', provider: 'codex', status: 'ready' },
      { agent_id: 'desktop-claude', device_id: 'fixture-device', provider: 'claude', status: 'ready' }] };
}
function fakeHub() {
  const posts = [];
  return { posts, fetchImpl: async (url, init = {}) => {
    if (url.endsWith('/health')) return response({ ok: true });
    if (url.endsWith('/v1/agents')) return response({ agents: [] });
    if (url.includes('/v1/remote-sessions')) return response(directoryFixture());
    if (init.method === 'POST') {
      const body = JSON.parse(init.body); posts.push(body);
      return response({ ok: true, turn_id: `hub-turn-${posts.length}` });
    }
    const index = Number(url.match(/hub-turn-(\d+)$/)[1]) - 1;
    const body = posts[index];
    return response({ task: { status: 'done', result: { json: { last_message: `reply:${body.target_agent_id}:${body.session_id}` } } } });
  } };
}

test('remote target wins over global settings, local cwd, conflicting options, and old Hub turn id for two turns', async () => {
  const hub = fakeHub(); const events = [];
  const backend = new PocketVibeBackend({ fetchImpl: hub.fetchImpl, pollIntervalMs: 1 });
  const session = backend.createSession({ cwd: '/station-local', remoteTarget: target(), resumeSessionId: 'hub-turn-old', model: 'global-agent',
    env: { POCKET_VIBE_TOOL_TOKEN: 'fixture', POCKET_VIBE_AGENT_ID: 'global-agent', POCKET_VIBE_SESSION_ID: 'wrong-session',
      POCKET_VIBE_PROVIDER: 'claude', POCKET_VIBE_TURN_OPTIONS: JSON.stringify({ mode: 'continue', cwd: '/local', session_id: 'wrong', model: 'keep-model' }) },
  }, (e) => events.push(e));
  try {
    await session.start(); session.sendUserText('one'); session.sendUserText('two');
    await waitFor(() => events.filter((e) => e.kind === 'message' && e.message.type === 'assistant').length === 2);
    for (const body of hub.posts) {
      assert.equal(body.target_agent_id, target().agent_id);
      assert.equal(body.provider, 'codex'); assert.equal(body.session_id, 'native-a');
      assert.equal(body.cwd, target().cwd);
      assert.deepEqual(body.turn_options, { mode: 'resume', cwd: target().cwd, session_id: 'native-a', model: 'keep-model' });
    }
    assert.deepEqual(session.snapshot(), { protocol: 'pocket-vibe', sessionId: 'native-a' });
  } finally { session.end(); }
});

test('directory query uses saved URL/token, refreshes and reports offline/auth/scan states', async () => {
  const calls = [];
  const directory = { ok: true, status: 'connected', sessions: [], agents: [{ agent_id: 'a', status: 'failed', error: 'scan denied' }] };
  const result = await fetchPocketVibeRemoteSessions({ authMode: 'apikey', apiKey: 'fixture', baseUrl: 'http://fixture/' }, true,
    { fetchImpl: async (url, init) => { calls.push({ url, init }); return response(directory); } });
  assert.equal(result.directory.agents[0].error, 'scan denied');
  assert.equal(calls[0].url, 'http://fixture/v1/remote-sessions?refresh=true');
  assert.equal(calls[0].init.headers['X-Pocket-Token'], 'fixture');
  assert.equal((await fetchPocketVibeRemoteSessions({ authMode: 'none' })).ok, false);
  for (const status of [401, 404, 500]) {
    assert.equal((await fetchPocketVibeRemoteSessions({ authMode: 'apikey', apiKey: 'x' }, false, { fetchImpl: async () => response({}, status) })).ok, false);
  }
  const offline = await fetchPocketVibeRemoteSessions({ authMode: 'apikey', apiKey: 'x' }, false, { fetchImpl: async () => { throw Error('offline'); } });
  assert.match(offline.error, /未连接/);
});

test('Orchestrator binds two targets and host replies independently, restores references and enforces duplicate/capacity gates', async () => {
  const hub = fakeHub(); const events = []; const configs = [];
  const registry = getBackendRegistry(); const original = registry.get('pocket-vibe');
  const backend = new PocketVibeBackend({ fetchImpl: hub.fetchImpl, pollIntervalMs: 1 });
  const create = backend.createSession.bind(backend);
  backend.createSession = (config, emit) => { configs.push(config); return create(config, emit); };
  registry.register(backend);
  const orch = new Orchestrator({ cwd: root, emit: (event) => events.push(event), workerEnv: { POCKET_VIBE_TOOL_TOKEN: 'fixture' } });
  let restored;
  // Recap is outside this test's scope; suppress it before cleanup to ensure
  // that even four fixture replies can never trigger a paid local model.
  const endOffline = async (o) => { if (o) { for (const hg of o.hostGroups.values()) hg.getTranscript = () => []; await o.end(); } };
  try {
    const first = orch.addHost('pocket-vibe', 'remote-a', target());
    const second = orch.addHost('pocket-vibe', 'remote-b', target('native-b', { agent_id: 'desktop-claude', provider: 'claude', cwd: '/remote/b' }));
    assert.equal(first.ok, true); assert.equal(second.ok, true);
    await waitFor(() => events.filter((e) => e.event.kind === 'session-ready').length === 2);
    orch.sendUserText('@remote-a first'); orch.sendUserText('@remote-b second'); orch.sendUserText('@remote-a followup');
    await waitFor(() => events.filter((e) => e.event.kind === 'message' && e.event.message.type === 'assistant').length === 3);
    const replies = events.filter((e) => e.event.kind === 'message' && e.event.message.type === 'assistant');
    assert.equal(replies.filter((e) => e.hostId === 'remote-a').length, 2);
    assert.equal(replies.filter((e) => e.hostId === 'remote-b').length, 1);
    for (const reply of replies) assert.match(reply.event.message.message.content[0].text, reply.hostId === 'remote-a' ? /native-a$/ : /native-b$/);
    assert.equal(configs[0].remoteTarget.session_id, 'native-a');
    assert.match(configs[0].systemPrompt, /所有项目读取、修改和验证必须在电脑端项目目录/);
    assert.equal(configs[1].remoteTarget.provider, 'claude');
    assert.match(orch.addHost('pocket-vibe', undefined, target()).error, /已加入/);
    assert.equal(orch.addHost('codex', undefined, target()).ok, false);
    assert.equal(orch.addHost('pocket-vibe', undefined, { ...target(), cwd: '' }).ok, false);
    await orch.snapshotActiveMeeting();
    const snapshot = (await MeetingRepository.listRecoverable()).find((item) => item.meetingId === orch.meetingId);
    const refs = parsePocketVibeRemoteHosts(snapshot.state.hosts);
    assert.equal(refs.length, 2); assert.equal(refs[0].remoteTarget.session_id, 'native-a');
    restored = new Orchestrator({ cwd: root, emit() {}, remoteHosts: refs, resumeBackendSessions: { 'remote-a': { protocol: 'pocket-vibe', sessionId: 'hub-turn-not-native' } },
      workerEnv: { POCKET_VIBE_TOOL_TOKEN: 'fixture' } });
    assert.deepEqual(restored.listHosts().filter((host) => host.remoteTarget).map((host) => host.remoteTarget), refs.map((ref) => ref.remoteTarget));
    // Exercise the real factory on recovery without starting the default CLI.
    await restored.hostGroups.get('remote-a').start();
    restored.sendUserText('@remote-a recovered');
    await waitFor(() => hub.posts.length === 4);
    assert.equal(hub.posts[3].session_id, 'native-a'); assert.equal(hub.posts[3].cwd, target().cwd);
    assert.match(orch.addHost('pocket-vibe', 'remote-c', target('native-c')).error, /capacity/);
  } finally { await endOffline(orch); await endOffline(restored); registry.register(original); }
});

test('existing settings and IPC preserve optional remote references and targetless call compatibility', async () => {
  await setOpenTabs([{ cwd: root, openedAt: 123, remoteHosts: [{ id: 'remote-a', remoteTarget: target() }] }], root);
  assert.equal(getSettings().openTabs[0].remoteHosts[0].remoteTarget.cwd, target().cwd);
  const stored = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'));
  assert.equal(stored.openTabs[0].remoteHosts[0].remoteTarget.session_id, 'native-a');
  const handlers = new Map(); const calls = [];
  const originalHandle = ipcMain.handle;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeHub().fetchImpl;
  await setBackendAuth('pocket-vibe', { authMode: 'apikey', apiKey: 'fixture' });
  ipcMain.handle = (name, fn) => handlers.set(name, fn);
  const fakeOrch = { enrichRemoteTargets() {}, addHost: (...args) => { calls.push(args); return { ok: true, hostId: 'remote-a' }; }, listHosts: () => [{ id: 'remote-a', remoteTarget: target() }], removeHost: () => ({ ok: true }) };
  const ctx = { getOrchestrator: (id) => id === 'meeting-a' ? fakeOrch : null, registry: { list: () => [{ id: 'meeting-a', cwd: root, openedAt: 123 }], getActive: () => ({ cwd: root }) } };
  try {
    registerSessionsIpc(ctx);
    const add = handlers.get('sessions:add-host');
    assert.equal((await add({}, { sessionId: 'meeting-a', backendId: 'pocket-vibe', remoteTarget: target() })).ok, true);
    assert.deepEqual(calls[0], ['pocket-vibe', undefined, target()]);
    assert.equal((await add({}, { sessionId: 'meeting-a', backendId: 'pocket-vibe' })).ok, true);
    assert.deepEqual(calls[1], ['pocket-vibe', undefined, undefined]);
    assert.equal((await add({}, { sessionId: 'missing', backendId: 'pocket-vibe', remoteTarget: target() })).ok, false);
  } finally { ipcMain.handle = originalHandle; globalThis.fetch = originalFetch; flushOpenTabsNow(ctx); }
  await flushSettingsWrites();
  assert.deepEqual(getSettings().openTabs[0].remoteHosts, [{ id: 'remote-a', remoteTarget: target() }]);
  await updateSettings({ openTabs: [] });
});

test('sessions:open restores snapshot target references through the production factory without sending a model turn', async () => {
  const handlers = new Map(); const events = []; const configs = []; const localTexts = [];
  const registry = getBackendRegistry(); const local = registry.get('claude-code'); const remote = registry.get('pocket-vibe');
  const originalHandle = ipcMain.handle;
  ipcMain.handle = (name, fn) => handlers.set(name, fn);
  registry.register({ id: 'claude-code', capabilities: local.capabilities, resolveBinary: () => 'fixture-local', buildEnv: (_, extra) => extra,
    checkAuthStatus: async () => ({ loggedIn: true }), createSession: () => ({ async start() {}, end() {}, sendUserText(text) { localTexts.push(text); }, sendUserContent() {}, resolvePermission() {}, async interrupt() {} }) });
  const hub = fakeHub(); const backend = new PocketVibeBackend({ fetchImpl: hub.fetchImpl, pollIntervalMs: 1 });
  backend.buildEnv = (_, extra) => ({ ...extra, POCKET_VIBE_TOOL_TOKEN: 'fixture' });
  const create = backend.createSession.bind(backend);
  backend.createSession = (config, emit) => { configs.push(config); return create(config, emit); };
  registry.register(backend);
  const slots = new SessionRegistry();
  const ctx = { registry: slots, getOrchestrator: (id) => slots.resolve(id)?.orchestrator, getAutoApprove: () => 'off', getObservedSnapshot: () => null,
    emitToRenderer: (event) => events.push(event), nativeConfirmDestructive: async () => false };
  const repository = new MeetingRepository('remote-recovery-fixture');
  await repository.snapshot({ status: 'active', cwd: root, tasks: [], hosts: [
    { id: 'default', backendId: 'claude-code' },
    { id: 'saved-host', backendId: 'pocket-vibe', remoteTarget: target(), backendSession: { protocol: 'pocket-vibe', sessionId: 'hub-turn-wrong' } },
  ] });
  try {
    registerSessionsIpc(ctx);
    const result = await handlers.get('sessions:open')({}, { cwd: root, recoveryMeetingId: repository.meetingId });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.remoteHosts, [{ id: 'saved-host', remoteTarget: target() }]);
    await waitFor(() => events.some((event) => event.hostId === 'saved-host' && event.event.kind === 'session-ready'));
    assert.equal(configs[0].remoteTarget.session_id, 'native-a');
    assert.equal(configs[0].remoteTarget.cwd, target().cwd);
    assert.equal(slots.get(result.sessionId).orchestrator.getHostSession('saved-host').snapshot().sessionId, 'native-a');
    assert.deepEqual(hub.posts, []);
    assert.deepEqual(localTexts, []);
  } finally {
    for (const slot of slots.list()) await slots.get(slot.id).orchestrator.end();
    flushOpenTabsNow(ctx); await flushSettingsWrites(); ipcMain.handle = originalHandle;
    registry.register(local); registry.register(remote);
  }
});

test('nested Claude adapter results render the native reply text', () => {
  assert.equal(extractPocketVibeResultText({ stdout: 'outer JSON', json: { json: { result: 'Claude reply', session_id: 'native-claude' } } }), 'Claude reply');
});

test('device/provider/native identity deduplicates different Agent entries and enriches legacy references without retargeting', () => {
  const a = target(); const b = target('native-a', { agent_id: 'second-entry' });
  assert.equal(remoteSessionKey(a), remoteSessionKey(b));
  assert.equal(parsePocketVibeRemoteHosts([{ id: 'a', remoteTarget: a }, { id: 'b', remoteTarget: b }]).length, 1);
  assert.notEqual(remoteSessionKey(a), remoteSessionKey(target('native-a', { device_id: 'other-device' })));
  const legacy = { ...a }; delete legacy.device_id;
  assert.equal(resolveRemoteTarget(legacy, directoryFixture()).device_id, a.device_id);
  assert.throws(() => resolveRemoteTarget({ ...a, device_id: 'wrong' }, directoryFixture()), /设备/);
  assert.throws(() => resolveRemoteTarget({ ...a, cwd: '/wrong' }, directoryFixture()), /目录/);
  const orch = new Orchestrator({ cwd: root, emit() {}, remoteHosts: [{ id: 'legacy', remoteTarget: legacy }] });
  orch.enrichRemoteTargets(directoryFixture());
  assert.match(orch.addHost('pocket-vibe', 'second', b).error, /已加入/);
  orch.end();
  assert.deepEqual(remoteMentionIds('@pocket-vibe legacy', [{ id: 'legacy-host', backendId: 'pocket-vibe' }]), []);
  assert.deepEqual(remoteMentionIds('@pocket-vibe file', [{ id: 'legacy-host', backendId: 'pocket-vibe' }], true), ['legacy-host']);
});

test('selected remote startup and sends reject offline, scan failure, invalid native session and mismatched device before POST', async () => {
  for (const edit of [
    (d) => { d.agents = []; d.sessions = []; },
    (d) => { d.agents[0].status = 'failed'; d.agents[0].error = 'scan denied'; },
    (d) => { d.sessions = []; },
    (d) => { d.sessions[0].device_id = 'wrong'; },
    (d) => { d.sessions[0].available = false; d.sessions[0].error = 'remote project missing'; },
  ]) {
    let unavailable = false; const hub = fakeHub(); const events = [];
    const session = new PocketVibeBackend({ pollIntervalMs: 1, fetchImpl: async (url, init) => {
      if (url.includes('/v1/remote-sessions') && unavailable) { const d = directoryFixture(); edit(d); return response(d); }
      return hub.fetchImpl(url, init);
    } }).createSession({ cwd: root, remoteTarget: target(), env: { POCKET_VIBE_TOOL_TOKEN: 'fixture' } }, (e) => events.push(e));
    try {
      await session.start(); unavailable = true; session.sendUserText('must not execute');
      await waitFor(() => events.some((e) => e.kind === 'error'));
      assert.deepEqual(hub.posts, []);
      await assert.rejects(session.start());
    } finally { session.end(); }
  }
});

test('connecting/failed remote mention cannot reach local input; remote attachments are rejected before disk writes while local attachments work', async () => {
  const registry = getBackendRegistry(); const original = registry.get('pocket-vibe');
  const localTexts = []; const localImages = []; const events = [];
  let rejectStart;
  registry.register({ id: 'pocket-vibe', capabilities: original.capabilities, resolveBinary: () => 'fixture', buildEnv: (_, e) => e,
    createSession: () => ({ start: () => new Promise((_, reject) => { rejectStart = reject; }), end() {}, sendUserText() {}, sendUserContent() {}, resolvePermission() {}, async interrupt() {} }) });
  const cwd = await mkdtemp(join(tmpdir(), 'remote-attachment-'));
  const orch = new Orchestrator({ cwd, emit: (e) => events.push(e) });
  const local = orch.hostGroups.get('default');
  local.sendUserText = (text) => localTexts.push(text); local.sendUserImage = (blocks) => localImages.push(blocks);
  const handlers = new Map(); const originalHandle = ipcMain.handle;
  ipcMain.handle = (name, handler) => handlers.set(name, handler);
  const slot = { id: 'fixture', cwd, orchestrator: orch };
  const ctx = { registry: { resolve: () => slot, touch() {} } };
  try {
    orch.addHost('pocket-vibe', 'remote-pending', target());
    assert.throws(() => orch.sendUserText('@remote-pending do this'), /连接/);
    assert.throws(() => orch.sendUserText('@pocket-vibe do this'), /连接/);
    assert.throws(() => orch.sendUserText('@pocket-vibe-12345678-1234-1234-1234-123456789abc do this'), /不可用/);
    assert.deepEqual(localTexts, []);
    const remoteCoordinator = new Orchestrator({ cwd, emit() {}, defaultBackendId: 'pocket-vibe' });
    assert.match(remoteCoordinator.remoteInputError('image without mention', true), /仅支持文本/);
    await remoteCoordinator.end();
    registerSessionIpc(ctx); registerAttachmentsIpc(ctx);
    const before = await readdir(cwd);
    const item = { name: 'example.txt', mime: 'text/plain', sizeBytes: 4, dataBase64: Buffer.from('test').toString('base64') };
    const rejected = await handlers.get('session:user-attachments')({}, { items: [item], caption: '@remote-pending attachment' });
    assert.match(rejected.error, /移除/);
    assert.equal((await handlers.get('session:user-image')({}, { dataUrl: 'data:image/png;base64,AAAA', caption: '@remote-pending screenshot' })).ok, false);
    assert.equal((await handlers.get('session:user-text')({}, { text: '@remote-pending text' })).ok, false);
    assert.deepEqual(await readdir(cwd), before); assert.deepEqual(localImages, []); assert.deepEqual(localTexts, []);
    rejectStart(new Error('fixture remote connection failed'));
    await waitFor(() => events.some((e) => e.event.kind === 'session-start-failed'));
    assert.throws(() => orch.sendUserText('@remote-pending after failure'), /连接/);
    assert.deepEqual(localTexts, []);
    orch.sendUserText('ordinary local message'); assert.deepEqual(localTexts, ['ordinary local message']);
    const normal = await handlers.get('session:user-attachments')({}, { items: [item], caption: 'ordinary local attachment' });
    assert.equal(normal.ok, true, normal.error); assert.equal(localImages.length, 1);
  } finally {
    rejectStart?.(new Error('cleanup')); ipcMain.handle = originalHandle;
    await orch.end(); registry.register(original); await rm(cwd, { recursive: true, force: true });
  }
});

test('targetless Orchestrator invitations still use the original portable Pocket Vibe behavior', async () => {
  const registry = getBackendRegistry(); const original = registry.get('pocket-vibe');
  const configs = []; const events = [];
  const backend = new PocketVibeBackend({ fetchImpl: fakeHub().fetchImpl, pollIntervalMs: 1 });
  const create = backend.createSession.bind(backend);
  backend.createSession = (config, emit) => { configs.push(config); return create(config, emit); };
  registry.register(backend);
  const orch = new Orchestrator({ cwd: root, emit: (e) => events.push(e), workerEnv: { POCKET_VIBE_TOOL_TOKEN: 'fixture' } });
  try {
    assert.equal(orch.addHost('pocket-vibe', 'legacy-host').ok, true);
    await waitFor(() => events.some((e) => e.event.kind === 'session-ready'));
    assert.equal(configs[0].remoteTarget, undefined);
    assert.equal(configs[0].cwd, root);
    assert.match(configs[0].systemPrompt, /meeting-command/);
    assert.equal(orch.listHosts()[1].remoteTarget, undefined);
  } finally { await orch.end(); registry.register(original); }
});

test('selected native sessions cannot dispatch local Meeting worker commands', async () => {
  const events = []; let invoked = false;
  const session = new PocketVibeBackend({ pollIntervalMs: 1, fetchImpl: async (url, init = {}) => {
    if (url.endsWith('/health') || url.endsWith('/v1/agents')) return response({ ok: true, agents: [] });
    if (url.includes('/v1/remote-sessions')) return response(directoryFixture());
    if (init.method === 'POST') return response({ ok: true, turn_id: 'turn-fixture' });
    return response({ task: { status: 'done', result: { last_message: '```meeting-command\n{"kind":"delegate-task"}\n```' } } });
  } }).createSession({ cwd: root, remoteTarget: target(), env: { POCKET_VIBE_TOOL_TOKEN: 'fixture' }, extra: { meetingCommandHandler: () => { invoked = true; } } }, (e) => events.push(e));
  try { await session.start(); session.sendUserText('fixture'); await waitFor(() => events.some((e) => e.kind === 'message' && e.message.type === 'result')); assert.equal(invoked, false); }
  finally { session.end(); }
});

test('real Bridge → Hub → Station catalogue and polling round trip (offline executors)', { skip: !process.env.POCKET_VIBE_TEST_PYTHON }, async (t) => {
  const fixture = fileURLToPath(new URL('../services/remote/tests/remote_session_fixture.py', import.meta.url));
  const child = spawn(process.env.POCKET_VIBE_TEST_PYTHON, ['-u', fixture], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let errors = ''; let url;
  child.stdout.on('data', (data) => { output += data; for (const line of output.split(/\r?\n/)) { try { const value = JSON.parse(line); if (value.ready) url = value.url; } catch {} } });
  child.stderr.on('data', (data) => { errors += data; });
  t.after(async () => {
    child.stdin.write('stop\n');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (child.exitCode === null) child.kill();
  });
  await waitFor(() => url || child.exitCode !== null);
  assert.ok(url, errors);
  const auth = { authMode: 'apikey', apiKey: 'fixture-tool-token', baseUrl: url };
  const result = await fetchPocketVibeRemoteSessions(auth, true);
  assert.equal(result.ok, true); assert.equal(result.directory.sessions.length, 3);
  const selected = result.directory.sessions.find((item) => item.session_id === 'native-session-a');
  assert.equal(selected.agent_id, 'fixture-codex'); assert.equal(selected.provider, 'codex');
  assert.ok(selected.cwd.includes('project-native-session-a')); assert.ok(selected.computer_name);
  const events = [];
  const session = new PocketVibeBackend({ pollIntervalMs: 1 }).createSession({ cwd: '/Station/local', remoteTarget: selected,
    env: { POCKET_VIBE_HUB_URL: url, POCKET_VIBE_TOOL_TOKEN: auth.apiKey } }, (event) => events.push(event));
  t.after(() => session.end());
  await session.start(); session.sendUserText('first'); session.sendUserText('second');
  await waitFor(() => events.filter((e) => e.kind === 'message' && e.message.type === 'assistant').length === 2);
  for (const event of events.filter((e) => e.kind === 'message' && e.message.type === 'assistant')) {
    const reply = JSON.parse(event.message.message.content[0].text);
    assert.equal(reply.agent_id, selected.agent_id); assert.equal(reply.provider, selected.provider);
    assert.equal(reply.session_id, selected.session_id); assert.equal(reply.cwd, selected.cwd);
    assert.equal(reply.turn_options.mode, 'resume');
  }
  session.sendUserText('fail execution');
  await waitFor(() => events.some((e) => e.kind === 'message' && JSON.stringify(e.message).includes('fixture execution failed')));
  child.stdin.write('disconnect\n'); await waitFor(() => output.includes('"disconnected": true'));
  const disconnected = await fetchPocketVibeRemoteSessions(auth, true);
  assert.equal(disconnected.directory.status, 'disconnected'); assert.deepEqual(disconnected.directory.sessions, []);
});

test('real concurrent directory refresh and two remote members keep native targets and replies', { skip: !process.env.POCKET_VIBE_TEST_PYTHON }, async (t) => {
  const fixture = fileURLToPath(new URL('../services/remote/tests/remote_session_fixture.py', import.meta.url));
  const child = spawn(process.env.POCKET_VIBE_TEST_PYTHON, ['-u', fixture, '--slow-scan'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let errors = ''; let url;
  child.stdout.on('data', (data) => { output += data; for (const line of output.split(/\r?\n/)) { try { const v = JSON.parse(line); if (v.ready) url = v.url; } catch {} } });
  child.stderr.on('data', (data) => { errors += data; });
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.stdin.write('stop\n');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (child.exitCode === null) child.kill();
  });
  await waitFor(() => url || child.exitCode !== null); assert.ok(url, errors);
  const auth = { authMode: 'apikey', apiKey: 'fixture-tool-token', baseUrl: url };
  const [first, second] = await Promise.all([fetchPocketVibeRemoteSessions(auth, true), fetchPocketVibeRemoteSessions(auth, true)]);
  for (const directory of [first, second]) {
    assert.equal(directory.ok, true); assert.equal(directory.directory.sessions.length, 3);
    assert.ok(directory.directory.agents.every((agent) => agent.status === 'ready'));
  }
  const targets = first.directory.sessions.filter((item) => item.provider === 'codex');
  const events = targets.map(() => []);
  const sessions = targets.map((remoteTarget, index) => new PocketVibeBackend({ pollIntervalMs: 1 }).createSession({
    cwd: '/Station/local', remoteTarget, env: { POCKET_VIBE_HUB_URL: url, POCKET_VIBE_TOOL_TOKEN: auth.apiKey },
  }, (event) => events[index].push(event)));
  t.after(() => sessions.forEach((session) => session.end()));
  await Promise.all(sessions.map((session) => session.start()));
  const refresh = fetchPocketVibeRemoteSessions(auth, true);
  sessions.forEach((session, index) => { session.sendUserText(`member-${index}-first`); session.sendUserText(`member-${index}-second`); });
  assert.equal((await refresh).directory.sessions.length, 3);
  await waitFor(() => events.every((list) => list.filter((e) => e.kind === 'message' && e.message.type === 'assistant').length === 2));
  events.forEach((list, index) => {
    assert.deepEqual(list.filter((e) => e.kind === 'error'), []);
    const replies = list.filter((e) => e.kind === 'message' && e.message.type === 'assistant').map((e) => JSON.parse(e.message.message.content[0].text));
    assert.deepEqual(replies.map((reply) => reply.objective), [`member-${index}-first`, `member-${index}-second`]);
    for (const reply of replies) {
      assert.equal(reply.session_id, targets[index].session_id); assert.equal(reply.cwd, targets[index].cwd);
      assert.equal(reply.agent_id, targets[index].agent_id); assert.equal(reply.provider, targets[index].provider);
    }
  });
});

test('production voice handler sends normalized remote titles to actual hosts, rejects ambiguity and never falls back while connecting/failed', async () => {
  const output = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/voice-final.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node' });
  const { handleVoiceFinal } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  const registry = getBackendRegistry(); const original = registry.get('pocket-vibe');
  const localTexts = []; const remoteTexts = []; const events = []; const notices = []; const errors = [];
  let rejectStart; let ready = true;
  registry.register({ id:'pocket-vibe', capabilities:original.capabilities, resolveBinary:()=> 'fixture', buildEnv:(_, env)=>env,
    createSession:()=> ({ start:()=> ready ? Promise.resolve() : new Promise((_, reject)=> { rejectStart = reject; }),
      end() {}, sendUserText(text) { remoteTexts.push(text); }, sendUserContent() {}, resolvePermission() {}, async interrupt() {} }) });
  const orch = new Orchestrator({ cwd:root, emit:(event)=>events.push(event) });
  orch.hostGroups.get('default').sendUserText = (text)=>localTexts.push(text);
  const host = { id:'voice-host', remoteTarget:target('voice-native', { title:'远端 项目' }) };
  const options = { skills:[], backends:[], activeBackendIds:new Set(), hosts:[host], notify:(message)=>notices.push(message),
    send:(text)=> { try { orch.sendUserText(text); } catch (error) { errors.push(error.message); } } };
  try {
    assert.equal(orch.addHost('pocket-vibe', host.id, host.remoteTarget).ok, true);
    await waitFor(()=>events.some((event)=>event.hostId===host.id && event.event.kind==='session-ready'));
    for (const [title, spoken] of [['远端 项目','远端 项目 帮我修改README'], ['远端 项目','远端项目 帮我修改README'],
      ['远端 项目','远端项目 修改联系邮箱 demo@example.com'], ['远端 项目','远端项目 保存 demo@voice-host'],
      ['Remote-Project','remote project do this'], ['Remote_Project','REMOTE-PROJECT do this'], ['Remote Project','remote_project do this']]) {
      options.hosts = [{ ...host, remoteTarget:{ ...host.remoteTarget, title } }];
      const before = remoteTexts.length;
      await handleVoiceFinal(spoken, options);
      assert.equal(remoteTexts.length, before+1); assert.ok(remoteTexts.at(-1).includes(spoken));
      assert.deepEqual(localTexts, []);
    }
    for (const [a,b,spoken] of [['远端 项目','远端 项目','远端项目 操作'], ['Remote-Project','remote_project','REMOTE PROJECT 操作'],
      ['会话甲','会话乙','会话甲 和会话乙 都修改']]) {
      options.hosts = [{ ...host, remoteTarget:{ ...host.remoteTarget, title:a } },
        { id:'another-host', remoteTarget:{ ...host.remoteTarget, title:b } }];
      const before = remoteTexts.length;
      await handleVoiceFinal(spoken, options);
      assert.equal(remoteTexts.length, before); assert.match(notices.at(-1), /文本选择具体成员/); assert.deepEqual(localTexts, []);
    }
    options.hosts = [host];
    options.backends = [{ id:'codex', displayName:'远端 项目' }]; options.activeBackendIds = new Set(['codex']);
    const beforeCollision = remoteTexts.length;
    await handleVoiceFinal('远端项目 请分析', options);
    assert.equal(remoteTexts.length, beforeCollision); assert.deepEqual(localTexts, []);
    assert.match(notices.at(-1), /文本选择具体成员/);
    options.backends = []; options.activeBackendIds = new Set();
    await handleVoiceFinal('@voice-host 显式点名', options); assert.ok(remoteTexts.at(-1).includes('显式点名'));
    await handleVoiceFinal('普通语音，分析目前代码', options); assert.deepEqual(localTexts, ['普通语音，分析目前代码']); localTexts.length=0;
    options.skills=[{name:'maintenance'}];
    await handleVoiceFinal('maintenance contact demo@example.com', options);
    assert.deepEqual(localTexts,['maintenance contact demo@example.com']); localTexts.length=0; options.skills=[];
    ready = false;
    const pending = { id:'voice-pending', remoteTarget:target('voice-pending-native', { title:'等待 项目' }) };
    assert.equal(orch.addHost('pocket-vibe', pending.id, pending.remoteTarget).ok, true);
    options.hosts = [pending];
    await handleVoiceFinal('等待项目 修改README', options); assert.match(errors.at(-1), /连接/); assert.deepEqual(localTexts, []);
    rejectStart(new Error('Hub offline'));
    await waitFor(()=>events.some((event)=>event.hostId===pending.id && event.event.kind==='session-start-failed'));
    await handleVoiceFinal('等待项目 继续修改README', options); assert.match(errors.at(-1), /连接/); assert.deepEqual(localTexts, []);
  } finally {
    rejectStart?.(new Error('cleanup')); await orch.end(); registry.register(original);
  }
});
