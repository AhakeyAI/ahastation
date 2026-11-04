import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectDiscoveryScheduler, PROJECT_DISCOVERY_LIMITS as LIMITS } from '../dist-electron/observe/project-scheduler.js';
import { discoverProject } from '../dist-electron/observe/project-discovery.js';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = { status: 'non-git', reason: 'not-git' };
const session = (cwd, id = cwd, extra = {}) => ({ id, cwd, origin: 'user', ownership: 'unowned', projectId: `legacy:${cwd}`, ...extra });
function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.name=Scheduler Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
  { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'aha-project-queue-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let access = { enabled: true, roots: [root] }, clock = 1_000;
  const options = { getAccess: () => access, now: () => clock };
  const directory = async (name) => { const path = join(root, name); await fs.mkdir(path, { recursive: true }); return path; };
  const repo = async (name) => {
    const cwd = await directory(name); git(cwd, ['init', '-b', 'main']);
    git(cwd, ['commit', '--allow-empty', '-m', `Initial ${name}`]);
    git(cwd, ['remote', 'add', 'origin', 'https://user:secret@github.com/Example/Team.git']);
    return cwd;
  };
  const create = (extra = {}) => new ProjectDiscoveryScheduler({ ...options, ...extra });
  return { root, directory, repo, create, options, setAccess: (a) => { access = a; }, advance: (ms) => { clock += ms; } };
}
const refresh = (scheduler, rows) => scheduler.refresh(rows, () => true);

test('scheduler deduplicates canonical directories, bounds concurrency and starts without waiting for Git', async (t) => {
  const f = await fixture(t); const dirs = await Promise.all(Array.from({ length: 6 }, (_, i) => f.directory(`dir-${i}`)));
  const alias = join(f.root, 'alias'); await fs.symlink(dirs[0], alias, process.platform === 'win32' ? 'junction' : 'dir');
  const gate = deferred(), started = []; let active = 0, peak = 0;
  const scheduler = f.create({ probe: async (cwd) => { started.push(cwd); peak = Math.max(peak, ++active); await gate.promise; active--; return plain; } });
  const rows = [...dirs.map((d) => session(d)), session(dirs[0], 'duplicate'), session(alias, 'alias')];
  await refresh(scheduler, rows); await flush();
  assert.equal(started.length, 2); assert.equal(peak, LIMITS.concurrent);
  assert.ok(scheduler.project(rows).every((g) => g.status === 'pending'));
  gate.resolve(); await scheduler.whenIdle();
  assert.equal(started.length, LIMITS.startsPerScan); assert.equal(new Set(started).size, 4);
  await refresh(scheduler, rows); await scheduler.whenIdle();
  assert.equal(started.length, dirs.length); assert.equal(peak, 2);
  assert.equal(scheduler.project(rows).flatMap((g) => g.mounts.flatMap((m) => m.sessionIds)).length, rows.length);
});

test('directory cap leaves excess sessions visible without probing them; expired entries cannot starve new work', async (t) => {
  const f = await fixture(t);
  const rows = Array.from({ length: LIMITS.directories + 5 }, (_, i) => session(join(f.root, `dir-${i}`)));
  const started = [];
  const scheduler = f.create({ realpath: async (path) => path, probe: async (cwd) => { started.push(cwd); return plain; } });
  for (let scan = 0; scan < Math.ceil(LIMITS.directories / LIMITS.startsPerScan); scan++) {
    await refresh(scheduler, rows); await scheduler.whenIdle(); f.advance(LIMITS.retryMs + 1);
  }
  assert.equal(new Set(started).size, LIMITS.directories);
  assert.ok(started.every((cwd) => !rows.slice(LIMITS.directories).some((s) => s.cwd === cwd)));
  const projected = scheduler.project(rows);
  assert.equal(projected.flatMap((g) => g.mounts.flatMap((m) => m.sessionIds)).length, rows.length);
  assert.ok(projected.slice(-5).every((g) => g.reason === 'directory-limit-or-unavailable'));
});

test('IF-2 internal and unresolved sessions never start discovery; ownership changes discard cached evidence', async (t) => {
  const f = await fixture(t); const cwd = await f.directory('project'); let calls = 0;
  const scheduler = f.create({ probe: async () => { calls++; return plain; } });
  const excluded = ['worker', 'station', 'unknown'].map((origin) => session(cwd, origin, { origin, ownership: 'unresolved' }));
  await refresh(scheduler, excluded); await scheduler.whenIdle(); assert.equal(calls, 0);
  const adopted = session(cwd, 'adopted', { origin: 'user-adopted', ownership: 'owned' });
  await refresh(scheduler, [adopted, ...excluded]); await scheduler.whenIdle(); assert.equal(calls, 1);
  const groups = scheduler.project([adopted, ...excluded]);
  assert.equal(groups.length, 2); assert.equal(groups.find((g) => g.status === 'unresolved').reason, 'ownership-unresolved');
  assert.deepEqual(groups.flatMap((g) => g.mounts.flatMap((m) => m.sessionIds)).sort(), ['adopted', 'unknown']);
  await refresh(scheduler, excluded);
  assert.ok(scheduler.project(excluded).every((g) => g.status === 'unresolved'));
  await refresh(scheduler, [adopted]); await scheduler.whenIdle(); assert.equal(calls, 2);
});

test('revoke/regrant rejects late results while old tasks still consume concurrency slots', async (t) => {
  const f = await fixture(t); const rows = await Promise.all(['a', 'b'].map(async (name) => session(await f.directory(name))));
  const gate = deferred(); let calls = 0;
  const scheduler = f.create({ probe: async () => { calls++; if (calls <= 2) await gate.promise; return plain; } });
  await refresh(scheduler, rows); await flush(); assert.equal(calls, 2);
  f.setAccess({ enabled: false, roots: [] }); scheduler.invalidate();
  assert.ok(scheduler.project(rows).every((g) => g.status !== 'non-git'));
  f.setAccess({ enabled: true, roots: [f.root] }); await refresh(scheduler, rows);
  assert.equal(calls, 2, 'old generation holds both slots');
  gate.resolve(); await scheduler.whenIdle(); assert.equal(calls, 4);
  assert.ok(scheduler.project(rows).every((g) => g.status === 'non-git'));
});

test('a removed directory and an in-grant link redirected outside the grant drop old candidates', async (t) => {
  const f = await fixture(t); const a = await f.directory('allowed/a'), b = await f.directory('outside');
  const allowed = join(f.root, 'allowed'), alias = join(allowed, 'alias');
  await fs.symlink(a, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.setAccess({ enabled: true, roots: [allowed] }); let calls = 0;
  const scheduler = f.create({ probe: async () => { calls++; return plain; } }); const rows = [session(alias)];
  await refresh(scheduler, rows); await scheduler.whenIdle(); assert.equal(calls, 1);
  await fs.unlink(alias); await fs.symlink(b, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await refresh(scheduler, rows); await scheduler.whenIdle();
  assert.equal(calls, 1); assert.equal(scheduler.project(rows)[0].status, 'pending');
  await fs.unlink(alias); await refresh(scheduler, rows);
  assert.equal(scheduler.project(rows)[0].reason, 'directory-limit-or-unavailable');
});

test('real Git cache detects branch, origin, refs and nested repository changes; TTL and failures retry', async (t) => {
  const f = await fixture(t); const cwd = await f.repo('repo'); let calls = 0;
  const scheduler = f.create({ probe: async (...args) => { calls++; return discoverProject(...args); } });
  const rows = [session(cwd)]; const scan = async () => { await refresh(scheduler, rows); await scheduler.whenIdle(); return scheduler.project(rows)[0]; };
  assert.equal((await scan()).mounts[0].branch, 'main'); assert.equal(calls, 1);
  await scan(); assert.equal(calls, 1, 'fast tick only reads metadata');
  git(cwd, ['checkout', '-b', 'feature']); assert.equal((await scan()).mounts[0].branch, 'feature'); assert.equal(calls, 2);
  git(cwd, ['remote', 'set-url', 'origin', 'git@github.com:Fork/Team.git']);
  assert.equal((await scan()).label, 'fork/team'); assert.equal(calls, 3);
  git(cwd, ['commit', '--allow-empty', '-m', 'Next']); await scan(); assert.equal(calls, 4);
  git(cwd, ['pack-refs', '--all']); await scan(); assert.equal(calls, 5);
  f.advance(LIMITS.cacheMs); await scan(); assert.equal(calls, 6);
  const sub = await f.directory('repo/src'); rows[0] = session(sub);
  await scan(); assert.equal(calls, 7);
  git(sub, ['init', '-b', 'nested']); git(sub, ['commit', '--allow-empty', '-m', 'Nested root']);
  const nested = await scan(); assert.equal(calls, 8); assert.equal(nested.mounts[0].path, sub);
  git(sub, ['remote', 'add', 'origin', 'https://gitlab.com/unsupported/repo']);
  assert.equal((await scan()).status, 'unresolved'); assert.equal(calls, 9);
  await scan(); assert.equal(calls, 9);
  f.advance(LIMITS.retryMs); await scan(); assert.equal(calls, 10);
});

test('grouped projection preserves legacy IDs, distinct clones/worktrees/forks and keeps raw evidence private', async (t) => {
  const f = await fixture(t); const main = await f.repo('main'), linked = join(f.root, 'linked'), clone = join(f.root, 'clone');
  git(main, ['worktree', 'add', '-b', 'feature', linked]); git(f.root, ['clone', '--no-local', main, clone]);
  git(clone, ['remote', 'set-url', 'origin', 'git@github.com:Example/Team.git']);
  const sub = await f.directory('main/src'); const rows = [main, sub, linked, clone].map((cwd, i) => session(cwd, `s-${i}`));
  const before = structuredClone(rows); const scheduler = f.create();
  await refresh(scheduler, rows); await scheduler.whenIdle();
  let groups = scheduler.project(rows); assert.equal(groups.length, 1); assert.equal(groups[0].mounts.length, 3);
  assert.equal(groups[0].mounts.find((m) => m.path === main).sessionIds.length, 2);
  assert.equal(groups[0].mounts.find((m) => m.path === linked).branch, 'feature');
  assert.doesNotMatch(JSON.stringify(groups), /secret|initialCommit|gitCommonDir|repositoryIdentity|fingerprint|https:|git@/);
  assert.deepEqual(rows, before);
  git(clone, ['remote', 'set-url', 'origin', 'https://github.com/fork/team']);
  await refresh(scheduler, rows); await scheduler.whenIdle(); groups = scheduler.project(rows);
  assert.equal(groups.length, 2); assert.deepEqual(rows, before);
});

test('a linked worktree redirected to different Git metadata cannot retain the old repository group', async (t) => {
  const f = await fixture(t); const first = await f.repo('first'), second = await f.repo('second');
  git(second, ['remote', 'set-url', 'origin', 'https://github.com/other/repository']);
  const linked = join(f.root, 'linked'); git(first, ['worktree', 'add', '-b', 'linked', linked]);
  const scheduler = f.create(); const rows = [session(linked)];
  await refresh(scheduler, rows); await scheduler.whenIdle();
  const old = scheduler.project(rows)[0]; assert.equal(old.label, 'example/team');
  // Git for Windows marks this file hidden; Node's truncating write mode
  // rejects hidden files with EPERM. Replace the fixture route explicitly.
  await fs.unlink(join(linked, '.git'));
  await fs.writeFile(join(linked, '.git'), `gitdir: ${join(second, '.git')}\n`);
  await refresh(scheduler, rows);
  assert.ok(scheduler.project(rows).every((g) => g.key !== old.key));
  await scheduler.whenIdle();
  assert.equal(scheduler.project(rows)[0].label, 'other/repository');
});

test('probe exceptions are negative-cached and invalidated results never reappear after a directory is removed', async (t) => {
  const f = await fixture(t); const cwd = await f.directory('project'); const gate = deferred(); let calls = 0;
  const scheduler = f.create({ probe: async () => { calls++; if (calls === 1) throw new Error('private stderr'); await gate.promise; return plain; } });
  await refresh(scheduler, [session(cwd)]); await scheduler.whenIdle();
  assert.equal(scheduler.project([session(cwd)])[0].reason, 'git-unavailable');
  await refresh(scheduler, [session(cwd)]); assert.equal(calls, 1);
  f.advance(LIMITS.retryMs); await refresh(scheduler, [session(cwd)]); await flush(); assert.equal(calls, 2);
  await refresh(scheduler, []); gate.resolve(); await scheduler.whenIdle();
  assert.deepEqual(scheduler.project([]), []);
  assert.doesNotMatch(JSON.stringify(scheduler.project([session(cwd)])), /private stderr/);
});
