import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dialog, ipcMain } from 'electron';
import { registerScanIpc } from '../dist-electron/observe/scan-ipc.js';
import { ScanAccessStore } from '../dist-electron/observe/scan-access.js';
import { ScanPreferences } from '../dist-electron/observe/scan-preferences.js';
import { createHash } from 'node:crypto';

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
  const preferences = new ScanPreferences(join(root, 'scan-preferences.json')); await preferences.load();
  let extraSnapshot = {};
  const ownershipPath = join(root, 'owned.json');
  const controls = registerScanIpc({ window: () => ({ webContents: { id: 11 } }), access,
    service: { invalidate: () => { invalidations++; }, tickOnce: async () => {} },
    preferences, ownershipPath,
    snapshot: () => ({ sessions: [], scannedAt: 1, access: access.get(), ...extraSnapshot }) });
  return { root, access, controls, preferences, ownershipPath, setSnapshot: (value) => { extraSnapshot = value; },
    prompts: () => prompts, invalidations: () => invalidations,
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

async function pending(f) {
  const allowed = join(f.root, 'allowed'), path = join(f.root, 'pending');
  await fs.mkdir(allowed); await fs.mkdir(path);
  await f.access.set({ enabled: true, roots: [allowed] });
  const row = { key: createHash('sha256').update(path).digest('hex'), path, label: 'pending', sessionCount: 1 };
  f.setSnapshot({ pendingDirectories: [row] });
  return row;
}
test('candidate authorization accepts only a current main-owned key and native confirmation, never renderer paths or grant permissions', async (t) => {
  const f = await setup(t), row = await pending(f);
  assert.equal((await f.invoke('reviewDirectory', { key: row.key }, 99)).ok, false);
  assert.equal((await f.invoke('reviewDirectory', { key: row.key, path: f.root, permission: 'full-access' })).ok, false);
  assert.equal((await f.invoke('reviewDirectory', { key: 'f'.repeat(64) })).ok, false);
  assert.equal(f.prompts(), 0);
  let confirmation;
  dialog.showMessageBox = async (_window, options) => { confirmation = options; return { response: 0 }; };
  assert.equal((await f.invoke('reviewDirectory', { key: row.key })).canceled, true);
  assert.equal(f.access.get().roots.includes(row.path), false);
  dialog.showMessageBox = async (_window, options) => { confirmation = options; return { response: 1 }; };
  assert.equal((await f.invoke('reviewDirectory', { key: row.key })).ok, true);
  assert.match(confirmation.detail, /只读扫描|只读/); assert.match(confirmation.detail, /不会授予 Agent 执行/);
  assert.equal(confirmation.defaultId, 0); assert.equal(confirmation.cancelId, 0);
  assert.ok(f.access.get().roots.includes(row.path)); assert.equal(f.access.get().roots.includes(f.root), false);
  const saved = JSON.parse(await fs.readFile(join(f.root, 'consent.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['enabled', 'roots', 'schemaVersion']);
});
test('revoke/regrant, a changed directory inode or a dismissed candidate invalidates an open consent dialog', async (t) => {
  const f = await setup(t), row = await pending(f);
  let entered, release;
  const opened = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  dialog.showMessageBox = async () => { entered(); return gate; };
  const review = f.invoke('reviewDirectory', { key: row.key }); await opened;
  assert.equal((await f.invoke('reviewDirectory', { key: row.key })).ok, false);
  const oldAccess = f.access.get(); await f.invoke('disable'); await f.access.set(oldAccess);
  release({ response: 1 }); assert.equal((await review).canceled, true); assert.ok(!f.access.get().roots.includes(row.path));
  dialog.showMessageBox = async () => { await fs.rename(row.path, row.path + '-old'); await fs.mkdir(row.path); return { response: 1 }; };
  assert.equal((await f.invoke('reviewDirectory', { key: row.key })).canceled, true);
  dialog.showMessageBox = async () => { await f.invoke('ignoreDirectory', { key: row.key }); return { response: 1 }; };
  assert.equal((await f.invoke('reviewDirectory', { key: row.key })).canceled, true);
});
test('directory redirect and disappeared pending candidates cannot grant access', async (t) => {
  const f = await setup(t), row = await pending(f);
  f.setSnapshot({ pendingDirectories: [] }); assert.equal((await f.invoke('reviewDirectory', { key: row.key })).ok, false);
  f.setSnapshot({ pendingDirectories: [row] }); await fs.rmdir(row.path);
  await fs.symlink(f.root, row.path, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.invoke('reviewDirectory', { key: row.key })).ok, false); assert.equal(f.prompts(), 0);
});
test('ignore and restore persist only identifiers, enforce sender/ownership and never change directory grants', async (t) => {
  const f = await setup(t), row = await pending(f), access = f.access.get();
  const session = { id: 'a'.repeat(40), clientKind: 'claude-code', nativeSessionId: 'native', cwd: access.roots[0], origin: 'user', ownership: 'unowned' };
  f.setSnapshot({ sessions: [session], pendingDirectories: [row] });
  assert.equal((await f.invoke('ignoreSession', { id: session.id, pid: 1 })).ok, false);
  assert.equal((await f.invoke('ignoreSession', { id: session.id }, 99)).ok, false);
  assert.equal((await f.invoke('ignoreSession', { id: 'b'.repeat(40) })).ok, false);
  assert.equal((await f.invoke('ignoreDirectory', { key: row.key })).ok, true);
  assert.equal((await f.invoke('ignoreSession', { id: session.id })).ok, true);
  assert.deepEqual(f.preferences.summary(), { sessions: 1, directories: 1 }); assert.deepEqual(f.access.get(), access);
  dialog.showMessageBox = async () => ({ response: 0 }); assert.equal((await f.invoke('restoreHidden')).canceled, true);
  assert.equal(f.preferences.summary().sessions, 1);
  dialog.showMessageBox = async () => ({ response: 1 }); assert.equal((await f.invoke('restoreHidden')).ok, true);
  assert.deepEqual(f.preferences.summary(), { sessions: 0, directories: 0 }); assert.deepEqual(f.access.get(), access);
  await fs.writeFile(f.ownershipPath, JSON.stringify({ schemaVersion: 2, revision: 1, launches: [], entries: [
    { agent: 'claude', sessionId: 'native', origin: 'station', registeredAt: new Date().toISOString(), revision: 1 },
  ] }));
  assert.equal((await f.invoke('ignoreSession', { id: session.id })).ok, false);
  assert.equal(f.preferences.summary().sessions, 0);
});
