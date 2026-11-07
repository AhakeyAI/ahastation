import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dialog, ipcMain } from 'electron';
import { registerScanIpc } from '../dist-electron/observe/scan-ipc.js';
import { ScanAccessStore } from '../dist-electron/observe/scan-access.js';

async function setup(t) {
  const tmp = await fs.mkdtemp(join(tmpdir(), 'aha-s2-ipc-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const root = await fs.realpath(tmp);
  const handlers = new Map();
  const originals = { handle: ipcMain.handle, message: dialog.showMessageBox, open: dialog.showOpenDialog };
  t.after(() => { ipcMain.handle = originals.handle; dialog.showMessageBox = originals.message; dialog.showOpenDialog = originals.open; });
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  let prompts = 0, invalidations = 0;
  dialog.showMessageBox = async () => { prompts++; return { response: 1 }; };
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  const access = new ScanAccessStore(join(root, 'consent.json'));
  const controls = registerScanIpc({ window: () => ({ webContents: { id: 11 } }), access,
    service: { invalidate: () => { invalidations++; }, tickOnce: async () => {} },
    snapshot: () => ({ sessions: [], scannedAt: 1, access: access.get() }) });
  return { root, access, controls, prompts: () => prompts, invalidations: () => invalidations,
    invoke: (action, raw, senderId = 11) => handlers.get(`observe:${action}`)({ sender: { id: senderId } }, raw) };
}

test('scan IPC rejects other windows and renderer-supplied directories before showing a dialog', async (t) => {
  const f = await setup(t);
  assert.equal((await f.invoke('getSnapshot', undefined, 99)).ok, false);
  assert.equal((await f.invoke('allowDirectory', undefined, 99)).ok, false);
  assert.equal((await f.invoke('allowDirectory', { cwd: f.root })).ok, false);
  assert.equal(f.prompts(), 0); assert.equal(f.access.get().enabled, false);
});
test('canceling consent or directory selection makes no grant; native selection persists and revokes', async (t) => {
  const f = await setup(t);
  dialog.showMessageBox = async () => ({ response: 0 });
  assert.equal((await f.invoke('allowDirectory')).canceled, true);
  dialog.showMessageBox = async () => ({ response: 1 });
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  assert.equal((await f.invoke('allowDirectory')).canceled, true);
  assert.equal(f.access.get().enabled, false);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f.root] });
  assert.equal((await f.invoke('allowDirectory')).ok, true);
  assert.deepEqual(f.access.get(), { enabled: true, roots: [f.root] });
  assert.equal((await f.invoke('disable')).ok, true);
  assert.deepEqual(f.access.get(), { enabled: false, roots: [] });
  assert.equal(f.invalidations(), 2);
});
test('revocation while a picker is open cancels the grant and duplicate dialogs are refused', async (t) => {
  const f = await setup(t);
  let entered, release;
  const pickerOpened = new Promise((resolve) => { entered = resolve; });
  const picked = new Promise((resolve) => { release = resolve; });
  dialog.showOpenDialog = async () => { entered(); return picked; };
  const choosing = f.invoke('allowDirectory'); await pickerOpened;
  assert.equal((await f.invoke('allowDirectory')).ok, false);
  await f.invoke('disable');
  release({ canceled: false, filePaths: [f.root] });
  assert.equal((await choosing).canceled, true);
  assert.deepEqual(f.access.get(), { enabled: false, roots: [] });
});

test('first app launch offers consent once; cancel leaves scanning disabled across restart', async (t) => {
  const f = await setup(t);
  let offers = 0;
  dialog.showMessageBox = async () => { offers++; return { response: 0 }; };
  await f.controls.promptFirstRun(); await f.controls.promptFirstRun();
  assert.equal(offers, 1); assert.equal(f.access.get().enabled, false);
  const reloaded = new ScanAccessStore(join(f.root, 'consent.json')); await reloaded.load();
  assert.equal(reloaded.needsPrompt, false); assert.equal(reloaded.get().enabled, false);
});
