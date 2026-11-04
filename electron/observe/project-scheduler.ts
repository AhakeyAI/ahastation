// Volatile local evidence, independent of the legacy project/history IDs and Hub registry.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { discoverProject, readDiscoveryFingerprint, groupProjectCandidates,
  type ProjectDiscovery, type ProjectDiscoveryOptions } from './project-discovery.js';
import { canReadProject, type ScanAccess } from './scan-access.js';
import { sanitizeTitle } from './util.js';
import type { ObservedProjectGroup, ObservedSession } from './types.js';

export const PROJECT_DISCOVERY_LIMITS = {
  directories: 100, concurrent: 2, startsPerScan: 4, cacheMs: 60_000, retryMs: 15_000,
} as const;
interface Entry { result?: ProjectDiscovery; completedAt: number; pending: boolean }
interface Options {
  getAccess: () => ScanAccess;
  now?: () => number;
  realpath?: (path: string) => Promise<string>;
  probe?: (cwd: string, options: ProjectDiscoveryOptions) => Promise<ProjectDiscovery>;
  fingerprint?: typeof readDiscoveryFingerprint;
}
const keyOf = (value: string) => createHash('sha256').update(value).digest('hex');
const labelOf = (path: string) => sanitizeTitle(basename(path)) || '本机目录';

/** refresh awaits only filesystem validation. Git probes run separately and appear next scan. */
export class ProjectDiscoveryScheduler {
  private readonly entries = new Map<string, Entry>();
  private routes = new Map<string, string>();
  private readonly active = new Set<Promise<void>>();
  private generation = 0;
  private accessToken = '';
  private startsLeft = 0;
  private current: () => boolean = () => false;
  private readonly now: () => number;
  private readonly realpath: (path: string) => Promise<string>;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.realpath = options.realpath ?? ((path) => fs.realpath(path));
  }

  invalidate(): void {
    this.generation++;
    this.entries.clear(); this.routes.clear(); this.startsLeft = 0;
    // Old tasks retain their concurrency slots until they settle, even across revoke/re-grant.
  }

  async refresh(sessions: ObservedSession[], isCurrent: () => boolean): Promise<void> {
    const access = this.options.getAccess(), token = JSON.stringify(access);
    if (token !== this.accessToken) { this.invalidate(); this.accessToken = token; }
    const generation = this.generation;
    const current = () => generation === this.generation && isCurrent()
      && JSON.stringify(this.options.getAccess()) === token;
    this.current = current;
    if (!access.enabled || !current()) return;
    const eligible = sessions.filter((s) => (s.origin === 'user' || s.origin === 'user-adopted') && s.ownership !== 'unresolved');
    const cwds = [...new Set(eligible.map((s) => s.cwd))].slice(0, PROJECT_DISCOVERY_LIMITS.directories);
    const routes = new Map<string, string>();
    for (const cwd of cwds) {
      if (!current()) return;
      try {
        const canonical = await this.realpath(cwd);
        if (await canReadProject(cwd, access, this.realpath) && await this.realpath(cwd) === canonical && current()) routes.set(cwd, canonical);
      } catch { /* Missing or redirected paths cannot reuse old evidence. */ }
    }
    if (!current()) return;
    this.routes = routes;
    const wanted = new Set(routes.values());
    for (const cwd of this.entries.keys()) if (!wanted.has(cwd)) this.entries.delete(cwd);
    for (const cwd of wanted) {
      let entry = this.entries.get(cwd);
      if (!entry) { entry = { completedAt: 0, pending: false }; this.entries.set(cwd, entry); }
      if (entry.pending || !entry.result) continue;
      let valid = this.now() - entry.completedAt < (entry.result.status === 'candidate'
        ? PROJECT_DISCOVERY_LIMITS.cacheMs : PROJECT_DISCOVERY_LIMITS.retryMs);
      if (valid && entry.result.status === 'candidate') {
        valid = await (this.options.fingerprint ?? readDiscoveryFingerprint)(entry.result,
          { getAccess: this.options.getAccess, isCurrent: current, realpath: this.realpath }) === entry.result.fingerprint;
      }
      if (!current()) return;
      if (!valid) {
        entry.result = undefined; entry.completedAt = 0;
        // Previously completed repositories go behind directories still waiting
        // for their first probe, even when scans are slower than the cache TTL.
        this.entries.delete(cwd); this.entries.set(cwd, entry);
      }
    }
    if (!current()) return;
    this.startsLeft = PROJECT_DISCOVERY_LIMITS.startsPerScan;
    this.pump();
  }

  private pump(): void {
    if (!this.current()) return;
    for (const [cwd, entry] of this.entries) {
      if (this.startsLeft <= 0 || this.active.size >= PROJECT_DISCOVERY_LIMITS.concurrent) break;
      if (entry.result || entry.pending) continue;
      this.startsLeft--; entry.pending = true;
      const generation = this.generation;
      const current = () => generation === this.generation && this.current() && this.entries.get(cwd) === entry;
      const task = Promise.resolve().then(() => current()
        ? (this.options.probe ?? discoverProject)(cwd, {
          getAccess: this.options.getAccess, isCurrent: current, realpath: this.realpath,
        }) : undefined).then((result) => {
          if (current() && result) { entry.result = result; entry.completedAt = this.now(); }
        }).catch(() => {
          if (current()) { entry.result = { status: 'unresolved', reason: 'git-unavailable' }; entry.completedAt = this.now(); }
        }).finally(() => {
          entry.pending = false;
          this.active.delete(task);
          this.pump();
        });
      this.active.add(task);
    }
  }

  /** Used by deterministic fixtures; the observation loop never waits for Git completion. */
  async whenIdle(): Promise<void> { while (this.active.size) await Promise.all([...this.active]); }

  project(sessions: ObservedSession[]): ObservedProjectGroup[] {
    const discoveries = new Map<string, ProjectDiscovery>();
    for (const [cwd, entry] of this.entries) if (entry.result) discoveries.set(cwd, entry.result);
    const groups = new Map<string, ObservedProjectGroup>();
    for (const candidate of groupProjectCandidates([...discoveries.values()])) {
      const identity = candidate.repositoryIdentity;
      const key = `candidate:${keyOf(candidate.candidateKey)}`;
      groups.set(key, { key, status: 'candidate',
        label: identity.provider === 'github' ? sanitizeTitle(`${identity.owner}/${identity.repo}`) : labelOf(candidate.mounts[0].worktreeRoot), mounts: [] });
    }
    for (const session of sessions) {
      if (session.origin === 'worker' || session.origin === 'station') continue;
      const cwd = this.routes.get(session.cwd);
      const unresolvedOwner = session.ownership === 'unresolved' || session.origin === 'unknown';
      const result = cwd && !unresolvedOwner ? discoveries.get(cwd) : undefined;
      let key: string, status: ObservedProjectGroup['status'], label: string, path = cwd ?? session.cwd;
      let reason: string | undefined, branch: string | null = null;
      if (result?.status === 'candidate') {
        key = `candidate:${keyOf(groupProjectCandidates([result])[0].candidateKey)}`;
        status = 'candidate'; label = groups.get(key)!.label;
        path = result.worktreeRoot; branch = result.branch;
      } else {
        key = `${unresolvedOwner ? 'ownership' : 'directory'}:${keyOf(cwd ?? session.cwd)}`;
        status = unresolvedOwner ? 'unresolved' : result?.status === 'non-git' ? 'non-git' : result ? 'unresolved' : 'pending';
        reason = unresolvedOwner ? 'ownership-unresolved' : result ? result.reason
          : !cwd ? 'directory-limit-or-unavailable' : undefined;
        label = labelOf(session.cwd);
      }
      let group = groups.get(key);
      if (!group) { group = { key, status, label, reason, mounts: [] }; groups.set(key, group); }
      const mountKey = `local:${keyOf(path)}`;
      let mount = group.mounts.find((m) => m.key === mountKey);
      if (!mount) { mount = { key: mountKey, label: labelOf(path), path, branch: branch === null ? null : sanitizeTitle(branch, 256), sessionIds: [] }; group.mounts.push(mount); }
      if (!mount.sessionIds.includes(session.id)) mount.sessionIds.push(session.id);
    }
    return [...groups.values()].filter((group) => group.mounts.length > 0);
  }
}
