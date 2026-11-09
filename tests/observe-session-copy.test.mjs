import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { SessionCopyPreparer } from '../dist-electron/observe/session-copy.js';
import { ScanAccessStore } from '../dist-electron/observe/scan-access.js';

const SID = '019a6cf7-1200-7000-8000-000000000001';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, kind = 'codex') {
  const temp = await fs.mkdtemp(join(tmpdir(), 'session-copy-'));
  const root = await fs.realpath(temp); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'), userData = join(root, 'profile');
  await fs.mkdir(cwd); await fs.mkdir(userData);
  const configRoots = { claude: join(root, 'claude'), codex: join(root, 'codex') };
  const source = kind === 'codex' ? join(configRoots.codex, 'sessions', '2026', '11', '09', `rollout-${SID}.jsonl`)
    : join(configRoots.claude, 'projects', '-fixture-project', `${SID}.jsonl`);
  await fs.mkdir(dirname(source), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(kind === 'codex'
    ? { type: 'session_meta', payload: { id: SID, cwd, timestamp: new Date().toISOString(), source: 'cli' } }
    : { type: 'user', sessionId: SID, cwd, message: { role: 'user', content: 'Private source prompt' } })
    + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', content: [{ text: 'Private history' }] } }) + '\n');
  await fs.writeFile(source, bytes);
  const access = new ScanAccessStore(join(userData, 'scan-access.json')); await access.set({ enabled: true, roots: [cwd] });
  const session = { id: createHash('sha1').update(`${kind}:${SID}`).digest('hex'), clientKind: kind,
    nativeSessionId: SID, cwd, origin: 'user', ownership: 'unowned' };
  let snapshot = { sessions: [session] };
  const preparer = new SessionCopyPreparer({ userData, homeDir: root, configRoots, access, snapshot: () => snapshot });
  return { root, cwd, userData, source, bytes, session, access, preparer,
    snapshot: (value) => { snapshot = value; } };
}
const code = (expected) => (error) => error.code === expected && error.message === expected;

for (const kind of ['codex', 'claude-code']) {
  test(`${kind}: byte-exact backup and independent fork input preserve original and record no paths/prompts in audit`, async (t) => {
    const f = await fixture(t, kind), before = await fs.stat(f.source);
    const prepared = await f.preparer.prepare(f.session.id);
    assert.equal(prepared.state, 'prepared'); assert.equal(prepared.sha256, sha(f.bytes)); assert.equal(prepared.byteLength, f.bytes.length);
    for (const path of [f.source, prepared.backupPath, prepared.copyPath]) assert.deepEqual(await fs.readFile(path), f.bytes);
    assert.notEqual((await fs.stat(prepared.copyPath)).ino, before.ino);
    assert.notEqual((await fs.stat(prepared.backupPath)).ino, before.ino);
    await fs.appendFile(prepared.copyPath, 'fork changed its input\n');
    assert.deepEqual(await fs.readFile(f.source), f.bytes); assert.deepEqual(await fs.readFile(prepared.backupPath), f.bytes);
    const audit = await fs.readFile(join(dirname(prepared.backupPath), 'manifest.json'), 'utf8');
    assert.doesNotMatch(audit, /Private|prompt|cwd|nativeSessionId|backupPath|copyPath|isolatedHome/);
    assert.equal(JSON.parse(audit).sha256, sha(f.bytes));
    if (process.platform !== 'win32') assert.equal((await fs.stat(prepared.backupPath)).mode & 0o777, 0o600);
    const second = await f.preparer.prepare(f.session.id); assert.notEqual(second.preparationId, prepared.preparationId);
  });
}

test('bad IDs, internal/unresolved sessions and disabled grants do not produce copies', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.preparer.prepare('../file'), code('session-unavailable'));
  for (const changed of [{ origin: 'worker' }, { ownership: 'unresolved' }, { nativeSessionId: '--flag' }, { cwd: '.' }]) {
    f.snapshot({ sessions: [{ ...f.session, ...changed }] });
    await assert.rejects(f.preparer.prepare(f.session.id), code('session-unavailable'));
  }
  f.snapshot({ sessions: [f.session] }); await f.access.set({ enabled: false, roots: [] });
  await assert.rejects(f.preparer.prepare(f.session.id), code('scan-access-changed'));
  await assert.rejects(fs.stat(join(f.userData, 'sessions', 'adoption-preparations')), { code: 'ENOENT' });
});

test('fresh IF-2 worker binding or corrupt registry overrides the observed user row', async (t) => {
  const f = await fixture(t); await fs.mkdir(join(f.userData, 'sessions'));
  const file = join(f.userData, 'sessions', 'owned.json');
  await fs.writeFile(file, '{bad'); await assert.rejects(f.preparer.prepare(f.session.id), code('ownership-changed'));
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 2, revision: 1, launches: [], entries: [{
    agent: 'codex', sessionId: SID, origin: 'station', revision: 1, registeredAt: new Date().toISOString(),
  }] }));
  await assert.rejects(f.preparer.prepare(f.session.id), code('ownership-changed'));
  assert.deepEqual(await fs.readFile(f.source), f.bytes);
});

test('ambiguous native IDs, linked source directories and oversized histories are rejected', async (t) => {
  const f = await fixture(t), archived = join(f.root, 'codex', 'archived_sessions'); await fs.mkdir(archived);
  const duplicate = join(archived, 'duplicate.jsonl'); await fs.writeFile(duplicate, f.bytes);
  await assert.rejects(f.preparer.prepare(f.session.id), code('source-ambiguous'));
  await fs.writeFile(duplicate, f.bytes.toString().replaceAll(JSON.stringify(f.cwd).slice(1, -1), 'different-project'));
  await assert.rejects(f.preparer.prepare(f.session.id), code('source-ambiguous')); await fs.unlink(duplicate);
  const moved = join(f.root, 'moved-history'); await fs.rename(dirname(f.source), moved);
  await fs.symlink(moved, dirname(f.source), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.preparer.prepare(f.session.id), code('source-unavailable'));
  await fs.unlink(dirname(f.source)); await fs.rename(moved, dirname(f.source));
  await fs.truncate(f.source, 64 * 1024 * 1024 + 1);
  await assert.rejects(f.preparer.prepare(f.session.id), code('source-too-large'));
});

test('source append during backup invalidates the attempt and cleans only its own artifacts', async (t) => {
  const f = await fixture(t), original = fs.open;
  fs.open = async (path, ...args) => {
    const handle = await original(path, ...args);
    if (String(path).endsWith('backup.jsonl')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...values) => { await fs.appendFile(f.source, 'new source row\n'); return write(...values); };
    }
    return handle;
  };
  t.after(() => { fs.open = original; });
  await assert.rejects(f.preparer.prepare(f.session.id), code('source-changed'));
  assert.deepEqual(await fs.readdir(join(f.userData, 'sessions', 'adoption-preparations')), []);
  assert.equal(await fs.readFile(f.source, 'utf8'), f.bytes.toString() + 'new source row\n');
});

test('revoke/regrant while writing aborts despite identical roots, and concurrent preparations cannot race', async (t) => {
  const f = await fixture(t), original = fs.open; let entered, release;
  const gate = new Promise((resolve) => { release = resolve; }), started = new Promise((resolve) => { entered = resolve; });
  fs.open = async (path, ...args) => {
    const handle = await original(path, ...args);
    if (String(path).endsWith('backup.jsonl')) {
      const write = handle.writeFile.bind(handle); handle.writeFile = async (...values) => { entered(); await gate; return write(...values); };
    }
    return handle;
  };
  t.after(() => { fs.open = original; release(); });
  const preparation = f.preparer.prepare(f.session.id); const rejected = assert.rejects(preparation, code('scan-access-changed'));
  await started; await assert.rejects(f.preparer.prepare(f.session.id), code('busy'));
  await f.access.set({ enabled: false, roots: [] }); await f.access.set({ enabled: true, roots: [f.cwd] });
  release(); await rejected;
  assert.deepEqual(await fs.readFile(f.source), f.bytes);
  assert.deepEqual(await fs.readdir(join(f.userData, 'sessions', 'adoption-preparations')), []);
});

test('storage links and write errors never alter a source or return partial success', async (t) => {
  const f = await fixture(t), outside = join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.mkdir(join(f.userData, 'sessions'));
  const folder = join(f.userData, 'sessions', 'adoption-preparations');
  await fs.symlink(outside, folder, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.preparer.prepare(f.session.id), code('storage-unavailable'));
  assert.deepEqual(await fs.readdir(outside), []); await fs.unlink(folder);
  await fs.writeFile(folder, 'block'); await assert.rejects(f.preparer.prepare(f.session.id), code('storage-unavailable'));
  assert.deepEqual(await fs.readFile(f.source), f.bytes);
});

test('partial input-copy write failure removes the failed attempt and leaves previous preparations intact', async (t) => {
  const f = await fixture(t), good = await f.preparer.prepare(f.session.id), original = fs.open;
  fs.open = async (path, flags, ...args) => {
    const handle = await original(path, flags, ...args);
    if (flags === 'wx' && String(path).endsWith(`rollout-${SID}.jsonl`)) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...values) => { await write(...values); throw new Error('disk full /private/path prompt secret'); };
    }
    return handle;
  };
  t.after(() => { fs.open = original; });
  await assert.rejects(f.preparer.prepare(f.session.id), code('storage-unavailable'));
  assert.deepEqual(await fs.readFile(f.source), f.bytes); assert.deepEqual(await fs.readFile(good.backupPath), f.bytes);
  assert.deepEqual(await fs.readdir(dirname(dirname(good.backupPath))), [good.preparationId]);
});

test('user-adopted input requires a matching IF-2 entry and still copies to a separate preparation', async (t) => {
  const f = await fixture(t); f.snapshot({ sessions: [{ ...f.session, origin: 'user-adopted', ownership: 'owned' }] });
  await assert.rejects(f.preparer.prepare(f.session.id), code('ownership-changed'));
  await fs.mkdir(join(f.userData, 'sessions'));
  await fs.writeFile(join(f.userData, 'sessions', 'owned.json'), JSON.stringify({ schemaVersion: 2, revision: 1, launches: [], entries: [{
    agent: 'codex', sessionId: SID, origin: 'user-adopted', revision: 1, registeredAt: new Date().toISOString(),
  }] }));
  const result = await f.preparer.prepare(f.session.id); assert.equal(result.state, 'prepared');
  assert.deepEqual(await fs.readFile(f.source), f.bytes);
});

test('ownership reclassification during the copy aborts without persisting a prepared manifest', async (t) => {
  const f = await fixture(t), original = fs.open;
  fs.open = async (path, flags, ...args) => {
    const handle = await original(path, flags, ...args);
    if (flags === 'wx' && String(path).endsWith('backup.jsonl')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...values) => {
        await fs.writeFile(join(f.userData, 'sessions', 'owned.json'), JSON.stringify({ schemaVersion: 2, revision: 1, launches: [], entries: [{
          agent: 'codex', sessionId: SID, origin: 'station', revision: 1, registeredAt: new Date().toISOString(),
        }] }));
        return write(...values);
      };
    }
    return handle;
  };
  t.after(() => { fs.open = original; });
  await assert.rejects(f.preparer.prepare(f.session.id), code('ownership-changed'));
  assert.deepEqual(await fs.readdir(join(f.userData, 'sessions', 'adoption-preparations')), []);
  assert.deepEqual(await fs.readFile(f.source), f.bytes);
});

test('source mutation while audit is written is detected by final source verification', async (t) => {
  const f = await fixture(t), original = fs.open;
  fs.open = async (path, flags, ...args) => {
    const handle = await original(path, flags, ...args);
    if (flags === 'wx' && String(path).endsWith('manifest.json')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...values) => { await fs.appendFile(f.source, 'late source append\n'); return write(...values); };
    }
    return handle;
  };
  t.after(() => { fs.open = original; });
  await assert.rejects(f.preparer.prepare(f.session.id), code('source-changed'));
  assert.deepEqual(await fs.readdir(join(f.userData, 'sessions', 'adoption-preparations')), []);
  assert.equal(await fs.readFile(f.source, 'utf8'), f.bytes.toString() + 'late source append\n');
});

test('replaced storage directory is rejected and cleanup preserves unfamiliar files', async (t) => {
  const f = await fixture(t), original = fs.open; let sentinel;
  fs.open = async (path, flags, ...args) => {
    if (flags === 'wx' && String(path).endsWith('manifest.json')) {
      const folder = dirname(path); await fs.rename(folder, folder + '-moved'); await fs.mkdir(folder);
      sentinel = join(folder, 'backup.jsonl'); await fs.writeFile(sentinel, 'unfamiliar file');
    }
    return original(path, flags, ...args);
  };
  t.after(() => { fs.open = original; });
  await assert.rejects(f.preparer.prepare(f.session.id), code('storage-unavailable'));
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'unfamiliar file');
  assert.deepEqual(await fs.readFile(f.source), f.bytes);
});
