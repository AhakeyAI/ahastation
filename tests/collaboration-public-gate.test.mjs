import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { app } from 'electron';
import { isCollaborationPreviewEnabled, requirePublicHubUrl } from '../dist-electron/collaboration/feature-gate.js';
import { PocketVibeBackend, fetchPocketVibeRemoteSessions } from '../dist-electron/backends/pocket-vibe-adapter.js';
import { getPocketVibeConnection, remoteControlAction, remoteRequest } from '../dist-electron/remote-control.js';
import { getSettings, updateRemoteControlFields, flushSettingsWrites, setBackendAuth } from '../dist-electron/store.js';

const root = await mkdtemp(join(tmpdir(), 'collaboration-public-gate-'));
const previous = { getPath: app.getPath, isPackaged: app.isPackaged };
const keys = ['AHASTATION_ENABLE_COLLABORATION', 'AHASTATION_REMOTE_ALLOW_LOOPBACK', 'AHASTATION_USER_DATA_DIR'];
const environment = Object.fromEntries(keys.map(key => [key, process.env[key]]));
app.getPath = () => root;
test.after(async () => {
  await flushSettingsWrites();
  Object.assign(app, previous);
  for (const key of keys) if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key];
  await rm(root, { recursive: true, force: true });
});

function preview() {
  app.isPackaged = false;
  process.env.AHASTATION_ENABLE_COLLABORATION = '1';
  process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK = '1';
  process.env.AHASTATION_USER_DATA_DIR = root;
}

const target = { device_id: 'owned-device', agent_id: 'codex', provider: 'codex', session_id: 'owned-session',
  cwd: root, service_url: 'http://127.0.0.1:43155', owner_id: 'owned-account' };
const publicSession = fetchImpl => new PocketVibeBackend({ fetchImpl }).createSession({ cwd: root, remoteTarget: target,
  env: { POCKET_VIBE_AUTH_MODE: 'public', POCKET_VIBE_HUB_URL: target.service_url,
    POCKET_VIBE_TOOL_TOKEN: 'retained-token', POCKET_VIBE_OWNER_ID: target.owner_id } }, () => {});

test('every preview requirement is mandatory and packaged applications remain closed', () => {
  preview();
  assert.equal(isCollaborationPreviewEnabled(), true);
  for (const key of keys) {
    const value = process.env[key];
    delete process.env[key];
    assert.equal(isCollaborationPreviewEnabled(), false, key);
    process.env[key] = value;
  }
  app.isPackaged = true;
  assert.equal(isCollaborationPreviewEnabled(), false);
});

test('saved public credentials cannot reach identity, directory or session transports while closed', async () => {
  await updateRemoteControlFields(() => ({ enabled: true, mode: 'public', serviceUrl: target.service_url,
    ownerId: target.owner_id, controlToken: 'retained-token', pendingSubmissions: { original: 'keep' } }));
  let requests = 0;
  const fetchImpl = async () => { requests++; throw new Error('transport must stay unreachable'); };
  for (const packaged of [false, true]) {
    preview();
    app.isPackaged = packaged;
    if (!packaged) delete process.env.AHASTATION_ENABLE_COLLABORATION;
    assert.equal(getPocketVibeConnection().apiKey, undefined);
    const status = await remoteControlAction('status');
    assert.equal(status.ok, true);
    await assert.rejects(remoteRequest('/v2/me', 'GET', undefined, true, fetchImpl), /暂未开放/);
    for (const [action, payload] of [
      ['connection', {}], ['devices', {}], ['pair', {}], ['tasks', {}],
      ['cancel', { taskId: 'original' }], ['unpair', { deviceId: target.device_id }],
      ['login', { login: 'fixture', password: 'fixture-password-123' }],
      ['register', { login: 'fixture', password: 'fixture-password-123' }],
      ['recover', { login: 'fixture', password: 'fixture-password-123', recoveryCode: 'fixture-recovery' }],
    ]) {
      const reply = await remoteControlAction(action, payload, { fetchImpl });
      assert.equal(reply.ok, false, action);
      assert.match(reply.error, /暂未开放/, action);
    }
    const directory = await fetchPocketVibeRemoteSessions({ authMode: 'apikey', apiKey: 'retained-token',
      publicMode: true, baseUrl: target.service_url }, true, { fetchImpl });
    assert.equal(directory.ok, false);
    assert.match(directory.error, /暂未开放/);
    const session = publicSession(fetchImpl);
    try { await assert.rejects(session.start(), /暂未开放/); } finally { session.end(); }
    assert.equal(requests, 0);
    assert.equal(getSettings().remoteControl.controlToken, 'retained-token');
  }
});

test('preview guards reject public destinations even when a fake transport is injected', async () => {
  preview();
  let requests = 0;
  const fetchImpl = async () => { requests++; throw new Error('transport must stay unreachable'); };
  await updateRemoteControlFields(current => ({ ...current, serviceUrl: 'https://example.invalid' }));
  await assert.rejects(remoteRequest('/v2/me', 'GET', undefined, true, fetchImpl), /仅允许本机/);
  const directory = await fetchPocketVibeRemoteSessions({ authMode: 'apikey', apiKey: 'retained-token',
    publicMode: true, baseUrl: 'https://example.invalid' }, false, { fetchImpl });
  assert.equal(directory.ok, false);
  assert.match(directory.error, /仅允许本机/);
  for (const value of ['https://example.invalid', 'http://192.0.2.1', 'file:///tmp/fixture']) {
    assert.throws(() => requirePublicHubUrl(value), /仅允许本机/);
  }
  assert.equal(requests, 0);
});

test('closed public entry permits local sign-out without claiming server-wide revocation', async () => {
  delete process.env.AHASTATION_ENABLE_COLLABORATION;
  let requests = 0;
  const fetchImpl = async () => { requests++; };
  const all = await remoteControlAction('logout', { all: true }, { fetchImpl });
  assert.equal(all.ok, false);
  assert.equal(getSettings().remoteControl.controlToken, 'retained-token');
  const local = await remoteControlAction('logout', {}, { fetchImpl });
  assert.equal(local.ok, true);
  assert.equal(getSettings().remoteControl.controlToken, undefined);
  assert.deepEqual(getSettings().remoteControl.pendingSubmissions, { original: 'keep' });
  assert.equal(requests, 0);
});

test('original LAN configuration and directory requests remain available with the public entry closed', async () => {
  delete process.env.AHASTATION_ENABLE_COLLABORATION;
  await setBackendAuth('pocket-vibe', { authMode: 'apikey', apiKey: 'lan-only-token', baseUrl: 'http://lan.invalid' });
  await updateRemoteControlFields(() => ({ enabled: false, mode: 'legacy', serviceUrl: '' }));
  assert.equal(getPocketVibeConnection().apiKey, 'lan-only-token');
  const calls = [];
  const directory = await fetchPocketVibeRemoteSessions(getPocketVibeConnection(), false, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ ok: true, status: 'connected', agents: [], sessions: [] }) };
    },
  });
  assert.equal(directory.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['X-Pocket-Token'], 'lan-only-token');
});
