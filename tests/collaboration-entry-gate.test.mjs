import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {app, ipcMain} from 'electron';
import {StationService, initializeStationCollaboration, stationService} from '../dist-electron/collaboration/station-service.js';
import {collaborationFetch, websocketProxy} from '../dist-electron/collaboration/network.js';

test('closed collaboration entry cannot initialize, resume, probe, connect or perform IPC mutations', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'collaboration-closed-'));
  const original = {getPath: app.getPath, isPackaged: app.isPackaged, handle: ipcMain.handle, initialize: StationService.prototype.initialize};
  const keys = ['AHASTATION_ENABLE_COLLABORATION', 'AHASTATION_REMOTE_ALLOW_LOOPBACK', 'AHASTATION_USER_DATA_DIR'];
  const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let initialized = 0;
  let handler;
  try {
    app.getPath = () => folder;
    ipcMain.handle = (name, fn) => { assert.equal(name, 'collaboration:request'); handler = fn; };
    StationService.prototype.initialize = async () => { initialized++; };
    const state = join(folder, 'collaboration', 'station-v2.json');
    await mkdir(join(folder, 'collaboration'));
    const previous = JSON.stringify({version: 2, tokenEnc: 'retained', receipts: {old: {status: 'reconcile'}}});
    await writeFile(state, previous);
    const event = {senderFrame: {url: pathToFileURL(join(process.cwd(), 'index.html')).href}};
    for (const packaged of [false, true]) {
      app.isPackaged = packaged;
      delete process.env.AHASTATION_ENABLE_COLLABORATION;
      await initializeStationCollaboration();
      assert.equal(stationService(), undefined);
      const reply = await handler(event, 'status');
      assert.equal(reply.ok, true);
      assert.equal(reply.value.enabled, false);
      assert.equal(reply.value.connected, false);
      for (const action of ['connect', 'probe', 'configure', 'command', 'native.launch', 'delivery.select']) {
        const rejected = await handler(event, action, {});
        assert.equal(rejected.ok, false, action);
        assert.match(rejected.error, /暂未开放/);
      }
    }
    process.env.AHASTATION_ENABLE_COLLABORATION = '1';
    process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK = '1';
    process.env.AHASTATION_USER_DATA_DIR = folder;
    await initializeStationCollaboration(); // packaged applications stay closed, even with flags.
    assert.equal(initialized, 0);
    assert.equal(stationService(), undefined);
    assert.equal(await readFile(state, 'utf8'), previous);
  } finally {
    Object.assign(app, {getPath: original.getPath, isPackaged: original.isPackaged});
    ipcMain.handle = original.handle;
    StationService.prototype.initialize = original.initialize;
    for (const key of keys) if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    await rm(folder, {recursive: true});
  }
});

test('isolated preview rejects public HTTP and WebSocket addresses before transport', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'collaboration-preview-network-'));
  const keys = ['AHASTATION_ENABLE_COLLABORATION', 'AHASTATION_REMOTE_ALLOW_LOOPBACK', 'AHASTATION_USER_DATA_DIR'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const packaged = app.isPackaged;
  app.isPackaged = false;
  process.env.AHASTATION_ENABLE_COLLABORATION = '1';
  process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK = '1';
  process.env.AHASTATION_USER_DATA_DIR = folder;
  try {
    await assert.rejects(collaborationFetch('https://example.invalid/api/collaboration/v2/snapshot'), /仅允许本机/);
    assert.throws(() => websocketProxy('wss://example.invalid/ws/station'), /仅允许本机/);
    assert.equal(websocketProxy('ws://127.0.0.1:1/ws/station'), undefined);
  } finally {
    app.isPackaged = packaged;
    for (const key of keys) if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
    await rm(folder, {recursive: true, force: true});
  }
});
