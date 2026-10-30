// Shared vocabulary for anything that renders a task's state — the
// cross-project TasksView (and any future surfaces) read from here so a
// status never gets two different Chinese labels.

import type { WorkerStatus } from '../types';
import type { ObservedSession } from './observed-store';

export const WORKER_STATUS_LABEL: Record<WorkerStatus, string> = {
  pending: '等待调度',
  running: '执行中',
  verifying: '校验中',
  reviewing: '评审中',
  'coordinator-reviewing': 'Coordinator 审查中',
  'awaiting-acceptance': '待人手确认',
  'integration-queued': '等待集成',
  integrating: '集成中',
  'integration-conflict': '集成冲突',
  reworking: '需要返工',
  'budget-paused': '预算暂停',
  /** On Meeting integration branch — not published to the user workspace. */
  accepted: '已进 Meeting 分支',
  interrupted: '已中断',
  done: '已完成',
  failed: '失败',
};

/** Parent status = one default board column. Four by default (待执行 → 进行中 →
 *  待确认 → 已完成); finer states live in BoardSubStatus and can be split into
 *  their own lane by the user. */
export type TaskColumnId = 'todo' | 'active' | 'confirm' | 'settled';

export interface TaskColumnMeta {
  id: TaskColumnId;
  title: string;
  hint: string;
}

export const TASK_COLUMNS: readonly TaskColumnMeta[] = [
  { id: 'todo', title: '待执行', hint: '已确认，还没开工' },
  { id: 'active', title: '进行中', hint: 'Worker 正在推进' },
  { id: 'confirm', title: '待确认', hint: '等你批准或验收' },
  { id: 'settled', title: '已完成', hint: 'Meeting 分支或终态' },
];

/** The finest grain a card can be in; each belongs to exactly one parent. */
export type BoardSubStatus =
  | 'backlog' | 'queued'
  | 'running' | 'checking' | 'integrating' | 'reworking' | 'observed-active'
  | 'plan-approval' | 'permission' | 'acceptance' | 'blocked' | 'waiting-input'
  | 'accepted' | 'done' | 'failed' | 'interrupted' | 'observed-idle' | 'observed-done';

export const SUB_STATUS_META: Record<BoardSubStatus, { parent: TaskColumnId; label: string }> = {
  backlog: { parent: 'todo', label: '待派工' },
  queued: { parent: 'todo', label: '等待调度' },
  running: { parent: 'active', label: '执行中' },
  checking: { parent: 'active', label: '校验评审中' },
  integrating: { parent: 'active', label: '集成中' },
  reworking: { parent: 'active', label: '返工中' },
  'observed-active': { parent: 'active', label: '外部会话进行中' },
  'plan-approval': { parent: 'confirm', label: '计划待批准' },
  permission: { parent: 'confirm', label: '权限待批准' },
  acceptance: { parent: 'confirm', label: '待验收' },
  blocked: { parent: 'confirm', label: '受阻待处理' },
  'waiting-input': { parent: 'confirm', label: '等你输入' },
  accepted: { parent: 'settled', label: '已进 Meeting 分支' },
  done: { parent: 'settled', label: '已完成' },
  failed: { parent: 'settled', label: '失败' },
  interrupted: { parent: 'settled', label: '已中断' },
  'observed-idle': { parent: 'settled', label: '空闲' },
  'observed-done': { parent: 'settled', label: '外部会话已结束' },
};

export const SUB_STATUSES = Object.keys(SUB_STATUS_META) as BoardSubStatus[];

/** Sub-status of an orchestrated task. `permission` / `blocked` come from the
 *  worker (a pending prompt or a workspace diagnostic), not the plan node. */
export function subStatusForTask(
  status: WorkerStatus,
  flags: { permission?: boolean; diagnostic?: boolean } = {},
): BoardSubStatus {
  if (flags.permission) return 'permission';
  if (flags.diagnostic || status === 'budget-paused' || status === 'integration-conflict') return 'blocked';
  switch (status) {
    case 'pending': return 'queued';
    case 'awaiting-acceptance': return 'acceptance';
    case 'verifying':
    case 'reviewing':
    case 'coordinator-reviewing': return 'checking';
    case 'integration-queued':
    case 'integrating': return 'integrating';
    case 'reworking': return 'reworking';
    case 'accepted': return 'accepted';
    case 'done': return 'done';
    case 'failed': return 'failed';
    case 'interrupted': return 'interrupted';
    default: return 'running';
  }
}

/** A done session leaves the board once it falls outside this window. */
export const RECENTLY_DONE_WINDOW_MS = 30 * 60_000;

/**
 * Sub-status of an externally observed CLI session, or null when it should not
 * show anywhere (board or lobby rooms). `unknown` (file-only, no live process)
 * never shows. `idle` is a window that is open but not working (e.g. Codex
 * Desktop threads) — never 进行中. `done` only while recent.
 */
export function subStatusForObserved(session: ObservedSession, now: number): BoardSubStatus | null {
  if (session.ownership === 'unresolved' || session.origin === 'unknown') return null;
  if ((session.state === 'waiting' || session.state === 'active')
    && now - session.lastActiveAt >= 24 * 60 * 60_000) return null;
  switch (session.state) {
    case 'waiting': return 'waiting-input';
    case 'active': return 'observed-active';
    case 'idle': return session.pid !== undefined ? 'observed-idle' : null;
    case 'done': return now - session.lastActiveAt <= RECENTLY_DONE_WINDOW_MS ? 'observed-done' : null;
    default: return null;
  }
}

/** Default (parent) column for a task. Kept for callers that only need the
 *  four-column view. */
export function columnForTask(status: WorkerStatus, blocked: boolean): TaskColumnId {
  return SUB_STATUS_META[subStatusForTask(status, { diagnostic: blocked })].parent;
}

// ---- lanes ----------------------------------------------------------------

/** A board lane matches one parent status or one sub-status. The default board
 *  is the four parent lanes; users may split out any sub-status (or re-add a
 *  parent) as its own lane, remove lanes, or restore the default four. */
export interface BoardLane {
  id: string;
  title: string;
  match: { kind: 'parent'; parent: TaskColumnId } | { kind: 'sub'; sub: BoardSubStatus };
}

export const DEFAULT_LANES: BoardLane[] = TASK_COLUMNS.map((c) => ({
  id: c.id, title: c.title, match: { kind: 'parent', parent: c.id },
}));

export const UNSORTED_LANE_ID = '__unsorted__';

/** Most specific match wins: a sub-status lane, then its parent's lane; a card
 *  with neither lands in 未归类 so removing a lane never hides cards. */
export function laneFor(sub: BoardSubStatus, lanes: BoardLane[]): string {
  const parent = SUB_STATUS_META[sub].parent;
  return lanes.find((l) => l.match.kind === 'sub' && l.match.sub === sub)?.id
    ?? lanes.find((l) => l.match.kind === 'parent' && l.match.parent === parent)?.id
    ?? UNSORTED_LANE_ID;
}

export function laneHint(lane: BoardLane): string {
  if (lane.match.kind === 'parent') {
    const parent = lane.match.parent;
    return TASK_COLUMNS.find((c) => c.id === parent)?.hint ?? '';
  }
  return `属于「${TASK_COLUMNS.find((c) => c.id === SUB_STATUS_META[(lane.match as { sub: BoardSubStatus }).sub].parent)?.title}」`;
}

/** Parse stored lanes; anything malformed falls back to the default four. */
export function parseLanes(raw: string | null): BoardLane[] {
  if (!raw) return DEFAULT_LANES;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length === 0) return DEFAULT_LANES;
    const lanes = value.filter((l): l is BoardLane => {
      const m = (l as BoardLane)?.match;
      return typeof (l as BoardLane)?.id === 'string' && typeof (l as BoardLane)?.title === 'string'
        && ((m?.kind === 'parent' && TASK_COLUMNS.some((c) => c.id === m.parent))
          || (m?.kind === 'sub' && m.sub in SUB_STATUS_META));
    });
    return lanes.length ? lanes : DEFAULT_LANES;
  } catch {
    return DEFAULT_LANES;
  }
}

/** Prefer the live worker status over the plan-node snapshot. `delivery-status`
 *  / `worker-ended` update workers immediately; `plan-updated` can lag a tick
 *  behind, which made the cross-project board disagree with the in-meeting
 *  task list. Idle is a talker/blank placeholder and never wins. */
export function resolveBoardTaskStatus(
  nodeStatus: WorkerStatus,
  workerStatus: WorkerStatus | 'idle' | undefined,
): WorkerStatus {
  if (workerStatus && workerStatus !== 'idle') return workerStatus;
  return nodeStatus;
}

/** Last path segment of a cwd, tolerant of both separators. Falls back to the
 *  whole string for degenerate inputs like a bare drive root. */
export function projectNameFromCwd(cwd: string): string {
  const segments = cwd.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? cwd;
}
