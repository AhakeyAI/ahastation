import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { maybeAppendGitignore } from '../dist-electron/attachments/workspace.js';

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aha-ignore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'AhaStudio Test');
  writeFileSync(join(dir, 'README.md'), 'x\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return { dir, git };
}

test('app scratch dirs are ignored through .git/info/exclude, leaving the tree clean', async (t) => {
  const { dir, git } = repo(t);
  await maybeAppendGitignore(dir, '.vibe-minutes');
  mkdirSync(join(dir, '.vibe-minutes'));
  writeFileSync(join(dir, '.vibe-minutes', 'm.md'), 'minutes\n');

  assert.equal(existsSync(join(dir, '.gitignore')), false);
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '');
  assert.match(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\.vibe-minutes\/$/m);
});

test('the exclude entry is written once and resolves through a linked worktree', async (t) => {
  const { dir, git } = repo(t);
  const wt = `${dir}-wt`;
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  git('worktree', 'add', '-q', wt);
  await maybeAppendGitignore(wt, '.vibe-assets');
  await maybeAppendGitignore(wt, '.vibe-assets');
  const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.match(/^\.vibe-assets\/$/gm)?.length, 1);
  assert.equal(existsSync(join(wt, '.gitignore')), false);
});
