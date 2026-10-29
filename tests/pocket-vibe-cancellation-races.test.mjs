import assert from 'node:assert/strict';
import test from 'node:test';
import { PocketVibeBackend } from '../dist-electron/backends/pocket-vibe-adapter.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const previewRoot=await mkdtemp(join(tmpdir(),'pocket-cancellation-preview-'));
const previewKeys=['AHASTATION_ENABLE_COLLABORATION','AHASTATION_REMOTE_ALLOW_LOOPBACK','AHASTATION_USER_DATA_DIR'];
const previousPreview=Object.fromEntries(previewKeys.map(key=>[key,process.env[key]]));
process.env.AHASTATION_ENABLE_COLLABORATION='1';
process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK='1';
process.env.AHASTATION_USER_DATA_DIR=previewRoot;
test.after(async()=>{for(const key of previewKeys)if(previousPreview[key]===undefined)delete process.env[key];else process.env[key]=previousPreview[key];await rm(previewRoot,{recursive:true,force:true});});

const reply = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async (predicate) => {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise(done => setTimeout(done, 2)); }
  assert.fail('Timed out waiting for the production turn pipeline');
};
const target = { agent_id: 'device-codex', device_id: 'device', provider: 'codex', session_id: 'native-session',
  cwd: 'C:\\remote\\project', title: 'Remote', service_url: 'http://127.0.0.1:43155', owner_id: 'owner' };
const config = { cwd: 'C:\\station\\local', remoteTarget: target,
  env: { POCKET_VIBE_AUTH_MODE: 'public', POCKET_VIBE_HUB_URL: target.service_url, POCKET_VIBE_OWNER_ID: 'owner', POCKET_VIBE_TOOL_TOKEN: 'fixture-control' } };
const identity = JSON.stringify([target.service_url, target.owner_id, target.device_id, target.provider, target.session_id]);

test('shared Desktop session sends its exact target and displays waiting/running through the production adapter', async () => {
  const linked = { ...target, title: 'Project · Codex 桌面联动' };
  const events = [], posts = [], pending = new Map(); let polls = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/health')) return reply({ ok: true, protocol: 2 });
    if (url.includes('/v1/remote-sessions')) return reply({ ok: true, status: 'connected', sessions: [linked],
      agents: [{ agent_id: linked.agent_id, device_id: linked.device_id, provider: 'codex', status: 'ready' }] });
    if (url.endsWith('/v1/turns') && init.method === 'POST') {
      posts.push(JSON.parse(init.body)); return reply({ ok: true, turn_id: 'native-hub-task' });
    }
    if (url.includes('/v1/turns/native-hub-task')) {
      return reply({ ok: true, task: polls++ === 0 ? { status: 'waiting' } : polls === 2 ? { status: 'running' } :
        { status: 'done', result: { ok: true, cleanup_confirmed: true, json: { last_message: 'same native context' } } } });
    }
    if (url.endsWith('/v1/agents')) return reply({ agents: [] });
    throw new Error(`Unexpected ${url}`);
  };
  const backend = new PocketVibeBackend({ fetchImpl, pollIntervalMs: 1, turnTimeoutMs: 2000,
    pendingStore: { get: key => pending.get(key), set: async (key, value) => value ? pending.set(key, value) : pending.delete(key) } });
  const session = backend.createSession({ ...config, remoteTarget: linked }, event => events.push(event));
  try {
    await session.start(); session.sendUserText('continue');
    await until(() => events.some(e => e.kind === 'message' && e.message.type === 'result'));
    const output = JSON.stringify(events);
    assert.match(output, /等待同一会话当前任务结束后执行/);
    assert.match(output, /Station 执行中（桌面共享会话）/);
    assert.match(output, /same native context/);
    assert.equal(posts[0].session_id, linked.session_id); assert.equal(posts[0].cwd, linked.cwd);
    assert.equal(posts[0].target_agent_id, linked.agent_id); assert.equal(posts[0].provider, linked.provider);
    assert.equal(pending.size, 0);
  } finally { session.end(); }
});

for (const [reason, restored] of [['user', false], ['steer', false], ['user', true]]) {
  test(`late ${reason} cancellation cannot clear or abort a newer turn${restored ? ' after recovery' : ''}; repeated cancellation is shared`, async () => {
    const release = deferred(), readStarted = deferred();
    const pending = new Map(restored ? [[identity, 'restored-old']] : []);
    const submissions = [], tasks = new Map(), signals = [], cancelCalls = [], events = [];
    let oldKey = restored ? 'restored-old' : null, oldDone = false, delayOldCancel = false, newDone = false;
    if (restored) tasks.set(oldKey, { id: 'turn-old', status: 'running' });
    const result = (row) => ({ status: row.status, result: { ok: row.status === 'done', cancelled: row.status === 'cancelled',
      cleanup_confirmed: ['done', 'cancelled'].includes(row.status), json: { last_message: row.id } } });
    const fetchImpl = async (url, init = {}) => {
      if (url.endsWith('/health')) return reply({ ok: true, protocol: 2 });
      if (url.endsWith('/v1/agents')) return reply({ agents: [] });
      if (url.includes('/v1/remote-sessions')) return reply({ ok: true, status: 'connected', sessions: [target],
        agents: [{ agent_id: target.agent_id, device_id: target.device_id, provider: 'codex', status: 'ready' }] });
      if (url.endsWith('/v1/turns')) {
        const body = JSON.parse(init.body); submissions.push(body);
        oldKey ??= body.idempotency_key;
        const id = body.idempotency_key === oldKey ? 'turn-old' : `turn-new-${submissions.length}`;
        tasks.set(body.idempotency_key, { id, status: 'running' });
        return reply({ ok: true, turn_id: id });
      }
      if (url.includes('/v2/submissions/')) {
        const key = url.split('/v2/submissions/')[1].split('/')[0];
        const row = tasks.get(key); assert.ok(row, `Unknown submission ${key}`);
        if (url.endsWith('/cancel')) {
          cancelCalls.push(key);
          if (key === oldKey) delayOldCancel = true;
          else row.status = 'cancelled';
          return reply({ ok: true });
        }
        if (key === oldKey && delayOldCancel) { readStarted.resolve(); await release.promise; }
        return reply({ ok: true, turn_id: row.id, task: result(row) });
      }
      const id = url.split('/v1/turns/')[1], row = [...tasks.values()].find(row => row.id === id);
      assert.ok(row, `Unknown turn ${url}`); signals.push({ id, signal: init.signal });
      if (id === 'turn-old' && oldDone) row.status = 'done';
      if (id !== 'turn-old' && newDone && row.status === 'running') row.status = 'done';
      return reply({ ok: true, task: result(row) });
    };
    const pendingStore = { get: key => pending.get(key), set: (key, value, expected) => {
      if (expected !== undefined && pending.get(key) !== expected) return;
      if (value) pending.set(key, value); else pending.delete(key);
    } };
    const session = new PocketVibeBackend({ fetchImpl, pendingStore, pollIntervalMs: 1,
      liveAuth: () => ({ enabled: true, mode: 'public', serviceUrl: target.service_url, ownerId: 'owner', controlToken: 'fixture-control' }) })
      .createSession(config, event => events.push(event));
    let cancellation, duplicate;
    try {
      await session.start();
      if (!restored) session.sendUserText('old');
      await until(() => signals.some(row => row.id === 'turn-old'));
      cancellation = session.interrupt(reason); duplicate = session.interrupt(reason);
      await readStarted.promise;
      if (reason === 'steer') session.sendUserText('queued steer');
      oldDone = true;
      await until(() => events.some(event => event.kind === 'message' && event.message.type === 'result'));
      if (reason !== 'steer') session.sendUserText('new');
      await until(() => signals.some(row => row.id !== 'turn-old'));
      const newKey = submissions.at(-1).idempotency_key;
      assert.notEqual(newKey, oldKey); assert.equal(pending.get(identity), newKey);
      const currentSignals = signals.filter(row => row.id !== 'turn-old');
      release.resolve(); await Promise.all([cancellation, duplicate]);
      assert.equal(cancelCalls.filter(key => key === oldKey).length, 1);
      assert.equal(pending.get(identity), newKey, 'Old cancel must not erase the new recovery reference');
      assert.ok(currentSignals.every(row => !row.signal.aborted), 'Old cancel must not abort the new polling controller');
      newDone = true;
      await until(() => events.filter(event => event.kind === 'message' && event.message.type === 'result').length === 2);
      assert.equal(pending.size, 0);
      newDone = false; session.sendUserText('next stoppable task');
      await until(() => pending.has(identity));
      const nextKey = pending.get(identity);
      await until(() => tasks.has(nextKey));
      await session.interrupt('user');
      assert.equal(cancelCalls.at(-1), nextKey, 'New active submission must remain stoppable');
      assert.equal(pending.size, 0);
    } finally {
      release.resolve(); session.end();
      await Promise.allSettled([cancellation, duplicate].filter(Boolean));
    }
  });
}
