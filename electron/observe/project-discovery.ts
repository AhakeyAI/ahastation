// IF-3 local evidence only. This module creates neither project IDs nor grants,
// and does not modify the existing path-keyed project/history stores.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { devNull } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { augmentedPath } from '../backends/subprocess-backend.js';
import { canReadProject, withinDirectory, type ScanAccess } from './scan-access.js';

export interface GithubRepository { provider: 'github'; owner: string; repo: string }
export type RepositoryCandidate = (GithubRepository | { provider: 'none' }) & {
  initialCommit: string;
  objectFormat: 'sha1' | 'sha256';
};
export interface GitProjectCandidate {
  status: 'candidate';
  cwd: string;
  worktreeRoot: string;
  gitCommonDir: string;
  branch: string | null;
  repositoryIdentity: RepositoryCandidate;
  /** Local cache validation only; never an identity or a wire field. */
  fingerprint: string;
}
export type ProjectDiscovery = GitProjectCandidate | {
  status: 'denied' | 'unresolved' | 'non-git';
  reason: 'not-authorized' | 'not-git' | 'git-unavailable' | 'invalid-metadata'
    | 'metadata-outside-grant' | 'shallow' | 'no-commit' | 'multiple-roots'
    | 'unsupported-remote' | 'changed-during-probe';
};
interface GitResult { code: number | null; stdout: string; stderr: string }
export type DiscoveryGit = (cwd: string, args: string[]) => Promise<GitResult>;
export interface ProjectDiscoveryOptions {
  getAccess: () => ScanAccess;
  /** Caller generation check: revoke then re-grant must invalidate old work. */
  isCurrent: () => boolean;
  git?: DiscoveryGit;
  realpath?: (path: string) => Promise<string>;
}

/** Only recognized GitHub transports. Never return credentials or URL suffixes. */
export function normalizeGithubRepository(raw: string): GithubRepository | null {
  const value = raw.trim();
  if (!value || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  let path: string;
  const scp = /^git@github\.com:(.+)$/i.exec(value);
  if (scp) path = scp[1];
  else {
    try {
      const url = new URL(value);
      if (url.hostname.toLowerCase() !== 'github.com' || url.search || url.hash) return null;
      if (url.protocol === 'https:') {
        if (url.port && url.port !== '443') return null;
      } else if (url.protocol === 'ssh:') {
        if (url.username !== 'git' || url.password || (url.port && url.port !== '22')) return null;
      } else return null;
      // Inspect the raw path too: URL normalizes dot segments before pathname.
      const rawPath = value.match(/^[^:]+:\/\/[^/]+(\/.*)$/)?.[1];
      if (!rawPath || rawPath !== url.pathname) return null;
      path = url.pathname.slice(1);
    } catch { return null; }
  }
  path = path.replace(/\/$/, '').replace(/\.git$/i, '');
  const parts = path.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(owner)
    || !/^[a-z\d_.-]+$/i.test(repo) || repo === '.' || repo === '..') return null;
  return { provider: 'github', owner: owner.toLowerCase(), repo: repo.toLowerCase() };
}

const readonlyGit: DiscoveryGit = (cwd, args) => new Promise((resolve) => {
  // Ambient GIT_DIR/WORK_TREE/config/alternate overrides must not redirect the
  // probe. Never lazy-fetch missing objects, run fsmonitor, or consult global config.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
  // Git for Windows rejects Node's device namespace path (\\.\nul).
  const gitNull = process.platform === 'win32' ? 'NUL' : devNull;
  Object.assign(env, { PATH: augmentedPath(), LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitNull, GIT_GRAFT_FILE: gitNull,
    GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' });
  execFile('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never',
    ...args], { cwd, env, windowsHide: true, timeout: 2_000, maxBuffer: 64 * 1024, encoding: 'utf8' },
  (error, stdout, stderr) => resolve({ code: error ? typeof error.code === 'number' ? error.code : null : 0,
    stdout: String(stdout), stderr: String(stderr) }));
});

const layoutArgs = ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir',
  '--show-object-format', '--is-shallow-repository'];
const headArgs = ['rev-parse', '--verify', 'HEAD'];
const remoteArgs = ['config', '--get-all', 'remote.origin.url'];
const branchArgs = ['symbolic-ref', '--quiet', '--short', 'HEAD'];
const denied = (): ProjectDiscovery => ({ status: 'denied', reason: 'not-authorized' });
const unresolved = (reason: Exclude<ProjectDiscovery, GitProjectCandidate>['reason']): ProjectDiscovery =>
  ({ status: 'unresolved', reason });

/** Cheap cache validation without traversing history or spawning Git. Unknown layout is not cached. */
export async function readDiscoveryFingerprint(
  layout: Pick<GitProjectCandidate, 'cwd' | 'worktreeRoot' | 'gitCommonDir'>,
  options: Pick<ProjectDiscoveryOptions, 'getAccess' | 'isCurrent' | 'realpath'>,
): Promise<string | null> {
  const realpath = options.realpath ?? ((path: string) => fs.realpath(path));
  const access = options.getAccess(), token = JSON.stringify(access);
  const current = () => options.isCurrent() && JSON.stringify(options.getAccess()) === token;
  const allowed = async (path: string) => current() && await canReadProject(path, access, realpath) && current();
  try {
    for (const path of [layout.cwd, layout.worktreeRoot, layout.gitCommonDir]) {
      if (!await allowed(path) || await realpath(path) !== path) return null;
    }
    if (!withinDirectory(layout.worktreeRoot, layout.cwd)) return null;
    // A formerly ordinary subdirectory can become a nested repository. Do not
    // keep attributing its sessions to the cached parent until the TTL expires.
    for (let path = layout.cwd; path !== layout.worktreeRoot; path = dirname(path)) {
      try { await fs.lstat(join(path, '.git')); return null; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
    }
    const route = join(layout.worktreeRoot, '.git');
    if (await realpath(route) !== route) return null;
    const routeStat = await fs.lstat(route);
    let gitDir = route, routeText = '';
    if (routeStat.isFile() && routeStat.size <= 4096) {
      routeText = await fs.readFile(route, 'utf8');
      const match = /^gitdir: (.+)\r?\n?$/.exec(routeText);
      if (!match) return null;
      gitDir = await realpath(resolve(layout.worktreeRoot, match[1]));
    } else if (!routeStat.isDirectory()) return null;
    if (!await allowed(gitDir)) return null;
    const parts: string[] = [layout.cwd, gitDir, layout.gitCommonDir, routeText];
    const stamp = async (file: string) => {
      try {
        if (await realpath(file) !== file || !await allowed(file)) throw new Error('metadata-outside-grant');
        const stat = await fs.lstat(file, { bigint: true });
        if (!stat.isFile()) throw new Error('invalid-metadata');
        parts.push(file, String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        parts.push(file, 'missing');
      }
    };
    const headPath = join(gitDir, 'HEAD');
    await stamp(headPath);
    const headStat = await fs.lstat(headPath);
    if (!headStat.isFile() || headStat.size > 4096) return null;
    const head = (await fs.readFile(headPath, 'utf8')).trim();
    parts.push(head);
    const ref = /^ref: (refs\/[^\s\\]+)$/.exec(head)?.[1];
    if (ref) {
      if (ref.split('/').some((part) => !part || part === '.' || part === '..')) return null;
      await stamp(join(gitDir, ref));
      if (gitDir !== layout.gitCommonDir) await stamp(join(layout.gitCommonDir, ref));
    } else if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)) return null;
    for (const file of ['config', 'packed-refs', 'shallow', 'info/grafts']) await stamp(join(layout.gitCommonDir, file));
    for (const file of ['config.worktree', 'commondir']) await stamp(join(gitDir, file));
    if (!current()) return null;
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  } catch { return null; }
}

/** On-demand, bounded read-only probe. Metadata outside a directory grant is
 * not read beyond Git's initial routing lookup. A worktree's common .git must
 * also be covered. Do not call on every fast process tick or persist as projectId. */
export async function discoverProject(cwd: string, options: ProjectDiscoveryOptions): Promise<ProjectDiscovery> {
  const access = options.getAccess();
  const token = JSON.stringify(access);
  const realpath = options.realpath ?? ((path: string) => fs.realpath(path));
  const current = () => options.isCurrent() && JSON.stringify(options.getAccess()) === token;
  const allowed = async (path: string) => current() && await canReadProject(path, access, realpath) && current();
  if (!await allowed(cwd)) return denied();
  const git = options.git ?? readonlyGit;
  const start = Date.now();
  const read = async (args: string[]) => {
    if (!current() || Date.now() - start > 12_000) throw new Error('probe-invalidated');
    const result = await git(cwd, args);
    if (!current() || Date.now() - start > 12_000) throw new Error('probe-invalidated');
    return result;
  };
  try {
    const resolvedCwd = await realpath(cwd);
    const layout = await read(layoutArgs);
    if (layout.code !== 0) return layout.code === 128 && /not a git repository/i.test(layout.stderr)
      ? { status: 'non-git', reason: 'not-git' } : unresolved('git-unavailable');
    const fields = layout.stdout.trimEnd().split(/\r?\n/);
    if (fields.length !== 4) return unresolved('invalid-metadata');
    const [top, common, format, shallow] = fields;
    if (!isAbsolute(top) || !isAbsolute(common) || !['sha1', 'sha256'].includes(format)
      || !['true', 'false'].includes(shallow)) return unresolved('invalid-metadata');
    const worktreeRoot = await realpath(top), gitCommonDir = await realpath(common);
    if (!await allowed(worktreeRoot) || !await allowed(gitCommonDir)) {
      return current() ? unresolved('metadata-outside-grant') : denied();
    }
    if (shallow === 'true') return unresolved('shallow');
    const cacheLayout = { cwd: resolvedCwd, worktreeRoot, gitCommonDir };
    const fingerprint = await readDiscoveryFingerprint(cacheLayout, options);
    if (!fingerprint) return unresolved('invalid-metadata');
    const oid = format === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
    const head = await read(headArgs);
    if (head.code !== 0) return unresolved(head.code === 128 || head.code === 1 ? 'no-commit' : 'git-unavailable');
    if (!oid.test(head.stdout.trim())) return unresolved('invalid-metadata');
    const remote = await read(remoteArgs);
    const noRemote = remote.code === 1 && !remote.stdout && !remote.stderr;
    if (remote.code !== 0 && !noRemote) return unresolved('git-unavailable');
    const repository = noRemote ? { provider: 'none' as const } : normalizeGithubRepository(remote.stdout);
    if (!repository) return unresolved('unsupported-remote');
    const roots = await read(['rev-list', '--max-parents=0', 'HEAD']);
    if (roots.code !== 0) return unresolved('git-unavailable');
    const commits = roots.stdout.trim().split(/\r?\n/);
    if (!commits.every((commit) => oid.test(commit))) return unresolved('invalid-metadata');
    if (commits.length !== 1) return unresolved('multiple-roots');
    const branch = await read(branchArgs);
    if (branch.code !== 0 && branch.code !== 1) return unresolved('git-unavailable');
    const branchName = branch.code === 1 ? null : branch.stdout.trim();
    if (branchName !== null && (!branchName || branchName.length > 256 || /[\u0000-\u001f\u007f]/.test(branchName))) {
      return unresolved('invalid-metadata');
    }
    // Ref/config/geometry changes must not combine identity from different repos.
    for (const [args, before] of [[layoutArgs, layout], [headArgs, head], [remoteArgs, remote],
      [branchArgs, branch]] as const) {
      const after = await read([...args]);
      if (after.code !== before.code || after.stdout !== before.stdout) return unresolved('changed-during-probe');
    }
    if (!await allowed(cwd) || !await allowed(worktreeRoot) || !await allowed(gitCommonDir)
      || await realpath(cwd) !== resolvedCwd
      || await realpath(top) !== worktreeRoot || await realpath(common) !== gitCommonDir) return denied();
    if (!current()) return denied();
    if (await readDiscoveryFingerprint(cacheLayout, options) !== fingerprint) return unresolved('changed-during-probe');
    return { status: 'candidate', cwd: resolvedCwd, worktreeRoot, gitCommonDir, branch: branchName,
      repositoryIdentity: { ...repository, initialCommit: commits[0], objectFormat: format as 'sha1' | 'sha256' }, fingerprint };
  } catch { return current() ? unresolved('git-unavailable') : denied(); }
}

/** Local candidate grouping, deliberately not a prj_ ID or cross-device registry.
 * No-remote repositories occupy a separate namespace; forks never merge. */
export function groupProjectCandidates(discoveries: ProjectDiscovery[]): Array<{
  candidateKey: string; repositoryIdentity: RepositoryCandidate; mounts: GitProjectCandidate[];
}> {
  const groups = new Map<string, { candidateKey: string; repositoryIdentity: RepositoryCandidate; mounts: GitProjectCandidate[] }>();
  for (const item of discoveries) {
    if (item.status !== 'candidate') continue;
    const identity = item.repositoryIdentity;
    const candidateKey = JSON.stringify([identity.provider, identity.provider === 'github' ? identity.owner : null,
      identity.provider === 'github' ? identity.repo : null, identity.objectFormat, identity.initialCommit]);
    let group = groups.get(candidateKey);
    if (!group) {
      group = { candidateKey, repositoryIdentity: identity, mounts: [] };
      groups.set(candidateKey, group);
    }
    // Two session cwds in the same worktree do not create duplicate mounts.
    if (!group.mounts.some((mount) => mount.worktreeRoot === item.worktreeRoot)) group.mounts.push(item);
  }
  return [...groups.values()];
}
