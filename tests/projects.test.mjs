import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cloneFolderName,
  cloneProject,
  createProject,
  normalizeCloneUrl,
  resolveRepos,
  validateProjectName,
} from '../dist-electron/projects.js';

// createProject commits; give git an identity without touching global config.
for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) process.env[k] ??= 'AhaStudio Test';
for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) process.env[k] ??= 'test@example.com';

function tmp(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'aha-projects-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('clone URLs: owner/repo becomes a GitHub URL, full URLs pass, junk is rejected', () => {
  assert.equal(normalizeCloneUrl('AhakeyAI/ahastation'), 'https://github.com/AhakeyAI/ahastation.git');
  assert.equal(normalizeCloneUrl(' git@github.com:a/b.git '), 'git@github.com:a/b.git');
  assert.equal(normalizeCloneUrl('https://gitlab.com/a/b'), 'https://gitlab.com/a/b');
  assert.equal(normalizeCloneUrl('rm -rf /'), null);
  assert.equal(cloneFolderName('https://github.com/a/b.git'), 'b');
  assert.equal(cloneFolderName('git@github.com:a/my-repo.git'), 'my-repo');
});

test('project names cannot escape the parent folder', () => {
  assert.equal(validateProjectName('ok-name'), null);
  for (const bad of ['', '  ', 'a/b', 'a\\b', '.', '..']) assert.ok(validateProjectName(bad), bad);
});

test('create makes a git repo with an initial commit and refuses a non-empty folder', async (t) => {
  const parent = tmp(t);
  const res = await createProject({ parentPath: parent, name: 'demo', git: true });
  assert.deepEqual(res, { ok: true, path: join(parent, 'demo') });
  assert.equal(execFileSync('git', ['-C', res.path, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(), '1');

  mkdirSync(join(parent, 'busy'));
  writeFileSync(join(parent, 'busy', 'keep.txt'), 'x');
  const refused = await createProject({ parentPath: parent, name: 'busy', git: true });
  assert.equal(refused.ok, false);
  assert.ok(existsSync(join(parent, 'busy', 'keep.txt')));

  const plain = await createProject({ parentPath: parent, name: 'notes', git: false });
  assert.equal(plain.ok, true);
  assert.equal(existsSync(join(parent, 'notes', '.git')), false);
});

test('worktrees and sub-folders resolve to their main repository; another clone stays separate', async (t) => {
  const parent = tmp(t);
  const { path: main } = await createProject({ parentPath: parent, name: 'app', git: true });
  const wt = join(parent, 'app-wt');
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'feature-x', wt]);
  mkdirSync(join(main, 'pkg'));
  execFileSync('git', ['clone', '-q', main, join(parent, 'app-copy')]);
  const plain = join(parent, 'plain');
  mkdirSync(plain);

  const repos = await resolveRepos([main, wt, join(main, 'pkg'), join(parent, 'app-copy'), plain]);
  // Git expands Windows 8.3 aliases (RUNNER~1) as well as path separators.
  const canonical = (path) => realpathSync.native(path);
  assert.equal(canonical(repos[main].repoRoot), canonical(main));
  assert.equal(canonical(repos[wt].repoRoot), canonical(main));
  assert.equal(repos[wt].worktree, true);
  assert.equal(repos[wt].branch, 'feature-x');
  assert.equal(canonical(repos[join(main, 'pkg')].repoRoot), canonical(main));
  assert.equal(canonical(repos[join(parent, 'app-copy')].repoRoot), canonical(join(parent, 'app-copy')));
  assert.equal(repos[plain].repoRoot, null);
});

test('clone rejects addresses it cannot vet (local file URLs, bare paths) before running git', async (t) => {
  const parent = tmp(t);
  for (const url of [`file://${parent}`, parent, '../x']) {
    const res = await cloneProject({ url, parentPath: join(parent, 'clones') }, () => {});
    assert.equal(res.ok, false, url);
    assert.match(res.error, /地址/);
  }
  assert.equal(existsSync(join(parent, 'clones')), false);
});
