// project-cleanup.test.mjs — 项目室「结束会话并删除分支」 planning and
// execution against a fake git runner and a fake observed snapshot.

import assert from 'node:assert/strict';
import test from 'node:test';
import { join, resolve } from 'node:path';

import {
  parseWorktreePorcelain,
  planProjectCleanup,
  runProjectCleanup,
} from '../dist-electron/project-cleanup.js';

const ROOT = resolve('/repo/app');
const CLEAN = resolve('/repo/wt-clean');
const DIRTY = resolve('/repo/wt-dirty');
const LOCKED = resolve('/repo/wt-locked');
const PORCELAIN = [
  `worktree ${ROOT}`, 'HEAD aaa', 'branch refs/heads/main', '',
  `worktree ${CLEAN}`, 'HEAD bbb', 'branch refs/heads/agent/clean', '',
  `worktree ${DIRTY}`, 'HEAD ccc', 'branch refs/heads/agent/dirty', '',
  `worktree ${LOCKED}`, 'HEAD ddd', 'branch refs/heads/agent/locked', 'locked', '',
].join('\n');

function fakeGit(calls) {
  return async (cwd, args) => {
    calls.push([cwd, ...args]);
    const cmd = args.join(' ');
    if (cmd === 'worktree list --porcelain') return { ok: true, stdout: PORCELAIN, stderr: '' };
    if (cmd === 'status --porcelain') return { ok: true, stdout: cwd === DIRTY ? ' M a.ts\n' : '', stderr: '' };
    if (cmd.startsWith('rev-list --count main..')) return { ok: true, stdout: cmd.endsWith('agent/clean') ? '0\n' : '3\n', stderr: '' };
    if (cmd.startsWith('worktree remove') || cmd.startsWith('branch -D')) return { ok: true, stdout: '', stderr: '' };
    return { ok: false, stdout: '', stderr: `unexpected ${cmd}` };
  };
}

function session(id, cwd, extra = {}) {
  return { id, clientKind: 'claude-code', nativeSessionId: id, projectId: 'p', projectName: 'app', cwd, title: id,
    state: 'active', activity: 'idle', inferred: true, lastActiveAt: 1, titleSource: 'native', isNoise: false, evidence: [], ...extra };
}

const SNAPSHOT = {
  scannedAt: 1,
  sessions: [
    session('term-main', ROOT, { pid: 4001, tty: 's001' }),
    session('term-wt', join(CLEAN, 'src'), { pid: 4002, tty: 's002' }),
    session('desktop', ROOT, { pid: 4003 }),
    session('elsewhere', resolve('/other/project'), { pid: 4004, tty: 's004' }),
  ],
};

test('parseWorktreePorcelain reads branches and lock state', () => {
  const rows = parseWorktreePorcelain(PORCELAIN);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.branch), ['main', 'agent/clean', 'agent/dirty', 'agent/locked']);
  assert.equal(rows[3].locked, true);
});

test('plan lists only this repo, flags desktop sessions and risky worktrees', async () => {
  const res = await planProjectCleanup(ROOT, SNAPSHOT, { git: fakeGit([]) });
  assert.equal(res.ok, true);
  const { plan } = res;
  assert.equal(plan.baseBranch, 'main');
  assert.deepEqual(plan.sessions.map((s) => s.id).sort(), ['desktop', 'term-main', 'term-wt']);
  assert.equal(plan.sessions.find((s) => s.id === 'desktop').closable, false);
  assert.equal(plan.sessions.find((s) => s.id === 'term-wt').place, 'agent/clean');
  assert.deepEqual(plan.worktrees.map((w) => w.path), [CLEAN, DIRTY, LOCKED]);
  const dirty = plan.worktrees.find((w) => w.branch === 'agent/dirty');
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.unmerged, 3);
  assert.equal(plan.worktrees.find((w) => w.branch === 'agent/clean').unmerged, 0);
});

test('cleanup ends only tty sessions and never touches the main folder', async () => {
  const calls = [];
  const killed = [];
  const res = await runProjectCleanup(
    { repoRoot: ROOT, sessionIds: ['term-main', 'desktop', 'elsewhere'], worktreePaths: [CLEAN, ROOT, LOCKED] },
    SNAPSHOT,
    { git: fakeGit(calls), kill: (pid) => killed.push(pid), sleep: async () => {} },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(killed, [4001]);
  const byId = Object.fromEntries(res.result.sessions.map((r) => [r.id, r.ok]));
  assert.deepEqual(byId, { 'term-main': true, desktop: false, elsewhere: false });
  const wt = Object.fromEntries(res.result.worktrees.map((r) => [r.id, r.ok]));
  assert.deepEqual(wt, { [CLEAN]: true, [ROOT]: false, [LOCKED]: false });
  const mutations = calls.filter(([, a]) => a === 'worktree' || a === 'branch').map((c) => c.slice(1).join(' '));
  assert.ok(mutations.includes(`worktree remove --force ${CLEAN}`));
  assert.ok(mutations.includes('branch -D agent/clean'));
  assert.ok(!mutations.some((m) => m.includes('branch -D main') || m.endsWith(` ${ROOT}`)));
});

test('a folder that is not the repository main folder is refused', async () => {
  const res = await planProjectCleanup(CLEAN, SNAPSHOT, { git: fakeGit([]) });
  assert.equal(res.ok, false);
});
