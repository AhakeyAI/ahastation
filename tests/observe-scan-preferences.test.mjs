import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ScanPreferences } from '../dist-electron/observe/scan-preferences.js';
import { ScanNotifications } from '../dist-electron/observe/scan-notifications.js';

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'scan-preferences-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = join(root, 'profile', 'preferences.json');
  return { root, file, store: new ScanPreferences(file) };
}
test('ignored session/directory keys persist independently, serialize writes and restore without private source data', async (t) => {
  const { file, store } = await fixture(t); await store.load(); assert.equal(store.available, true);
  await Promise.all([store.hide('session', 'a'.repeat(40)), store.hide('directory', 'b'.repeat(64)), store.hide('session', 'c'.repeat(40))]);
  const reloaded = new ScanPreferences(file); await reloaded.load();
  assert.equal(reloaded.hiddenSession('a'.repeat(40)), true); assert.equal(reloaded.hiddenDirectory('b'.repeat(64)), true);
  assert.deepEqual(reloaded.summary(), { sessions: 2, directories: 1 });
  const raw = await fs.readFile(file, 'utf8'); assert.doesNotMatch(raw, /path|title|cwd|nativeSessionId|grant/);
  await Promise.all([reloaded.hide('session', 'd'.repeat(40)), reloaded.restore()]);
  const restored = new ScanPreferences(file); await restored.load(); assert.deepEqual(restored.summary(), { sessions: 0, directories: 0 });
  await restored.hide('session', 'a'.repeat(40)); await fs.rm(file); await restored.load();
  assert.equal(restored.available, true); assert.deepEqual(restored.summary(), { sessions: 0, directories: 0 });
});
test('malformed or oversized preferences block reads until an explicit restore; invalid keys and failed writes do not succeed', async (t) => {
  const { root, file, store } = await fixture(t);
  await fs.mkdir(join(root, 'profile')); await fs.writeFile(file, '{corrupt'); await store.load();
  assert.equal(store.available, false); await assert.rejects(store.hide('session', 'a'.repeat(40)));
  await assert.rejects(store.hide('directory', '../path'));
  await store.restore(); assert.equal(store.available, true);
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 99, sessions: [], directories: [] })); await store.load(); assert.equal(store.available, false);
  await fs.writeFile(file, 'x'.repeat(2 * 1024 * 1024 + 1)); await store.load(); assert.equal(store.available, false);
  const blocked = join(root, 'not-a-directory'); await fs.writeFile(blocked, 'block');
  const failed = new ScanPreferences(join(blocked, 'preferences.json'));
  await assert.rejects(failed.hide('session', 'a'.repeat(40)));
  assert.deepEqual(failed.summary(), { sessions: 0, directories: 0 });
});
test('notification batches coalesce, rate-limit and close on revoke without leaking directory details', () => {
  let clock = 0, shown = 0, closed = 0;
  const notifications = new ScanNotifications(() => { shown++; return () => { closed++; }; }, () => clock);
  const snapshot = (keys, enabled = true) => ({ sessions: [], access: { enabled, roots: ['/allowed'] },
    pendingDirectories: keys.map((key) => ({ key, path: '/private/secret', label: 'Private', sessionCount: 1 })) });
  notifications.update(snapshot(['a', 'b'])); notifications.update(snapshot(['a', 'b'])); assert.equal(shown, 1);
  notifications.update(snapshot(['a', 'b', 'c'])); assert.equal(shown, 1);
  clock = 60_000; notifications.update(snapshot(['c'])); assert.equal(shown, 2); assert.equal(closed, 1);
  notifications.update(snapshot([], false)); assert.equal(closed, 2);
  notifications.update(snapshot(['a'])); assert.equal(shown, 2, 'same directories do not renotify after regrant in this app run');
});
test('unsupported/failed notifications do not retry each scan or hide in-app pending directories', () => {
  let attempts = 0, clock = 0;
  const notifications = new ScanNotifications(() => { attempts++; throw new Error('OS denied'); }, () => clock);
  const snap = { sessions: [], access: { enabled: true, roots: ['/allowed'] }, pendingDirectories: [{ key: 'x' }] };
  notifications.update(snap); clock += 61_000; notifications.update(snap);
  assert.equal(attempts, 1); assert.equal(snap.pendingDirectories.length, 1);
});
