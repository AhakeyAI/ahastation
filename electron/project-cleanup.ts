// project-cleanup.ts — 项目室「结束会话并删除分支」. Lists a repository's
// observed AI sessions and linked git worktrees, then ends the chosen
// terminal sessions and removes the chosen worktrees with their branches.
//
// Everything the renderer asks for is re-derived here from git and the
// observed snapshot: only sessions inside the repository that own a terminal
// (tty) can be signalled, and only linked worktrees can be removed — the main
// folder and its checked-out branch are never touched.

import { execFile } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { augmentedPath } from './backends/subprocess-backend.js';
import type { ObservedSession, ObservedSnapshot } from './observe/types.js';

const GIT_TIMEOUT_MS = 15_000;
/** Give ended CLIs a moment to let go of their worktree before removal. */
const SESSION_EXIT_GRACE_MS = 800;

export type GitRunner = (cwd: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export interface CleanupDeps {
  git?: GitRunner;
  kill?: (pid: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface CleanupSession {
  id: string;
  clientKind: ObservedSession['clientKind'];
  title: string;
  /** Worktree branch or sub-folder; null for the main folder. */
  place: string | null;
  closable: boolean;
  /** Why it can't be ended from here (desktop-owned, no process). */
  reason?: string;
}

export interface CleanupWorktree {
  path: string;
  branch: string | null;
  /** Uncommitted or untracked changes. */
  dirty: boolean;
  /** Commits on the branch that the main branch doesn't have; null if unknown. */
  unmerged: number | null;
  locked: boolean;
}

export interface CleanupPlan {
  repoRoot: string;
  git: boolean;
  baseBranch: string | null;
  sessions: CleanupSession[];
  worktrees: CleanupWorktree[];
}

export interface CleanupItemResult { id: string; ok: boolean; error?: string }
export interface CleanupResult { sessions: CleanupItemResult[]; worktrees: CleanupItemResult[] }

const defaultGit: GitRunner = (cwd, args) => new Promise((res) => {
  execFile('git', args, {
    cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true,
    env: { ...process.env, PATH: augmentedPath(), GIT_TERMINAL_PROMPT: '0' },
  }, (error, stdout, stderr) => res({ ok: !error, stdout: String(stdout), stderr: String(stderr) }));
});

function normalize(path: string): string {
  const abs = resolve(path);
  return abs.length > 1 && abs.endsWith(sep) ? abs.slice(0, -1) : abs;
}

function inside(path: string, root: string): boolean {
  const p = normalize(path);
  return p === root || p.startsWith(root + sep);
}

interface PorcelainWorktree { path: string; branch: string | null; bare: boolean; locked: boolean }

export function parseWorktreePorcelain(stdout: string): PorcelainWorktree[] {
  const out: PorcelainWorktree[] = [];
  let cur: PorcelainWorktree | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), branch: null, bare: false, locked: false };
      out.push(cur);
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (cur && line === 'bare') {
      cur.bare = true;
    } else if (cur && (line === 'locked' || line.startsWith('locked '))) {
      cur.locked = true;
    }
  }
  return out;
}

export async function planProjectCleanup(
  rawRoot: string,
  snapshot: ObservedSnapshot,
  deps: CleanupDeps = {},
): Promise<{ ok: true; plan: CleanupPlan } | { ok: false; error: string }> {
  const git = deps.git ?? defaultGit;
  const root = normalize(rawRoot);
  const list = await git(root, ['worktree', 'list', '--porcelain']);
  const entries = list.ok ? parseWorktreePorcelain(list.stdout) : [];
  const isRepo = entries.length > 0 && normalize(entries[0].path) === root;
  if (list.ok && entries.length > 0 && !isRepo) {
    return { ok: false, error: '这个文件夹不是仓库主目录，请从仓库主目录的项目室操作。' };
  }
  const main = isRepo ? entries[0] : null;
  const linked = isRepo ? entries.slice(1).filter((w) => !w.bare) : [];

  const worktrees: CleanupWorktree[] = [];
  for (const w of linked) {
    const status = await git(w.path, ['status', '--porcelain']);
    let unmerged: number | null = null;
    if (w.branch && main?.branch) {
      const count = await git(root, ['rev-list', '--count', `${main.branch}..${w.branch}`]);
      if (count.ok) unmerged = Number.parseInt(count.stdout.trim(), 10) || 0;
    }
    worktrees.push({
      path: normalize(w.path),
      branch: w.branch,
      dirty: !status.ok || status.stdout.trim().length > 0,
      unmerged,
      locked: w.locked,
    });
  }

  const placeFor = (cwd: string): string | null => {
    const wt = worktrees.find((w) => inside(cwd, w.path));
    if (wt) return wt.branch ?? wt.path.split(sep).at(-1) ?? wt.path;
    const p = normalize(cwd);
    return p === root ? null : p.slice(root.length + 1);
  };
  const sessions: CleanupSession[] = snapshot.sessions
    .filter((s) => !s.isNoise && s.cwd && (inside(s.cwd, root) || worktrees.some((w) => inside(s.cwd, w.path))))
    .map((s) => {
      const closable = typeof s.pid === 'number' && s.pid > 1 && !!s.tty && s.tty !== '??';
      return {
        id: s.id,
        clientKind: s.clientKind,
        title: s.title,
        place: placeFor(s.cwd),
        closable,
        ...(closable ? {} : { reason: s.pid ? '属于桌面 App，请在 App 里关闭' : '已经没有运行中的进程' }),
      };
    });

  return { ok: true, plan: { repoRoot: root, git: isRepo, baseBranch: main?.branch ?? null, sessions, worktrees } };
}

export async function runProjectCleanup(
  input: { repoRoot: string; sessionIds: string[]; worktreePaths: string[] },
  snapshot: ObservedSnapshot,
  deps: CleanupDeps = {},
): Promise<{ ok: true; result: CleanupResult } | { ok: false; error: string }> {
  const git = deps.git ?? defaultGit;
  const kill = deps.kill ?? ((pid: number) => { process.kill(pid, 'SIGTERM'); });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const planned = await planProjectCleanup(input.repoRoot, snapshot, deps);
  if (!planned.ok) return planned;
  const { plan } = planned;

  const sessions: CleanupItemResult[] = [];
  for (const id of input.sessionIds) {
    const row = plan.sessions.find((s) => s.id === id);
    const live = snapshot.sessions.find((s) => s.id === id);
    if (!row || !live) { sessions.push({ id, ok: false, error: '会话不在这个项目里' }); continue; }
    if (!row.closable || !live.pid) { sessions.push({ id, ok: false, error: row.reason ?? '不能从这里结束' }); continue; }
    try {
      kill(live.pid);
      sessions.push({ id, ok: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Already gone counts as ended.
      sessions.push(code === 'ESRCH' ? { id, ok: true } : { id, ok: false, error: String((err as Error).message ?? err) });
    }
  }
  if (sessions.some((s) => s.ok) && input.worktreePaths.length) await sleep(SESSION_EXIT_GRACE_MS);

  const worktrees: CleanupItemResult[] = [];
  for (const rawPath of input.worktreePaths) {
    const path = normalize(rawPath);
    const wt = plan.worktrees.find((w) => w.path === path);
    if (!wt) { worktrees.push({ id: rawPath, ok: false, error: '不是这个仓库的工作树' }); continue; }
    if (wt.locked) { worktrees.push({ id: rawPath, ok: false, error: '工作树已锁定，请先 git worktree unlock' }); continue; }
    const removed = await git(plan.repoRoot, ['worktree', 'remove', '--force', wt.path]);
    if (!removed.ok) { worktrees.push({ id: rawPath, ok: false, error: removed.stderr.trim() || '删除工作树失败' }); continue; }
    if (wt.branch && wt.branch !== plan.baseBranch) {
      const branch = await git(plan.repoRoot, ['branch', '-D', wt.branch]);
      if (!branch.ok) { worktrees.push({ id: rawPath, ok: false, error: `工作树已删除，分支没删掉：${branch.stderr.trim()}` }); continue; }
    }
    worktrees.push({ id: rawPath, ok: true });
  }
  return { ok: true, result: { sessions, worktrees } };
}
