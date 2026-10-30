// project-rooms.ts — the launch lobby's "项目室": one room per project folder,
// merged from three sources so the lobby has a single place to pick where to
// meet: recently opened folders, interrupted meetings that can be recovered,
// and the observation layer's scan of local AI sessions (Claude Code / Codex /
// Kimi). Rooms are ordered by most recent activity.

import type { ObservedClientKind, ObservedSession, ObservedState } from './observed-store';
import { subStatusForObserved } from './task-columns';

export interface RoomSeat {
  id: string;
  client: ObservedClientKind;
  state: ObservedState;
  title: string;
  /** Worktree / sub-folder label when the session is not in the main folder. */
  place: string | null;
}

export interface ProjectRoom {
  /** Folder a meeting opens in: the repository's main folder. */
  cwd: string;
  name: string;
  parent: string;
  /** Unix ms of the latest activity across all sources. */
  lastActiveAt: number;
  /** One seat per observed session in this repository, most recent first. */
  seats: RoomSeat[];
  /** Distinct worktrees / sub-folders that have sessions, besides the main folder. */
  places: string[];
  /** Interrupted meeting id when this repository has one to recover. */
  recoverableMeetingId: string | null;
  opened: boolean;
  /** Unix ms the folder was last opened in AhaStudio; 0 when only scanned. */
  lastOpenedAt: number;
  /** The catch-all room for sessions outside any project (home folder, chat dirs). */
  other: boolean;
}

export interface RepoInfo {
  repoRoot: string | null;
  worktree: boolean;
  branch: string | null;
}

export interface RoomSources {
  recent: { path: string; lastOpenedAt: number }[];
  recoverable: { meetingId: string; cwd: string; updatedAt?: number }[];
  sessions: ObservedSession[];
  /** folder → repository; folders missing here group by themselves. */
  repos?: Record<string, RepoInfo>;
}

export interface ProjectsApi {
  resolveRepos: (cwds: string[]) => Promise<{ ok: true; repos: Record<string, RepoInfo> } | { ok: false; error: string }>;
  defaultParent: (recent?: string[]) => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  create: (parentPath: string, name: string, git: boolean) => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  clone: (url: string, parentPath: string) => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  abortClone: () => Promise<{ ok: boolean }>;
  onCloneProgress: (cb: (payload: { line: string }) => void) => () => void;
  githubStatus: (cwd: string) => Promise<{ ok: true; status: GithubStatus } | { ok: false; error: string }>;
  cleanupPlan: (cwd: string) => Promise<{ ok: true; plan: RoomCleanupPlan } | { ok: false; error: string }>;
  cleanup: (
    cwd: string,
    sessionIds: string[],
    worktreePaths: string[],
  ) => Promise<{ ok: true; result: RoomCleanupResult } | { ok: false; error: string }>;
  backlogList: () => Promise<{ ok: true; items: BacklogItem[] } | { ok: false; error: string }>;
  backlogAdd: (
    cwd: string,
    items: { title: string; kind: 'work-item' | 'todo'; source?: string }[],
    createIssues: boolean,
  ) => Promise<{ ok: true; items: BacklogItem[] } | { ok: false; error: string }>;
  backlogRemove: (id: string) => Promise<{ ok: boolean }>;
  onBacklogChanged: (cb: (items: BacklogItem[]) => void) => () => void;
}

/** Mirror of electron/project-cleanup.ts CleanupPlan. */
export interface RoomCleanupPlan {
  repoRoot: string;
  git: boolean;
  baseBranch: string | null;
  sessions: { id: string; clientKind: ObservedClientKind; title: string; place: string | null; closable: boolean; reason?: string }[];
  worktrees: { path: string; branch: string | null; dirty: boolean; unmerged: number | null; locked: boolean }[];
}

export interface RoomCleanupResult {
  sessions: { id: string; ok: boolean; error?: string }[];
  worktrees: { id: string; ok: boolean; error?: string }[];
}

export interface GithubStatus {
  github: boolean;
  queried: boolean;
  openIssues: number | null;
  openPrs: number | null;
}

/** Board 「待执行 / 待派工」 card confirmed from the meeting notes. */
export interface BacklogItem {
  id: string;
  cwd: string;
  projectName: string;
  title: string;
  kind: 'work-item' | 'todo';
  source?: string;
  createdAt: number;
  issueUrl?: string;
  issueError?: string;
}

/** Set once this machine has done its first scan; unset = lead with the scan
 *  guide. Value kept from the old onboarding overlay so existing installs
 *  don't see the guide again. */
export const ONBOARDED_STORAGE_KEY = 'ahastudio.onboarded';

export const ROOM_SEAT_LIMIT = 4;
export const ROOMS_PREVIEW = 3;
export const OTHER_ROOM_KEY = '__other__';

function normalize(cwd: string): string {
  return cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd;
}

export function splitPath(cwd: string): { name: string; parent: string } {
  const parts = cwd.split('/').filter(Boolean);
  const name = parts[parts.length - 1] ?? cwd;
  const parent = parts.slice(0, -1).join('/');
  return { name, parent: parent ? `/${parent}/` : '/' };
}

/** Not a project: the home folder itself, or Codex's web-chat project dirs. */
function isNonProjectFolder(cwd: string): boolean {
  return /^\/(Users|home)\/[^/]+$/.test(cwd) || /^[A-Za-z]:\\Users\\[^\\]+$/.test(cwd) || cwd.includes('/.codex/.chatgpt-projects/');
}

/**
 * Room key for a folder: its repository's main folder (option A — one room per
 * local git repository; worktrees and sub-folders join it, another clone is
 * another room). Non-git folders are their own room; non-project folders go to
 * the shared "其他会话" room.
 */
function roomKey(cwd: string, repos: Record<string, RepoInfo> | undefined): string {
  const repoRoot = repos?.[cwd]?.repoRoot;
  if (repoRoot) return normalize(repoRoot);
  return isNonProjectFolder(cwd) ? OTHER_ROOM_KEY : cwd;
}

function placeLabel(cwd: string, root: string, info: RepoInfo | undefined): string | null {
  if (cwd === root) return null;
  if (info?.worktree) return info.branch ?? splitPath(cwd).name;
  return cwd.startsWith(`${root}/`) ? cwd.slice(root.length + 1) : splitPath(cwd).name;
}

export function buildRooms({ recent, recoverable, sessions, repos }: RoomSources): ProjectRoom[] {
  const rooms = new Map<string, ProjectRoom>();
  const room = (rawCwd: string): ProjectRoom => {
    const key = roomKey(normalize(rawCwd), repos);
    let r = rooms.get(key);
    if (!r) {
      const other = key === OTHER_ROOM_KEY;
      r = {
        cwd: other ? '' : key,
        ...(other ? { name: '其他会话', parent: '不属于任何项目的会话' } : splitPath(key)),
        lastActiveAt: 0, seats: [], places: [], recoverableMeetingId: null, opened: false, lastOpenedAt: 0, other,
      };
      rooms.set(key, r);
    }
    return r;
  };
  for (const entry of recent) {
    if (!entry.path) continue;
    const r = room(entry.path);
    r.opened = true;
    r.lastOpenedAt = Math.max(r.lastOpenedAt, entry.lastOpenedAt);
    r.lastActiveAt = Math.max(r.lastActiveAt, entry.lastOpenedAt);
  }
  for (const meeting of recoverable) {
    if (!meeting.cwd) continue;
    const r = room(meeting.cwd);
    r.recoverableMeetingId ??= meeting.meetingId;
    if (meeting.updatedAt) r.lastActiveAt = Math.max(r.lastActiveAt, meeting.updatedAt);
  }
  // Same visibility rule as the board: dead (file-only) sessions never sit in a room.
  const now = Date.now();
  const ordered = [...sessions]
    .filter((s) => !s.isNoise && s.cwd && subStatusForObserved(s, now) !== null)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  for (const s of ordered) {
    const cwd = normalize(s.cwd);
    const r = room(cwd);
    const place = r.other ? splitPath(cwd).name : placeLabel(cwd, r.cwd, repos?.[cwd]);
    if (place && !r.other && !r.places.includes(place)) r.places.push(place);
    r.seats.push({ id: s.id, client: s.clientKind, state: s.state, title: s.title, place });
    r.lastActiveAt = Math.max(r.lastActiveAt, s.lastActiveAt);
  }
  // The catch-all room always sorts last.
  return [...rooms.values()].sort((a, b) => Number(a.other) - Number(b.other) || b.lastActiveAt - a.lastActiveAt);
}

/** Avatars to draw: up to 4; past 4 the fourth becomes the "+" overflow. */
export function visibleSeats(seats: RoomSeat[]): { shown: RoomSeat[]; overflow: number } {
  if (seats.length <= ROOM_SEAT_LIMIT) return { shown: seats, overflow: 0 };
  return { shown: seats.slice(0, ROOM_SEAT_LIMIT - 1), overflow: seats.length - (ROOM_SEAT_LIMIT - 1) };
}

/** "2 个进行中，1 个等你输入" — empty when nobody is working. */
export function roomStatus(seats: RoomSeat[]): string {
  const active = seats.filter((s) => s.state === 'active').length;
  const waiting = seats.filter((s) => s.state === 'waiting').length;
  return [active ? `${active} 个进行中` : '', waiting ? `${waiting} 个等你输入` : ''].filter(Boolean).join('，');
}
