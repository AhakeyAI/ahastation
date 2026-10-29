import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { StationService } from '../dist-electron/collaboration/station-service.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function localService(root) {
  const service = new StationService(root);
  await service.storage.load();
  service.localReady = true;
  await service.storage.update(() => {});
  return service;
}

test('Station shutdown waits for a real atomic profile write and cannot recreate a deleted profile', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'station-shutdown-write-'));
  const service = await localService(root);
  const entered = deferred(), release = deferred();
  const originalRename = fs.rename;
  let write, shutdown;
  try {
    fs.rename = async (source, destination) => {
      if (destination === service.storage.file) {
        entered.resolve();
        await release.promise;
      }
      return originalRename(source, destination);
    };
    syncBuiltinESMExports();
    write = service.storage.update(state => { state.error = 'durable final observation'; });
    await entered.promise;
    assert.equal(JSON.parse(await fs.readFile(service.storage.file + '.next', 'utf8')).error, 'durable final observation');
    let finished = false;
    shutdown = service.shutdown().then(result => { finished = true; return result; });
    await delay(30);
    assert.equal(finished, false);
    await assert.rejects(service.action('connect'), /正在退出/);
    release.resolve();
    await write;
    assert.equal(await shutdown, true);
    assert.equal(JSON.parse(await fs.readFile(service.storage.file, 'utf8')).error, 'durable final observation');
    await fs.rm(root, { recursive: true, force: true });
    for (const action of ['probe', 'configure', 'command']) {
      await assert.rejects(service.action(action, {}), /正在退出/);
    }
    assert.equal((await service.action('status')).connected, false);
    await delay(30);
    await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  } finally {
    release.resolve();
    fs.rename = originalRename;
    syncBuiltinESMExports();
    await write;
    await shutdown;
    await service.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Station shutdown drains an initialization already paused in a probe and does not restart producers', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'station-shutdown-init-'));
  const service = new StationService(root);
  const entered = deferred(), release = deferred();
  let connections = 0;
  service.probe = async () => {
    entered.resolve();
    await release.promise;
    await service.storage.update(state => { state.error = 'probe completed'; });
  };
  service.openConnection = async () => { connections++; };
  const initialization = service.initialize();
  let shutdown;
  try {
    await entered.promise;
    let finished = false;
    shutdown = service.shutdown().then(result => { finished = true; return result; });
    await delay(30);
    assert.equal(finished, false);
    release.resolve();
    await initialization;
    assert.equal(await shutdown, true);
    assert.equal(connections, 0);
    assert.equal(service.nativeTimer, undefined);
    assert.equal(service.recoveryTimer, undefined);
    assert.equal(JSON.parse(await fs.readFile(service.storage.file, 'utf8')).error, 'probe completed');
  } finally {
    release.resolve();
    await initialization;
    await shutdown;
    await service.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('unconfirmed execution keeps its evidence and recovery timers after a refused shutdown', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'station-shutdown-unconfirmed-'));
  const service = await localService(root);
  const receipt = { taskId: 'owned-task', attemptId: 'owned-attempt', status: 'reconcile',
    bindingRevision: 1, output: ['retained evidence'], executionInvoked: true, exitConfirmed: false };
  try {
    await service.storage.update(state => { state.receipts[receipt.taskId] = receipt; });
    assert.equal(await service.shutdown(), false);
    assert.deepEqual(service.storage.read().receipts[receipt.taskId], receipt);
    assert.equal(service.closing, false);
    assert.ok(service.recoveryTimer);
    assert.ok(service.nativeTimer);
  } finally {
    await service.storage.update(state => { state.receipts[receipt.taskId].exitConfirmed = true; });
    assert.equal(await service.shutdown(), true);
    await fs.rm(root, { recursive: true, force: true });
  }
});
