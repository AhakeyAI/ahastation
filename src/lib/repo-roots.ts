// Shared folder → git repository cache (read-only `git rev-parse` in main).
// The lobby's project rooms and the board's project filter both key a folder
// by its repository, so a repo's worktrees and sub-folders count as one project.

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { RepoInfo } from './project-rooms';

const cache = new Map<string, RepoInfo>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const fn of listeners) fn();
}

function request(cwds: string[]): void {
  const api = window.vibeMeet?.projects;
  const missing = cwds.filter((c) => c && !cache.has(c) && !inFlight.has(c));
  if (!api?.resolveRepos || !missing.length) return;
  for (const c of missing) inFlight.add(c);
  void api.resolveRepos(missing).then((res) => {
    if (res.ok) for (const [cwd, info] of Object.entries(res.repos)) cache.set(cwd, info);
  }).catch(() => { /* callers fall back to the folder itself */ }).finally(() => {
    for (const c of missing) inFlight.delete(c);
    notify();
  });
}

/** Project key of a folder: its repository's main folder once known, else the folder. */
export function projectKeyOf(cwd: string): string {
  return cache.get(cwd)?.repoRoot ?? cwd;
}

export function repoInfoOf(cwd: string): RepoInfo | undefined {
  return cache.get(cwd);
}

/** Resolves the given folders in the background; re-renders when answers land. */
export function useRepoRoots(cwds: string[]): number {
  const key = useMemo(() => [...new Set(cwds)].sort().join('\n'), [cwds]);
  useEffect(() => { request(key ? key.split('\n') : []); }, [key]);
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => version,
    () => version,
  );
}
