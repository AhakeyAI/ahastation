import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { SessionCopyPreparer } from '../dist-electron/observe/session-copy.js';
import { SessionCopyStorage, SESSION_COPY_LIMITS, withSessionCopyStorage } from '../dist-electron/observe/session-copy-storage.js';
import { ScanAccessStore } from '../dist-electron/observe/scan-access.js';

const SID = '019a6cf7-1200-7000-8000-000000000001';
const errorCode = expected => error => error.code === expected && error.message === expected;
async function fixture(t, kind = 'codex', nativeId = SID) {
  const temp = await fs.mkdtemp(join(tmpdir(), 'copy-lifecycle-'));
  const root = await fs.realpath(temp);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userData = join(root, 'profile'), cwd = join(root, 'project');
  await fs.mkdir(userData); await fs.mkdir(cwd);
  const configRoots = { claude: join(root, 'claude'), codex: join(root, 'codex') };
  const source = kind === 'codex' ? join(configRoots.codex, 'sessions', `rollout-${nativeId}.jsonl`)
    : join(configRoots.claude, 'projects', 'fixture', `${nativeId}.jsonl`);
  await fs.mkdir(dirname(source), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(kind === 'codex'
    ? { type: 'session_meta', payload: { id: nativeId, cwd } }
    : { type: 'user', sessionId: nativeId, cwd, message: { role: 'user', content: 'private prompt' } }) + '\n');
  await fs.writeFile(source, bytes);
  const access = new ScanAccessStore(join(userData, 'scan-access.json'));
  await access.set({ enabled: true, roots: [cwd] });
  const id = createHash('sha1').update(`${kind}:${nativeId}`).digest('hex');
  const options = { userData, homeDir: root, configRoots, access,
    snapshot: () => ({ sessions: [{ id, nativeSessionId: nativeId, clientKind: kind, cwd, origin: 'user', ownership: 'unowned' }] }) };
  const preparer = new SessionCopyPreparer(options), store = new SessionCopyStorage(userData);
  return { root, userData, source, bytes, access, id, options, preparer, store,
    parent: join(userData, 'sessions', 'adoption-preparations') };
}

test('valid uppercase native UUID histories remain manageable without changing their identity', async t => {
  const f = await fixture(t, 'codex', SID.toUpperCase());
  const prepared = await f.preparer.prepare(f.id), row = (await f.store.list()).entries[0];
  assert.equal(row.state, 'prepared');
  await f.store.discard(prepared.preparationId, row.revision);
  assert.deepEqual(await fs.readFile(f.source), f.bytes);
});

for (const kind of ['codex', 'claude-code']) {
  test(`${kind}: inventory is metadata only and confirmed discard preserves source, registry and other backups`, async t => {
    const f = await fixture(t, kind);
    assert.deepEqual((await f.store.list()).entries, []);
    const first = await f.preparer.prepare(f.id), second = await f.preparer.prepare(f.id);
    // Management remains possible after scan authorization is revoked.
    await f.access.set({ enabled: false, roots: [] });
    const inventory = await new SessionCopyStorage(f.userData).list();
    assert.equal(inventory.entries.length, 2); assert.equal(inventory.blocked, false);
    assert.deepEqual(inventory.limits, SESSION_COPY_LIMITS);
    const row = inventory.entries.find(entry => entry.preparationId === first.preparationId);
    assert.equal(row.state, 'prepared'); assert.equal(row.clientKind, kind);
    assert(row.storedBytes > f.bytes.length * 2);
    assert.doesNotMatch(JSON.stringify(inventory), /private prompt|cwd|backupPath|copyPath|sourceObservedId|nativeSessionId/);
    await f.store.discard(row.preparationId, row.revision);
    await assert.rejects(fs.stat(dirname(first.backupPath)), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(f.source), f.bytes);
    assert.deepEqual(await fs.readFile(second.backupPath), f.bytes);
    assert.deepEqual((await f.store.list()).entries.map(entry => entry.preparationId), [second.preparationId]);
    assert.equal(f.access.get().enabled, false);
  });
}

test('discard rejects paths, stale receipts, changed manifests and same-sized replacement files', async t => {
  const f = await fixture(t), prepared = await f.preparer.prepare(f.id);
  const before = (await f.store.list()).entries[0];
  await assert.rejects(f.store.discard('../profile', before.revision), errorCode('invalid-preparation'));
  await assert.rejects(f.store.discard(before.preparationId, 'x'), errorCode('invalid-preparation'));
  await fs.rename(prepared.backupPath, join(f.root, 'saved-backup'));
  await fs.writeFile(prepared.backupPath, f.bytes);
  await assert.rejects(f.store.discard(before.preparationId, before.revision), errorCode('preparation-changed'));
  const next = (await f.store.list()).entries[0];
  await fs.writeFile(join(dirname(prepared.backupPath), 'manifest.json'), '{bad');
  await assert.rejects(f.store.discard(next.preparationId, next.revision), errorCode('preparation-changed'));
  assert.deepEqual(await fs.readFile(f.source), f.bytes);
  assert.deepEqual(await fs.readFile(prepared.backupPath), f.bytes);
});

test('known incomplete or corrupt preparations can be explicitly discarded after restart', async t => {
  const f = await fixture(t), prepared = await f.preparer.prepare(f.id);
  await fs.unlink(prepared.copyPath);
  await fs.writeFile(join(dirname(prepared.backupPath), 'manifest.json'), 'broken private prompt');
  const inventory = await new SessionCopyStorage(f.userData).list();
  assert.equal(inventory.entries[0].state, 'incomplete'); assert.equal(inventory.blocked, false);
  assert.doesNotMatch(JSON.stringify(inventory), /private prompt/);
  await f.store.discard(prepared.preparationId, inventory.entries[0].revision);
  assert.deepEqual((await f.store.list()).entries, []);
  assert.deepEqual(await fs.readFile(f.source), f.bytes);
});

test('unfamiliar native runtime files block deletion and further preparation without being traversed', async t => {
  const f = await fixture(t), prepared = await f.preparer.prepare(f.id);
  const row = (await f.store.list()).entries[0];
  const unknown = join(prepared.isolatedHome, 'config.toml');
  await fs.writeFile(unknown, 'private runtime config');
  const inventory = await f.store.list();
  assert.equal(inventory.blocked, true); assert.equal(inventory.entries[0].state, 'unavailable');
  assert.equal(inventory.entries[0].revision, undefined);
  await assert.rejects(f.store.discard(row.preparationId, row.revision), errorCode('storage-unavailable'));
  await assert.rejects(f.preparer.prepare(f.id), errorCode('storage-unavailable'));
  assert.equal(await fs.readFile(unknown, 'utf8'), 'private runtime config');
  assert.deepEqual(await fs.readFile(prepared.backupPath), f.bytes);
});

test('linked roots, hard-linked histories and replaced preparation directories never delete outside files', async t => {
  const f = await fixture(t), prepared = await f.preparer.prepare(f.id);
  const row = (await f.store.list()).entries[0], folder = dirname(prepared.backupPath);
  const saved = join(f.root, 'saved'); await fs.rename(folder, saved);
  await fs.symlink(saved, folder, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.store.list()).blocked, true);
  await assert.rejects(f.store.discard(row.preparationId, row.revision), errorCode('storage-unavailable'));
  assert.deepEqual(await fs.readFile(join(saved, 'backup.jsonl')), f.bytes);
  await fs.unlink(folder); await fs.rename(saved, folder);
  await fs.link(prepared.backupPath, join(f.root, 'outside-link'));
  assert.equal((await f.store.list()).entries[0].state, 'unavailable');
  await assert.rejects(f.preparer.prepare(f.id), errorCode('storage-unavailable'));
  assert.deepEqual(await fs.readFile(f.source), f.bytes);
});

test('count quota includes empty interrupted preparations and never evicts old data', async t => {
  const f = await fixture(t); await fs.mkdir(f.parent, { recursive: true });
  const ids = [];
  for (let i = 0; i < SESSION_COPY_LIMITS.count; i++) {
    const id = randomUUID(); ids.push(id); await fs.mkdir(join(f.parent, id));
  }
  await assert.rejects(f.preparer.prepare(f.id), errorCode('storage-full'));
  assert.deepEqual((await fs.readdir(f.parent)).sort(), ids.sort());
  const row = (await f.store.list()).entries[0];
  await f.store.discard(row.preparationId, row.revision);
  await f.preparer.prepare(f.id);
  assert.equal((await f.store.list()).entries.length, SESSION_COPY_LIMITS.count);
});

test('byte quota counts both stored histories and rejects before writing without automatic retention cleanup', async t => {
  const f = await fixture(t); await fs.mkdir(f.parent, { recursive: true });
  for (let i = 0; i < 4; i++) {
    const folder = join(f.parent, randomUUID()); await fs.mkdir(folder);
    await fs.mkdir(join(folder, 'native-home', 'sessions'), { recursive: true });
    for (const path of [join(folder, 'backup.jsonl'), join(folder, 'native-home', 'sessions', `rollout-${SID}.jsonl`)]) {
      await fs.writeFile(path, ''); await fs.truncate(path, 64 * 1024 * 1024);
    }
  }
  assert.equal((await f.store.list()).storedBytes, SESSION_COPY_LIMITS.bytes);
  await assert.rejects(f.preparer.prepare(f.id), errorCode('storage-full'));
  assert.equal((await fs.readdir(f.parent)).length, 4);
  assert.deepEqual(await fs.readFile(f.source), f.bytes);
});

test('same-profile managers and preparers share the active-operation gate; failed operation releases it', async t => {
  const f = await fixture(t); let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const work = withSessionCopyStorage(f.userData, async () => { entered(); await gate; });
  t.after(release); await started;
  await assert.rejects(new SessionCopyStorage(f.userData).list(), errorCode('busy'));
  await assert.rejects(new SessionCopyPreparer(f.options).prepare(f.id), errorCode('busy'));
  const other = join(f.root, 'other-profile'); await fs.mkdir(other);
  assert.deepEqual((await new SessionCopyStorage(other).list()).entries, []);
  release(); await work;
  await assert.rejects(withSessionCopyStorage(f.userData, async () => { throw new Error('injected'); }), /injected/);
  assert.deepEqual((await f.store.list()).entries, []);
});

test('partial unlink failure is reported, keeps remaining backup, and a fresh receipt can finish cleanup', async t => {
  const f = await fixture(t), prepared = await f.preparer.prepare(f.id);
  const row = (await f.store.list()).entries[0], original = fs.unlink;
  fs.unlink = async path => { if (String(path) === prepared.backupPath) throw new Error('private path disk error'); return original(path); };
  t.after(() => { fs.unlink = original; });
  await assert.rejects(f.store.discard(row.preparationId, row.revision), errorCode('storage-unavailable'));
  assert.deepEqual(await fs.readFile(prepared.backupPath), f.bytes);
  assert.deepEqual(await fs.readFile(f.source), f.bytes);
  fs.unlink = original;
  const retry = (await f.store.list()).entries[0];
  await f.store.discard(retry.preparationId, retry.revision);
  assert.deepEqual((await f.store.list()).entries, []);
});

test('file replacement between unlink operations aborts without deleting the replacement', async t => {
  const f = await fixture(t), prepared = await f.preparer.prepare(f.id);
  const row = (await f.store.list()).entries[0], original = fs.unlink;
  const manifest = join(dirname(prepared.backupPath), 'manifest.json'); let replaced = false;
  fs.unlink = async path => {
    await original(path);
    if (!replaced) { replaced = true; await fs.rename(manifest, join(f.root, 'saved-manifest')); await fs.writeFile(manifest, 'unfamiliar replacement'); }
  };
  t.after(() => { fs.unlink = original; });
  await assert.rejects(f.store.discard(row.preparationId, row.revision), errorCode('preparation-changed'));
  assert.equal(await fs.readFile(manifest, 'utf8'), 'unfamiliar replacement');
  assert.deepEqual(await fs.readFile(f.source), f.bytes);
});
