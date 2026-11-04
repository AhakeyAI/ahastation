import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { discoverProject, groupProjectCandidates, normalizeGithubRepository } from '../dist-electron/observe/project-discovery.js';

const ORIGIN = 'https://github.com/example/team.git';
function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.name=Discovery Test', '-c', 'user.email=discovery@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
  { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function fixture(t) {
  const root = realpathSync.native(await fs.mkdtemp(join(tmpdir(), 'aha-discovery-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const init = async (name, remote = ORIGIN, extra = []) => {
    const cwd = join(root, name); await fs.mkdir(cwd, { recursive: true });
    git(cwd, ['init', '-b', 'main', ...extra]);
    await fs.writeFile(join(cwd, 'file.txt'), `Initial ${name}\n`);
    git(cwd, ['add', 'file.txt']); git(cwd, ['commit', '-m', `Initial ${name}`]);
    if (remote) git(cwd, ['remote', 'add', 'origin', remote]);
    return cwd;
  };
  const options = { getAccess: () => ({ enabled: true, roots: [root] }), isCurrent: () => true };
  return { root, init, options, probe: (cwd, extra = {}) => discoverProject(cwd, { ...options, ...extra }) };
}
function candidate(value) { assert.equal(value.status, 'candidate', JSON.stringify(value)); return value; }
const hash = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');

test('GitHub transports normalize to one identity without credentials; ambiguous URLs stay unresolved', () => {
  const expected = { provider: 'github', owner: 'example', repo: 'team' };
  for (const url of [ORIGIN, 'git@github.com:Example/Team.git', 'ssh://git@github.com/EXAMPLE/TEAM.git/',
    'https://test-user:test-secret@github.com/Example/Team.git', 'https://github.com:443/Example/Team']) {
    assert.deepEqual(normalizeGithubRepository(url), expected);
  }
  for (const url of ['https://github.com/example/../team', 'https://github.com/example/a/../team',
    'https://github.com/example/%74eam', 'git@my-gh:example/team.git', 'https://gitlab.com/example/team',
    'https://github.com/example/team?token=secret', 'https://github.com/example/team#ref',
    'https://github.com:8443/example/team', 'ssh://alice@github.com/example/team',
    'file:///example/team', 'https://github.com/example/team\nextra', 'https://github.com/example/team/extra']) {
    assert.equal(normalizeGithubRepository(url), null, url);
  }
});

test('real clone, linked worktree and subdirectory group together, keeping distinct mounts and branches', async (t) => {
  const f = await fixture(t); const main = await f.init('main');
  const linked = join(f.root, 'linked'), clone = join(f.root, 'clone'), sub = join(main, 'src');
  await fs.mkdir(sub);
  git(main, ['worktree', 'add', '-b', 'feature', linked]);
  git(f.root, ['clone', '--no-local', main, clone]); git(clone, ['remote', 'set-url', 'origin', 'git@github.com:Example/Team.git']);
  const results = await Promise.all([main, linked, clone, sub].map((cwd) => f.probe(cwd)));
  results.forEach(candidate);
  assert.deepEqual(results.map((r) => r.branch), ['main', 'feature', 'main', 'main']);
  assert.equal(results[0].gitCommonDir, results[1].gitCommonDir);
  assert.notEqual(results[0].gitCommonDir, results[2].gitCommonDir);
  const groups = groupProjectCandidates(results);
  assert.equal(groups.length, 1); assert.equal(groups[0].mounts.length, 3);
  assert.equal(groups[0].repositoryIdentity.initialCommit, git(main, ['rev-list', '--max-parents=0', 'HEAD']));
  assert.equal('projectId' in groups[0], false);
});

test('fork origin wins over upstream; no-origin namespace never swallows a remote project', async (t) => {
  const f = await fixture(t); const main = await f.init('main');
  const before = candidate(await f.probe(main));
  git(main, ['remote', 'set-url', 'origin', 'ssh://git@github.com/another/team.git']);
  git(main, ['remote', 'add', 'upstream', ORIGIN]);
  const fork = candidate(await f.probe(main));
  git(main, ['remote', 'remove', 'origin']); const noOrigin = candidate(await f.probe(main));
  assert.equal(fork.repositoryIdentity.owner, 'another');
  assert.equal(noOrigin.repositoryIdentity.provider, 'none');
  assert.equal(groupProjectCandidates([before, fork, noOrigin]).length, 3);
});

test('same remote with rebuilt history does not auto-merge; unsupported origins never fall back to local', async (t) => {
  const f = await fixture(t); const a = await f.init('a'), b = await f.init('b');
  assert.equal(groupProjectCandidates([await f.probe(a), await f.probe(b)]).length, 2);
  git(b, ['remote', 'set-url', 'origin', 'git@private-alias:example/team']);
  assert.deepEqual(await f.probe(b), { status: 'unresolved', reason: 'unsupported-remote' });
  git(a, ['config', '--add', 'remote.origin.url', 'https://github.com/another/team']);
  assert.equal((await f.probe(a)).reason, 'unsupported-remote');
});

test('moving a repo and switching/detaching branches keep its root identity, without stale lifetime cache', async (t) => {
  const f = await fixture(t); const repo = await f.init('repo'), moved = join(f.root, 'moved');
  const a = candidate(await f.probe(repo));
  git(repo, ['checkout', '-b', 'new-branch']);
  assert.equal(candidate(await f.probe(repo)).branch, 'new-branch');
  git(repo, ['checkout', '--detach']);
  assert.equal(candidate(await f.probe(repo)).branch, null);
  await fs.rename(repo, moved);
  const b = candidate(await f.probe(moved));
  assert.deepEqual(a.repositoryIdentity, b.repositoryIdentity);
  assert.notEqual(a.worktreeRoot, b.worktreeRoot);
});

test('shallow boundary, unborn HEAD and unrelated roots never become initialCommit', async (t) => {
  const f = await fixture(t); const repo = await f.init('repo');
  git(repo, ['commit', '--allow-empty', '-m', 'Second']);
  const shallow = join(f.root, 'shallow');
  git(f.root, ['-c', 'protocol.file.allow=always', 'clone', '--depth=1', pathToFileURL(repo).href, shallow]);
  assert.equal((await f.probe(shallow)).reason, 'shallow');
  const empty = join(f.root, 'empty'); await fs.mkdir(empty); git(empty, ['init', '-b', 'main']);
  assert.equal((await f.probe(empty)).reason, 'no-commit');
  git(repo, ['checkout', '--orphan', 'unrelated']); git(repo, ['commit', '--allow-empty', '-m', 'Other root']);
  git(repo, ['merge', '--allow-unrelated-histories', '-s', 'ours', 'main', '-m', 'Two roots']);
  assert.equal((await f.probe(repo)).reason, 'multiple-roots');
});

test('nested independent repos and submodules retain their own repository evidence', async (t) => {
  const f = await fixture(t); const parent = await f.init('parent');
  const nested = await f.init('parent/nested', 'https://github.com/example/nested');
  const source = await f.init('submodule-source', 'https://github.com/example/submodule');
  git(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'sub']);
  const sub = join(parent, 'sub'); git(sub, ['remote', 'set-url', 'origin', 'https://github.com/example/submodule']);
  const probes = await Promise.all([parent, nested, sub].map((cwd) => f.probe(cwd)));
  probes.forEach(candidate);
  assert.equal(probes[2].worktreeRoot, sub);
  assert.equal(groupProjectCandidates(probes).length, 3);
});

test('SHA-256 repositories preserve the complete 64-digit initial OID and object format', async (t) => {
  const f = await fixture(t); const repo = await f.init('sha256', ORIGIN, ['--object-format=sha256']);
  const result = candidate(await f.probe(repo));
  assert.equal(result.repositoryIdentity.objectFormat, 'sha256');
  assert.match(result.repositoryIdentity.initialCommit, /^[0-9a-f]{64}$/);
});

test('missing history objects stay unresolved, without fetching or inventing a root', async (t) => {
  const f = await fixture(t); const repo = await f.init('missing-object');
  const root = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['commit', '--allow-empty', '-m', 'Second']);
  await fs.rm(join(repo, '.git', 'objects', root.slice(0, 2), root.slice(2)));
  assert.deepEqual(await f.probe(repo), { status: 'unresolved', reason: 'git-unavailable' });
});

test('replace refs and legacy grafts cannot turn a later HEAD into the repository root', async (t) => {
  const f = await fixture(t); const repo = await f.init('replacement');
  const root = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['commit', '--allow-empty', '-m', 'Second']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['replace', '--graft', 'HEAD']);
  assert.equal(git(repo, ['rev-list', '--max-parents=0', 'HEAD']), head);
  assert.equal(candidate(await f.probe(repo)).repositoryIdentity.initialCommit, root);
  git(repo, ['replace', '-d', head]);
  await fs.writeFile(join(repo, '.git', 'info', 'grafts'), head + '\n');
  assert.equal(candidate(await f.probe(repo)).repositoryIdentity.initialCommit, root);
});

test('probing leaves native Git metadata, index and project files byte-for-byte unchanged', async (t) => {
  const f = await fixture(t); const repo = await f.init('readonly');
  const files = ['.git/config', '.git/HEAD', '.git/index', '.git/refs/heads/main', 'file.txt'].map((p) => join(repo, p));
  const before = await Promise.all(files.map(hash));
  candidate(await f.probe(repo));
  assert.deepEqual(await Promise.all(files.map(hash)), before);
  assert.equal((await fs.readdir(repo)).includes('.ahastudio'), false);
});

test('scan authorization is mandatory; neither subfolder nor linked worktree grants authorize external Git metadata', async (t) => {
  const f = await fixture(t); const repo = await f.init('repo'); let calls = 0;
  const denied = await f.probe(repo, { getAccess: () => ({ enabled: false, roots: [] }),
    git: async () => { calls++; throw new Error('must not run'); } });
  assert.equal(denied.status, 'denied'); assert.equal(calls, 0);
  const sub = join(repo, 'src'); await fs.mkdir(sub);
  assert.equal((await f.probe(sub, { getAccess: () => ({ enabled: true, roots: [sub] }) })).reason, 'metadata-outside-grant');
  const linked = join(f.root, 'linked'); git(repo, ['worktree', 'add', '-b', 'feature', linked]);
  assert.equal((await f.probe(linked, { getAccess: () => ({ enabled: true, roots: [linked] }) })).reason, 'metadata-outside-grant');
});

test('revocation and revoke/regrant invalidate an in-flight result before any further query', async (t) => {
  const f = await fixture(t); const repo = await f.init('repo'); let generation = 0, calls = 0;
  const result = await f.probe(repo, { isCurrent: () => generation === 0, git: async () => {
    calls++; generation++; return { code: 0, stdout: 'not used', stderr: '' };
  } });
  assert.deepEqual(result, { status: 'denied', reason: 'not-authorized' }); assert.equal(calls, 1);
  let access = f.options.getAccess();
  const revoked = await f.probe(repo, { getAccess: () => access, git: async () => {
    access = { enabled: false, roots: [] }; return { code: 0, stdout: 'not used', stderr: '' };
  } });
  assert.equal(revoked.status, 'denied');
});

test('a grant directory replaced by a symlink cannot authorize the new target', async (t) => {
  const f = await fixture(t); const target = await f.init('target'), grant = join(f.root, 'grant');
  await fs.symlink(target, grant, process.platform === 'win32' ? 'junction' : 'dir');
  let calls = 0;
  const result = await f.probe(grant, { getAccess: () => ({ enabled: true, roots: [grant] }),
    git: async () => { calls++; throw new Error('must not run'); } });
  assert.equal(result.status, 'denied'); assert.equal(calls, 0);
});

test('Git command failure or unavailable executable cannot leak raw stderr or create a candidate', async (t) => {
  const f = await fixture(t); const repo = await f.init('repo');
  const result = await f.probe(repo, { git: async () => ({ code: null, stdout: '', stderr: 'secret credential and private path' }) });
  assert.deepEqual(result, { status: 'unresolved', reason: 'git-unavailable' });
  const plain = join(f.root, 'plain'); await fs.mkdir(plain);
  assert.deepEqual(await f.probe(plain), { status: 'non-git', reason: 'not-git' });
});

test('origin changes during a probe are detected rather than combining identity generations', async (t) => {
  const f = await fixture(t); const repo = await f.init('repo');
  const result = await f.probe(repo, { git: async (cwd, args) => {
    let stdout;
    try { stdout = git(cwd, args) + '\n'; }
    catch (error) { return { code: error.status, stdout: String(error.stdout), stderr: String(error.stderr) }; }
    if (args[0] === 'rev-list') git(cwd, ['remote', 'set-url', 'origin', 'https://github.com/another/team']);
    return { code: 0, stdout, stderr: '' };
  } });
  assert.equal(result.reason, 'changed-during-probe');
});

test('inherited Git routing/config overrides cannot substitute a different repository', async (t) => {
  const f = await fixture(t); const a = await f.init('a'), b = await f.init('b');
  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
  const saved = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }));
  const expected = git(a, ['rev-list', '--max-parents=0', 'HEAD']);
  Object.assign(process.env, { GIT_DIR: join(b, '.git'), GIT_WORK_TREE: b, GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'remote.origin.url', GIT_CONFIG_VALUE_0: 'https://github.com/wrong/repo' });
  const result = candidate(await f.probe(a));
  assert.equal(result.repositoryIdentity.initialCommit, expected);
  assert.equal(result.repositoryIdentity.owner, 'example');
  assert.equal(result.worktreeRoot, a);
});
