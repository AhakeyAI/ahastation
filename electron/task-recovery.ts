import type { PlanMeetingTask } from './meeting-tools.js';
import type { PersistedMeetingEvent } from './meeting-repository.js';

export const TASK_RECOVERY_ACTIONS = [
  'continue-read-only',
  'continue-side-effecting',
  'retry-attempt',
  'resolve-integration-conflict',
  'abandon-task',
] as const;

export type TaskRecoveryAction = (typeof TASK_RECOVERY_ACTIONS)[number];

export interface TaskRecoveryAssessment {
  schemaVersion: 1;
  classification:
    | 'auto-read-only'
    | 'requires-user'
    | 'integration-conflict'
    | 'budget-paused'
    | 'process-uncertain'
    | 'terminal';
  reasonCode:
    | 'explicit-read-only-authority'
    | 'side-effect-authority'
    | 'legacy-or-incomplete-authority'
    | 'integration-conflict'
    | 'budget-paused'
    | 'native-process-exit-unconfirmed'
    | 'terminal';
  allowedActions: TaskRecoveryAction[];
  autoResume: boolean;
}

const READ_ONLY_TOOL_KINDS = new Set(['read', 'search', 'git-read']);
const TERMINAL_TASK_STATUSES = new Set(['accepted', 'failed', 'cancelled']);
const TERMINAL_WORKER_BACKEND_IDS = new Set([
  'claude-code-terminal',
  'kimi-code-terminal',
  'codex-terminal',
  'qoder-terminal',
]);

function isTerminalRecoveryBackend(task: Record<string, unknown>): boolean {
  if (typeof task.executorBackendId === 'string' && TERMINAL_WORKER_BACKEND_IDS.has(task.executorBackendId)) {
    return true;
  }
  const profile = record(task.executionProfile);
  return typeof profile?.backendId === 'string' && TERMINAL_WORKER_BACKEND_IDS.has(profile.backendId);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : null;
}

function commandList(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** Conservative legacy status normalization. Historical `done`,
 * `reviewing`, and `awaiting-acceptance` records prove neither complete
 * Coordinator review nor durable integration, so recovery never upgrades
 * them to accepted. */
export function normalizeRecoveredTaskStatus(status: unknown): string {
  if (status === 'accepted' || status === 'failed' || status === 'cancelled') {
    return status;
  }
  if (status === 'budget-paused') return status;
  if (status === 'integration-conflict') return status;
  return 'interrupted';
}

export function normalizeLegacyTaskStatus(status: unknown): unknown {
  return status === 'reviewing'
    || status === 'awaiting-acceptance'
    || status === 'done'
    ? 'interrupted'
    : status;
}

/** Return true only when the persisted plan explicitly proves a task has no
 * write, command, environment, network, credential, or external authority.
 * Missing legacy facts are never interpreted as read-only permission. */
export function isExplicitReadOnlyRecoveryTask(task: Record<string, unknown>): boolean {
  // Interactive PTY/native CLI sessions do not survive app restarts and own
  // their own runtime permission state; never auto-dispatch a duplicate run.
  if (isTerminalRecoveryBackend(task)) return false;
  if (task.workspaceMode !== 'read-only') return false;
  const authority = record(task.authorityRequest);
  if (!authority) return false;
  const writePaths = strings(authority.writePaths);
  const toolKinds = strings(authority.toolKinds);
  const commands = commandList(authority.commands);
  const environmentKeys = strings(authority.environmentKeys);
  const networkHosts = strings(authority.networkHosts);
  if (
    !writePaths
    || !toolKinds
    || !commands
    || !environmentKeys
    || !networkHosts
  ) return false;
  return writePaths.length === 0
    && commands.length === 0
    && environmentKeys.length === 0
    && networkHosts.length === 0
    && toolKinds.every((kind) => READ_ONLY_TOOL_KINDS.has(kind));
}

export function assessTaskRecovery(task: Record<string, unknown>): TaskRecoveryAssessment {
  if (task.launchPhase === 'uncertain') {
    return {
      schemaVersion: 1,
      classification: 'process-uncertain',
      reasonCode: 'native-process-exit-unconfirmed',
      allowedActions: ['abandon-task'],
      autoResume: false,
    };
  }
  const status = normalizeRecoveredTaskStatus(task.status);
  if (TERMINAL_TASK_STATUSES.has(status)) {
    return {
      schemaVersion: 1,
      classification: 'terminal',
      reasonCode: 'terminal',
      allowedActions: [],
      autoResume: false,
    };
  }
  if (status === 'budget-paused') {
    return {
      schemaVersion: 1,
      classification: 'budget-paused',
      reasonCode: 'budget-paused',
      allowedActions: ['abandon-task'],
      autoResume: false,
    };
  }
  if (status === 'integration-conflict') {
    return {
      schemaVersion: 1,
      classification: 'integration-conflict',
      reasonCode: 'integration-conflict',
      allowedActions: ['resolve-integration-conflict', 'abandon-task'],
      autoResume: false,
    };
  }
  if (isExplicitReadOnlyRecoveryTask(task)) {
    return {
      schemaVersion: 1,
      classification: 'auto-read-only',
      reasonCode: 'explicit-read-only-authority',
      allowedActions: ['continue-read-only', 'retry-attempt', 'abandon-task'],
      autoResume: true,
    };
  }
  const authority = record(task.authorityRequest);
  return {
    schemaVersion: 1,
    classification: 'requires-user',
    reasonCode: authority ? 'side-effect-authority' : 'legacy-or-incomplete-authority',
    allowedActions: ['continue-side-effecting', 'retry-attempt', 'abandon-task'],
    autoResume: false,
  };
}

/** Launch intents reserve ownership until an exact attempt has tree-exit proof. */
export function unresolvedNativeLaunches(events: readonly PersistedMeetingEvent[]): Map<string, Set<number>> {
  const open = new Map<string, Set<number>>();
  for (const event of events) {
    if (event.type !== 'worker-native-launch-intent' && event.type !== 'worker-stop-confirmed'
      && event.type !== 'worker-stop-unconfirmed') continue;
    const data = record(event.payload);
    const taskId = typeof data?.workerId === 'string' ? data.workerId : data?.taskId;
    const attempt = data?.attempt;
    if (typeof taskId !== 'string' || typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) continue;
    if (event.type === 'worker-stop-confirmed') {
      open.get(taskId)?.delete(attempt);
    } else {
      const attempts = open.get(taskId) ?? new Set<number>();
      attempts.add(attempt);
      open.set(taskId, attempts);
    }
  }
  return open;
}

export function assertRecoveryActionAllowed(
  task: Record<string, unknown>,
  action: TaskRecoveryAction,
): TaskRecoveryAssessment {
  const assessment = assessTaskRecovery(task);
  if (!assessment.allowedActions.includes(action)) {
    throw new Error(
      `recovery action ${action} is not allowed for ${assessment.classification}`,
    );
  }
  return assessment;
}

export function recoveryRecordFromPlanTask(
  task: PlanMeetingTask,
  status: string,
): Record<string, unknown> {
  return {
    status,
    executorBackendId: task.executorBackendId,
    ...(task.executionProfile ? { executionProfile: structuredClone(task.executionProfile) } : {}),
    workspaceMode: task.workspaceMode,
    authorityRequest: structuredClone(task.authorityRequest),
  };
}
