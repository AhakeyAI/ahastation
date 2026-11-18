import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { dialog, ipcMain } from 'electron';
import { registerSessionCopyIpc } from '../dist-electron/observe/session-copy-ipc.js';
import { SessionCopyStorage, withSessionCopyStorage } from '../dist-electron/observe/session-copy-storage.js';

async function fixture(t) {
  const tmp = await fs.mkdtemp(join(tmpdir(), 'copy-ipc-')), root = await fs.realpath(tmp);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = randomUUID(), folder = join(root, 'sessions', 'adoption-preparations', id);
  await fs.mkdir(folder, { recursive: true }); await fs.writeFile(join(folder, 'backup.jsonl'), 'private prompt');
  const storage = new SessionCopyStorage(root), handlers = new Map();
  const originals = { handle: ipcMain.handle, message: dialog.showMessageBox };
  t.after(() => { ipcMain.handle = originals.handle; dialog.showMessageBox = originals.message; });
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  let prompts = 0, lastDialog;
  dialog.showMessageBox = async (_win, options) => { prompts++; lastDialog = options; return { response: 0 }; };
  const win = { webContents: { id: 11 } };
  registerSessionCopyIpc({ window: () => win, storage });
  const row = (await storage.list()).entries[0];
  return { root, folder, id, row, storage, prompts: () => prompts, lastDialog: () => lastDialog,
    invoke: (action, raw, sender = 11) => handlers.get(`observe:${action}`)({ sender: { id: sender } }, raw) };
}

test('backup IPC rejects foreign windows, paths, unknown fields and stale receipts before confirmation', async t => {
  const f = await fixture(t), payload = { preparationId: f.id, revision: f.row.revision };
  assert.equal((await f.invoke('listSessionCopies', undefined, 99)).ok, false);
  assert.equal((await f.invoke('listSessionCopies', { path: f.root })).ok, false);
  for (const value of [{ ...payload, path: f.folder }, { ...payload, preparationId: '../other' },
    { ...payload, revision: '0'.repeat(64) }]) assert.equal((await f.invoke('discardSessionCopy', value)).ok, false);
  assert.equal((await f.invoke('discardSessionCopy', payload, 99)).ok, false);
  assert.equal(f.prompts(), 0);
  assert.equal(await fs.readFile(join(f.folder, 'backup.jsonl'), 'utf8'), 'private prompt');
});

test('native confirmation defaults to cancel; explicit deletion works with scanning disabled', async t => {
  const f = await fixture(t), payload = { preparationId: f.id, revision: f.row.revision };
  const listed = await f.invoke('listSessionCopies');
  assert.equal(listed.ok, true); assert.doesNotMatch(JSON.stringify(listed), /private prompt|backupPath/);
  assert.equal((await f.invoke('discardSessionCopy', payload)).canceled, true);
  assert.equal(f.lastDialog().defaultId, 0); assert.equal(f.lastDialog().cancelId, 0);
  assert.doesNotMatch(f.lastDialog().detail, /private prompt/);
  dialog.showMessageBox = async () => ({ response: 1 });
  assert.equal((await f.invoke('discardSessionCopy', payload)).ok, true);
  assert.deepEqual((await f.storage.list()).entries, []);
});

test('changing a backup during native confirmation requires a fresh receipt and preserves the data', async t => {
  const f = await fixture(t);
  dialog.showMessageBox = async () => { await fs.appendFile(join(f.folder, 'backup.jsonl'), 'new history'); return { response: 1 }; };
  const result = await f.invoke('discardSessionCopy', { preparationId: f.id, revision: f.row.revision });
  assert.equal(result.ok, false); assert.match(result.error, /已变化/);
  assert.equal(await fs.readFile(join(f.folder, 'backup.jsonl'), 'utf8'), 'private promptnew history');
});

test('duplicate confirmation is refused and an active preparation cannot be deleted after the dialog', async t => {
  const f = await fixture(t); let entered, release;
  const opened = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  dialog.showMessageBox = async () => { entered(); await gate; return { response: 1 }; };
  t.after(release);
  const payload = { preparationId: f.id, revision: f.row.revision };
  const deletion = f.invoke('discardSessionCopy', payload); await opened;
  assert.equal((await f.invoke('discardSessionCopy', payload)).ok, false);
  await withSessionCopyStorage(f.root, async () => { release(); assert.equal((await deletion).ok, false); });
  assert.equal(await fs.readFile(join(f.folder, 'backup.jsonl'), 'utf8'), 'private prompt');
});

test('disk failures never return private OS paths through backup IPC', async t => {
  const f = await fixture(t), original = fs.unlink;
  dialog.showMessageBox = async () => ({ response: 1 });
  fs.unlink = async () => { throw new Error('private prompt /secret/path'); };
  t.after(() => { fs.unlink = original; });
  const result = await f.invoke('discardSessionCopy', { preparationId: f.id, revision: f.row.revision });
  assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /private prompt|secret/);
  assert.equal(await fs.readFile(join(f.folder, 'backup.jsonl'), 'utf8'), 'private prompt');
});
