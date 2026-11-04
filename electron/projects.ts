// Project-room support for the launch lobby: which git repository a folder
// belongs to (rooms group a repo's main folder, sub-folders and worktrees),
// and creating a project room by cloning or from scratch.
//
// Create and clone follow Orca's add-repo flow (stablyai/orca,
// src/main/ipc/repos/repo-creation-handlers.ts and repo-clone-lifecycle.ts,
// MIT License, Copyright (c) 2026 Lovecast Inc.): reject names that escape the
// parent, allow an empty pre-existing folder, `git init` plus an empty initial
// commit so HEAD has a branch for worktrees, and `git clone --progress`.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { augmentedPath } from './backends/subprocess-backend.js';

export interface RepoInfo {
  /** Main repository folder (the one holding the shared .git), or null when not a git repo. */
  repoRoot: string | null;
  /** True when the folder is a linked worktree of repoRoot. */
  worktree: boolean;
  branch: string | null;
}

const GIT_TIMEOUT_MS = 4_000;
const cache = new Map<string, RepoInfo>();

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: augmentedPath(), GIT_TERMINAL_PROMPT: '0' };
}

function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile('git', args, { cwd, timeout, env: gitEnv(), windowsHide: true }, (error, stdout, stderr) => {
      res({ ok: !error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Read-only: `git rev-parse` only. Cached per folder for the app's lifetime. */
export async function resolveRepo(cwd: string): Promise<RepoInfo> {
  const hit = cache.get(cwd);
  if (hit) return hit;
  const r = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel', '--abbrev-ref', 'HEAD']);
  let info: RepoInfo = { repoRoot: null, worktree: false, branch: null };
  if (r.ok) {
    const [common, top, branch] = r.stdout.trim().split('\n');
    if (common && top) {
      // A bare or unusual common dir falls back to the worktree top-level.
      // git prints forward slashes on Windows; rooms key on the native form.
      const root = resolve(basename(common) === '.git' ? dirname(common) : top);
      info = { repoRoot: root, worktree: resolve(root) !== resolve(top), branch: branch && branch !== 'HEAD' ? branch : null };
    }
  }
  cache.set(cwd, info);
  return info;
}

export async function resolveRepos(cwds: string[]): Promise<Record<string, RepoInfo>> {
  const out: Record<string, RepoInfo> = {};
  const queue = [...new Set(cwds)];
  // Small pool: a first lobby scan can carry dozens of folders.
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
    for (let cwd = queue.shift(); cwd !== undefined; cwd = queue.shift()) {
      out[cwd] = await resolveRepo(cwd);
    }
  }));
  return out;
}

// ---- create ---------------------------------------------------------------

export function defaultProjectParent(recent: string[] = []): string {
  const last = recent.find((p) => isAbsolute(p));
  return last ? dirname(last) : join(homedir(), 'AhaStudio');
}

export function validateProjectName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return '名称不能为空';
  if (/[\\/]/.test(trimmed) || trimmed === '.' || trimmed === '..') return '名称不能包含 / 或 \\，也不能是 . 或 ..';
  return null;
}

async function isEmptyDir(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function createProject(args: { parentPath: string; name: string; git: boolean }): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const invalid = validateProjectName(args.name);
  if (invalid) return { ok: false, error: invalid };
  const parent = args.parentPath.trim();
  if (!parent || !isAbsolute(parent)) return { ok: false, error: '位置必须是完整路径' };
  const target = join(parent, args.name.trim());
  let createdDir = false;
  await mkdir(parent, { recursive: true });
  if (await exists(target)) {
    // An empty folder made in Finder first is fine; a non-empty one is never overwritten.
    if (!(await isEmptyDir(target))) return { ok: false, error: `${target} 已存在且不是空文件夹` };
  } else {
    await mkdir(target);
    createdDir = true;
  }
  if (args.git) {
    const init = await git(target, ['init']);
    const commit = init.ok ? await git(target, ['commit', '--allow-empty', '-m', 'Initial commit']) : null;
    if (!init.ok || !commit?.ok) {
      if (createdDir) await rm(target, { recursive: true, force: true }).catch(() => {});
      else await rm(join(target, '.git'), { recursive: true, force: true }).catch(() => {});
      const message = (commit?.stderr || init.stderr).trim();
      if (/Please tell me who you are|user\.name|user\.email/i.test(message)) {
        return { ok: false, error: '还没有配置 Git 作者身份。先在终端运行 git config --global user.name "你的名字" 和 git config --global user.email "you@example.com"，再重试。' };
      }
      return { ok: false, error: `${init.ok ? '初始提交' : '初始化 git 仓库'}失败：${message || '未知错误'}` };
    }
  }
  cache.delete(target);
  return { ok: true, path: target };
}

// ---- clone ----------------------------------------------------------------

/** `owner/repo` → GitHub https URL; full URLs (https, ssh, git@) pass through. */
export function normalizeCloneUrl(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  // GitHub owner and repo names start with a letter or digit, so `../x` never becomes a URL.
  if (/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(value)) return `https://github.com/${value.replace(/\.git$/, '')}.git`;
  if (/^(https?:\/\/|ssh:\/\/|git@[\w.-]+:)/.test(value)) return value;
  return null;
}

/** Folder name git would pick: the last path segment without `.git`. */
export function cloneFolderName(url: string): string {
  const last = url.replace(/[\\/]+$/, '').split(/[\\/:]/).pop() ?? 'repo';
  return last.replace(/\.git$/, '') || 'repo';
}

let activeClone: { child: ChildProcess; target: string } | null = null;

export async function cloneProject(
  args: { url: string; parentPath: string },
  onProgress: (line: string) => void,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const url = normalizeCloneUrl(args.url);
  if (!url) return { ok: false, error: '地址看不懂。粘贴 https 或 git@ 开头的地址，或者写成 owner/repo。' };
  const parent = args.parentPath.trim();
  if (!parent || !isAbsolute(parent)) return { ok: false, error: '位置必须是完整路径' };
  if (activeClone) return { ok: false, error: '已经有一个克隆在进行' };
  const target = join(parent, cloneFolderName(url));
  if (await exists(target) && !(await isEmptyDir(target))) return { ok: false, error: `${target} 已存在且不是空文件夹` };
  await mkdir(parent, { recursive: true });
  return new Promise((res) => {
    const child = spawn('git', ['clone', '--progress', '--', url, target], { cwd: parent, env: gitEnv(), windowsHide: true });
    activeClone = { child, target };
    let tail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-4000);
      // git rewrites progress in place with \r.
      for (const line of text.split(/[\r\n]+/)) if (line.trim()) onProgress(line.trim());
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      activeClone = null;
      res({ ok: false, error: error.code === 'ENOENT' ? '没有找到 git，先安装 Git 再重试' : error.message });
    });
    child.on('close', (code, signal) => {
      const aborted = activeClone?.child !== child || signal !== null;
      activeClone = null;
      if (code === 0 && !aborted) {
        cache.delete(target);
        res({ ok: true, path: target });
        return;
      }
      void rm(target, { recursive: true, force: true }).catch(() => {});
      if (aborted) { res({ ok: false, error: '已取消克隆' }); return; }
      const reason = /Authentication failed|could not read Username|Permission denied/i.test(tail)
        ? '没有权限访问这个仓库。私有仓库需要先在终端里登录（gh auth login 或配置 SSH key）。'
        : /not found|does not exist/i.test(tail)
          ? '找不到这个仓库，检查地址是否正确。'
          : `克隆失败：${tail.trim().split('\n').pop() ?? '未知错误'}`;
      res({ ok: false, error: reason });
    });
  });
}

export function abortClone(): void {
  const current = activeClone;
  activeClone = null;
  current?.child.kill('SIGTERM');
}

// ---- GitHub (read-only status; Issue creation only after user confirmation) ----

function gh(cwd: string, args: string[], timeout = 15_000): Promise<{ ok: boolean; stdout: string; stderr: string; missing: boolean }> {
  return new Promise((res) => {
    execFile('gh', args, { cwd, timeout, env: gitEnv(), windowsHide: true }, (error, stdout, stderr) => {
      res({ ok: !error, stdout: String(stdout), stderr: String(stderr), missing: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' });
    });
  });
}

export interface GithubStatus {
  /** origin points at github.com. */
  github: boolean;
  /** gh CLI installed and could query the repo. */
  queried: boolean;
  openIssues: number | null;
  openPrs: number | null;
}

/** Read-only: does this project already have open Issues / PRs? Unknown stays null (never counted as empty). */
export async function githubStatus(cwd: string): Promise<GithubStatus> {
  const remote = await git(cwd, ['config', '--get', 'remote.origin.url']);
  const github = remote.ok && /github\.com[:/]/.test(remote.stdout);
  if (!github) return { github: false, queried: false, openIssues: null, openPrs: null };
  const count = async (kind: 'issue' | 'pr'): Promise<number | null> => {
    const r = await gh(cwd, [kind, 'list', '--state', 'open', '--limit', '1', '--json', 'number']);
    if (!r.ok) return null;
    try { return (JSON.parse(r.stdout) as unknown[]).length; } catch { return null; }
  };
  const [openIssues, openPrs] = await Promise.all([count('issue'), count('pr')]);
  return { github, queried: openIssues !== null || openPrs !== null, openIssues, openPrs };
}

/** External write: runs only from the board's confirmation dialog with the box ticked (AME-D08 / Q12). */
export async function createGithubIssue(cwd: string, title: string, body: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const r = await gh(cwd, ['issue', 'create', '--title', title, '--body', body], 30_000);
  if (r.ok) return { ok: true, url: r.stdout.trim().split('\n').pop() ?? '' };
  if (r.missing) return { ok: false, error: '没有找到 gh 命令，先安装 GitHub CLI 并运行 gh auth login' };
  return { ok: false, error: r.stderr.trim().split('\n').pop() || '创建 Issue 失败' };
}
