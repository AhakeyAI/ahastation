import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { HostGroup } from '../dist-electron/host-group.js';

const root = await mkdtemp(join(tmpdir(), 'station-host-lifecycle-'));
const originalPath = app.getPath;
app.getPath = () => root;
test.after(async () => {
  app.getPath = originalPath;
  await rm(root, { recursive: true, force: true });
});

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture(start) {
  let emit;
  const group = new HostGroup({
    id: 'default', backendId: 'codex', emit() {}, cwd: root,
    projectId: 'lifecycle-fixture', meetingId: 'lifecycle-fixture',
    autoApproveScope: 'none', bridge: {}, deliveryHarness: {},
    isClosed: () => false, getSpeechFilterMode: () => 'strict',
    isCoordinator: () => true,
    async getAuthorizedTaskContextSource() { throw new Error('no worker task expected'); },
    async persistContextPackage() {},
    sessionFactory: options => {
      emit = options.emit;
      return {
        start, end() {}, sendUserText() {}, sendUserContent() {},
        resolvePermission() {}, async interrupt() {},
      };
    },
  });
  return { group, event: event => emit(event) };
}

test('host lifecycle distinguishes initialization without a backend, pending handshake, ready and runtime exit', async () => {
  const waiting = deferred();
  const f = fixture(() => waiting.promise);
  try {
    assert.equal(f.group.getHost(), null);
    assert.deepEqual(f.group.getLifecycle(), { phase: 'starting' });
    const starting = f.group.start();
    assert.equal(f.group.getHost(), null, 'memory initialization awaits before backend construction');
    assert.equal(f.group.getLifecycle().phase, 'starting');
    // Allow initialization to reach the deferred handshake without completing it.
    const deadline = Date.now() + 2000;
    while (!f.group.getHost() && Date.now() < deadline) await new Promise(done => setTimeout(done, 5));
    assert.ok(f.group.getHost(), 'backend factory was not reached');
    assert.equal(f.group.isReady(), false);
    assert.equal(f.group.getLifecycle().phase, 'starting');
    waiting.resolve(); await starting;
    assert.equal(f.group.isReady(), true);
    assert.deepEqual(f.group.getLifecycle(), { phase: 'ready' });
    f.event({ kind: 'ended' });
    assert.equal(f.group.isReady(), false);
    assert.deepEqual(f.group.getLifecycle(), { phase: 'ended' });
  } finally { waiting.resolve(); f.group.end(); }
});

test('host lifecycle retains handshake and authentication errors, including a later intentional end notification', async () => {
  const failed = fixture(async () => { throw new Error('handshake failed'); });
  try {
    await assert.rejects(failed.group.start(), /handshake failed/);
    assert.equal(failed.group.isReady(), false);
    assert.deepEqual(failed.group.getLifecycle(), { phase: 'failed', error: 'handshake failed' });
  } finally { failed.group.end(); }
  const auth = fixture(async () => {});
  try {
    await auth.group.start();
    auth.event({ kind: 'auth-required', error: 'login expired' });
    auth.event({ kind: 'ended' });
    assert.equal(auth.group.isReady(), false);
    assert.deepEqual(auth.group.getLifecycle(), { phase: 'failed', error: 'login expired' });
  } finally { auth.group.end(); }
});
