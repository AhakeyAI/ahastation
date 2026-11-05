import { createHash, randomUUID } from 'node:crypto';
import type { MeetingRepository, PersistedMeetingEvent } from '../meeting-repository.js';
import { meetingPlanBriefInputSchema, normalizeMeetingPlanBrief, planMeetingTaskSchema, type MeetingPlanBrief, type PlanMeetingTask } from '../meeting-tools.js';
import type { OrchestratorEvent } from '../orchestrator-types.js';
import { hashTaskAuthorityRequest } from '../task-authority.js';
import { WorkerScheduler, type WorkerSchedulerOpts } from '../worker-scheduler.js';

type PlanDecision = { ok: true } | { ok: false; error: string };
type PlanDraft = {
  proposalId: string;
  proposalVersion: number;
  basePlanVersion: number;
  contentHash: string;
  tasks: PlanMeetingTask[];
  brief: MeetingPlanBrief;
};
export type PlanInstallSource = 'manual-install' | 'host-request' | 'auto-orchestration' | 'plan-meeting-confirmation';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Meeting-scoped Worker ownership and durable local-plan commands.
 *
 * Execution requests are installed directly: the Host explains the arrangement
 * and the Scheduler starts eligible tasks. Drafts read from older journals are
 * retained for inspection/resume but never auto-execute. */
export class HostRuntime {
  readonly scheduler: WorkerScheduler;
  private retained: PlanDraft | null = null;
  private version = 0;
  private tail = Promise.resolve();
  private readonly uncertain = new Set<string>();
  private preferences = { autoOrchestration: false };
  private lastRequestHash: string | null = null;
  private lastInstalledPlanVersion: number | null = null;
  private lastInstalledIds: string[] = [];
  private readonly requests = new Map<string, string>();

  constructor(
    schedulerOptions: WorkerSchedulerOpts,
    private readonly repository: MeetingRepository,
    private readonly emit: (event: OrchestratorEvent) => void,
    private readonly isClosed: () => boolean,
  ) {
    this.scheduler = new WorkerScheduler(schedulerOptions);
  }

  /** A draft carried over from an approval-era journal. It is readable context,
   *  not a pending decision, and only an explicit new request can execute it. */
  get retainedProposal(): PlanDraft | null { return this.retained; }
  get hasRetainedState(): boolean { return this.retained !== null || this.uncertain.size > 0; }
  get planPreferences() { return { ...this.preferences }; }

  setPlanPreferences(next: Partial<HostRuntime['preferences']>): Promise<void> {
    return this.mutatePlan(async () => {
      const preferences = { ...this.preferences, ...next };
      if (preferences.autoOrchestration === this.preferences.autoOrchestration) return;
      await this.repository.append('host-plan-preferences', { schemaVersion: 2, ...preferences });
      this.preferences = preferences;
    });
  }

  mutatePlan<T>(mutate: () => Promise<T>): Promise<T> {
    const result = this.tail.then(mutate);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  flushPlanMutations(): Promise<void> { return this.tail; }

  publishPlanState(): void {
    if (this.retained) {
      this.emit({
        source: 'system',
        event: {
          kind: 'plan-draft-retained',
          proposalId: this.retained.proposalId,
          proposalVersion: this.retained.proposalVersion,
          tasks: this.retained.tasks,
          brief: this.retained.brief,
        },
      });
    }
    for (const proposalId of this.uncertain) {
      this.emit({ source: 'system', event: { kind: 'plan-install-uncertain', proposalId } });
    }
  }

  /** Install a validated plan directly. A repeated identical request is a
   * no-op while the tasks it started are still live, so a retransmitted Host
   * call cannot start a second copy. */
  async install(
    tasks: PlanMeetingTask[],
    source: PlanInstallSource,
    brief?: MeetingPlanBrief,
    isCurrent = () => !this.isClosed(),
    requestId?: string,
  ): Promise<PlanDecision> {
    if (this.isClosed() || !isCurrent()) return { ok: false, error: 'Meeting or Host session is no longer current' };
    const requestHash = hash(tasks);
    if (requestId && this.requests.has(requestId)) {
      return this.requests.get(requestId) === requestHash
        ? { ok: true } : { ok: false, error: 'Execution request identity reused with different content' };
    }
    if (this.lastRequestHash === requestHash
      && this.lastInstalledPlanVersion === this.scheduler.getPlanVersion()
      && this.lastInstalledIds.length > 0
      && this.lastInstalledIds.every((id) => this.scheduler.snapshot().some((task) => task.id === id))) {
      return { ok: true };
    }
    const prepared = this.scheduler.preparePlanInstallation(tasks);
    if (!prepared.ok) return prepared;
    const baseVersion = this.scheduler.getPlanVersion();
    const decisionId = randomUUID();
    const approvedAt = Date.now();
    await this.repository.append('plan-authority-approved', {
      schemaVersion: 2, decisionId, approvedAt, source, requestHash, planVersion: baseVersion + 1,
      ...(brief ? { brief } : {}),
      ...(requestId ? { requestId } : {}),
      ...(this.retained ? { resolvesProposalId: this.retained.proposalId } : {}),
      normalizedTasks: prepared.tasks,
      tasks: prepared.tasks.map((task) => ({
        taskId: task.id, authorityRequestHash: hashTaskAuthorityRequest(task.authorityRequest),
      })),
    });
    if (this.isClosed() || !isCurrent() || this.scheduler.getPlanVersion() !== baseVersion) {
      return { ok: false, error: 'Plan installation interrupted' };
    }
    await this.repository.append('plan-install-committed', {
      schemaVersion: 2, decisionId, planVersion: baseVersion + 1, taskIds: prepared.tasks.map((task) => task.id),
    });
    if (!this.isClosed()) this.scheduler.installPreparedPlan(prepared.tasks, { decisionId, approvedAt });
    this.lastRequestHash = requestHash;
    if (requestId) this.requests.set(requestId, requestHash);
    this.lastInstalledPlanVersion = this.scheduler.getPlanVersion();
    this.lastInstalledIds = prepared.tasks.map((task) => task.id);
    this.retained = null;
    return { ok: true };
  }

  restore(journal: PersistedMeetingEvent[], recoveredTasks: Array<Record<string, unknown>>): void {
    const grants = new Map<string, Record<string, unknown>>();
    const installed = new Set<string>();
    const directCandidates: Array<{ decisionId: string; payload: Record<string, unknown> }> = [];
    let latestVersion = 0;
    let latestIds = new Set<unknown>();
    for (const event of journal) {
      const payload = objectRecord(event.payload);
      if (event.type === 'orchestration-mode-changed' && typeof payload.enabled === 'boolean') {
        this.preferences.autoOrchestration = payload.enabled;
      }
      if (event.type === 'host-plan-preferences' && typeof payload.autoOrchestration === 'boolean') {
        this.preferences = { autoOrchestration: payload.autoOrchestration };
      }
      if (event.type === 'plan-authority-approved' && typeof payload.decisionId === 'string') {
        grants.set(payload.decisionId, payload);
        if (payload.source === 'host-request') directCandidates.push({ decisionId: payload.decisionId, payload });
      }
      if (event.type === 'plan-install-committed' && typeof payload.decisionId === 'string') {
        const grant = grants.get(payload.decisionId);
        const taskIds = Array.isArray(grant?.normalizedTasks)
          ? grant.normalizedTasks.map((task) => objectRecord(task).id)
          : undefined;
        if (taskIds?.length && grant?.planVersion === payload.planVersion
          && Array.isArray(payload.taskIds) && taskIds.length === payload.taskIds.length
          && taskIds.every((id, index) => typeof id === 'string' && id === (payload.taskIds as unknown[])[index])) {
          installed.add(payload.decisionId);
        }
      }
      if (event.type === 'event:plan-updated') {
        const plan = objectRecord(objectRecord(payload.event).plan);
        if (typeof plan.version === 'number' && plan.version >= latestVersion && Array.isArray(plan.nodes)) {
          latestVersion = plan.version;
          latestIds = new Set(plan.nodes.map((node) => objectRecord(node).id));
        }
      }
    }
    this.scheduler.restorePlanVersion(latestVersion);
    // A commit is authoritative even if the process died before plan-updated.
    for (const id of installed) {
      const grant = grants.get(id)!;
      if (typeof grant.planVersion === 'number') this.scheduler.restorePlanVersion(grant.planVersion);
      if (typeof grant.requestId === 'string' && typeof grant.requestHash === 'string') {
        this.requests.set(grant.requestId, grant.requestHash);
      }
    }
    const latestDirect = directCandidates.filter((entry) => installed.has(entry.decisionId)).at(-1);
    if (latestDirect && typeof latestDirect.payload.requestHash === 'string'
      && latestDirect.payload.planVersion === this.scheduler.getPlanVersion()
      && Array.isArray(latestDirect.payload.normalizedTasks)) {
      this.lastRequestHash = latestDirect.payload.requestHash;
      this.lastInstalledPlanVersion = latestDirect.payload.planVersion;
      this.lastInstalledIds = latestDirect.payload.normalizedTasks
        .map((task) => objectRecord(task).id)
        .filter((id): id is string => typeof id === 'string');
    }
    const known = new Set(recoveredTasks.map((task) => task.id));
    for (const id of installed) {
      const grant = grants.get(id)!;
      if (typeof grant.planVersion !== 'number' || !Array.isArray(grant.normalizedTasks)) continue;
      this.scheduler.restorePlanVersion(grant.planVersion);
      for (const input of grant.normalizedTasks) {
        const task = planMeetingTaskSchema.safeParse(input);
        if (!task.success || known.has(task.data.id) || (latestVersion >= grant.planVersion && !latestIds.has(task.data.id))) continue;
        const recovered = {
          ...task.data, status: 'interrupted', attempt: 1, approvalDecisionId: id,
          approvedPlanVersion: grant.planVersion, approvalRecordedAt: grant.approvedAt,
        };
        recoveredTasks.push(recovered);
        known.add(task.data.id);
        this.scheduler.restoreTasks([recovered]);
      }
    }
    this.restoreDrafts(journal, installed);
  }

  /** Approval-era proposals remain readable, but they are never installed by
   * restore alone; the user must explicitly ask to continue. */
  private restoreDrafts(journal: PersistedMeetingEvent[], installed: Set<string>) {
    let latest: PlanDraft | null = null;
    const resolved = new Set<string>();
    const installedDrafts = new Set<string>();
    for (const event of journal) {
      const payload = objectRecord(event.payload);
      if (event.type === 'plan-proposal-v1') {
        const draft = payload as Partial<PlanDraft> & { schemaVersion?: number };
        if (draft.schemaVersion === 1 && typeof draft.proposalId === 'string' && Number.isSafeInteger(draft.proposalVersion)
          && Number.isSafeInteger(draft.basePlanVersion) && draft.brief && Array.isArray(draft.tasks)
          && draft.tasks.every((task) => planMeetingTaskSchema.safeParse(task).success)
          && draft.contentHash === hash({ normalized: draft.tasks, brief: draft.brief })) {
          latest = draft as PlanDraft;
          this.version = Math.max(this.version, latest.proposalVersion);
        }
      } else if (event.type === 'plan-proposed' && Array.isArray(payload.tasks) && payload.tasks.length > 0
        && payload.tasks.every((task) => planMeetingTaskSchema.safeParse(task).success)) {
        const tasks = payload.tasks as PlanMeetingTask[];
        const parsedBrief = meetingPlanBriefInputSchema.safeParse(payload.brief);
        const brief = normalizeMeetingPlanBrief(parsedBrief.success ? parsedBrief.data : undefined, tasks);
        latest = {
          proposalId: event.id, proposalVersion: ++this.version, basePlanVersion: this.scheduler.getPlanVersion(),
          tasks, brief, contentHash: hash({ normalized: tasks, brief }),
        };
      }
      if (event.type === 'plan-approval-result') {
        if (typeof payload.proposalId !== 'string') {
          // Pre-identity journals only recorded the decision source. A legacy
          // confirmation after a legacy draft means that draft was installed.
          if (payload.source === 'plan-meeting-confirmation' && latest) resolved.add(latest.proposalId);
          continue;
        }
        const committed = typeof payload.approvalCommandId === 'string' && installed.has(payload.approvalCommandId);
        const saved = objectRecord(payload.result);
        if (committed || saved.ok === true) resolved.add(payload.proposalId);
        else if (!payload.result) this.uncertain.add(payload.proposalId);
      }
      if (event.type === 'plan-authority-approved' && typeof payload.decisionId === 'string'
        && installed.has(payload.decisionId)) {
        const proposalId = payload.resolvesProposalId ?? payload.proposalId ?? objectRecord(payload.decision).proposalId;
        if (typeof proposalId === 'string') installedDrafts.add(proposalId);
      }
    }
    this.retained = latest && !resolved.has(latest.proposalId) && !installedDrafts.has(latest.proposalId)
      ? latest : null;
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
