import { createHash, randomUUID } from 'node:crypto';
import type { MeetingRepository, PersistedMeetingEvent } from '../meeting-repository.js';
import { meetingPlanBriefInputSchema, normalizeMeetingPlanBrief, planMeetingTaskSchema, type MeetingPlanBrief, type MeetingPlanBriefInput, type PlanMeetingTask } from '../meeting-tools.js';
import type { OrchestratorEvent } from '../orchestrator-types.js';
import { hashTaskAuthorityRequest } from '../task-authority.js';
import { WorkerScheduler, type WorkerSchedulerOpts } from '../worker-scheduler.js';

type PlanDecision = { ok: true } | { ok: false; error: string };
type PlanProposal = {
  proposalId: string;
  proposalVersion: number;
  basePlanVersion: number;
  contentHash: string;
  tasks: PlanMeetingTask[];
  brief: MeetingPlanBrief;
};
export type PlanApprovalIdentity = Pick<PlanProposal, 'proposalId' | 'proposalVersion'> & { approvalCommandId: string };
type ApprovalRecord = PlanApprovalIdentity & { fingerprint: string; brief: MeetingPlanBrief };

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Meeting-scoped Worker ownership and durable local-plan commands. */
export class HostRuntime {
  readonly scheduler: WorkerScheduler;
  private pending: PlanProposal | null = null;
  private version = 0;
  private tail = Promise.resolve();
  private readonly uncertain = new Set<string>();
  private readonly results = new Map<string, { fingerprint: string; result: PlanDecision }>();
  private preferences = { autoOrchestration: false, autoApprovePlans: false };

  constructor(
    schedulerOptions: WorkerSchedulerOpts,
    private readonly repository: MeetingRepository,
    private readonly emit: (event: OrchestratorEvent) => void,
    private readonly isClosed: () => boolean,
  ) {
    this.scheduler = new WorkerScheduler(schedulerOptions);
  }

  get pendingProposal(): PlanProposal | null { return this.pending; }
  get hasPendingState(): boolean { return this.pending !== null || this.uncertain.size > 0; }
  get planPreferences() { return { ...this.preferences }; }

  setPlanPreferences(next: Partial<HostRuntime['preferences']>): Promise<void> {
    return this.mutatePlan(async () => {
      const preferences = { ...this.preferences, ...next };
      if (preferences.autoOrchestration === this.preferences.autoOrchestration
        && preferences.autoApprovePlans === this.preferences.autoApprovePlans) return;
      await this.repository.append('host-plan-preferences', { schemaVersion: 1, ...preferences });
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
    if (this.pending) this.emit({ source: 'system', event: { kind: 'plan-proposed', ...this.pending } });
    for (const proposalId of this.uncertain) {
      this.emit({ source: 'system', event: { kind: 'plan-install-uncertain', proposalId } });
    }
  }

  /** Called inside the plan command boundary after backend validation. */
  async recordProposal(tasks: PlanMeetingTask[], brief: MeetingPlanBrief): Promise<PlanProposal> {
    const proposal: PlanProposal = {
      proposalId: randomUUID(),
      proposalVersion: ++this.version,
      basePlanVersion: this.scheduler.getPlanVersion(),
      contentHash: hash({ normalized: tasks, brief }),
      tasks, brief,
    };
    await this.repository.append('plan-proposal-v1', {
      schemaVersion: 1, ...proposal,
      ...(this.pending ? { replacesProposalId: this.pending.proposalId } : {}),
    });
    this.pending = proposal;
    this.emit({ source: 'system', event: { kind: 'plan-proposed', ...proposal } });
    return proposal;
  }

  async approve(
    approved: boolean,
    identity: PlanApprovalIdentity | undefined,
    edit: {
      fingerprint: unknown;
      brief?: MeetingPlanBriefInput;
      prepareTasks?: () => Promise<{ tasks: PlanMeetingTask[] } | { error: string }>;
    },
  ): Promise<PlanDecision> {
    const proposal = this.pending;
    const basis = identity ?? (proposal && {
      proposalId: proposal.proposalId, proposalVersion: proposal.proposalVersion, approvalCommandId: randomUUID(),
    });
    if (!basis) return { ok: false, error: 'no pending plan' };
    const fingerprint = hash({ proposalId: basis.proposalId, proposalVersion: basis.proposalVersion, approved, edit: edit.fingerprint });
    const previousResult = (): PlanDecision | undefined => {
      const previous = this.results.get(basis.approvalCommandId);
      return previous && (previous.fingerprint === fingerprint
        ? previous.result : { ok: false, error: 'approval command content conflict' });
    };
    const replay = previousResult();
    if (replay) return replay;
    // Backends can probe a process or authenticate. Leave that work outside the
    // serialized state transition and compare the proposal again after it settles.
    const prepared = approved && proposal?.proposalId === basis.proposalId ? await edit.prepareTasks?.() : undefined;
    return this.mutatePlan(async () => {
      const replay = previousResult();
      if (replay) return replay;
      const current = this.pending;
      if (this.isClosed() || !current || current.proposalId !== basis.proposalId || current.proposalVersion !== basis.proposalVersion
        || (approved && current.basePlanVersion !== this.scheduler.getPlanVersion())) {
        return { ok: false, error: 'plan proposal version conflict' };
      }
      const tasks = prepared && 'tasks' in prepared ? prepared.tasks : current.tasks;
      const decision = { ...basis, fingerprint, brief: normalizeMeetingPlanBrief(edit.brief ?? current.brief, tasks) };
      const result = prepared && 'error' in prepared ? { ok: false as const, error: prepared.error }
        : approved ? await this.install(tasks, 'plan-meeting-confirmation', decision)
        : { ok: true } as const;
      const settle = () => {
        this.results.set(basis.approvalCommandId, { fingerprint, result });
        if (result.ok) {
          this.uncertain.delete(basis.proposalId);
          this.pending = null;
          this.emit({ source: 'system', event: { kind: 'plan-proposal-resolved', proposalId: basis.proposalId } });
        }
      };
      const committed = approved && result.ok;
      if (committed) settle();
      await this.repository.append('plan-approval-result', { schemaVersion: 1, ...basis, fingerprint, result });
      if (!committed) settle();
      return result;
    });
  }

  /** The plan command boundary reserves the version and the allocated task IDs. */
  async install(
    tasks: PlanMeetingTask[],
    source: 'manual-install' | 'auto-orchestration' | 'plan-meeting-confirmation',
    decision?: ApprovalRecord,
    isCurrent = () => !this.isClosed(),
  ): Promise<PlanDecision> {
    if (this.isClosed() || !isCurrent()) return { ok: false, error: 'Meeting or Host session is no longer current' };
    const prepared = this.scheduler.preparePlanInstallation(tasks);
    if (!prepared.ok) return prepared;
    const baseVersion = this.scheduler.getPlanVersion();
    const decisionId = decision?.approvalCommandId ?? randomUUID();
    const approvedAt = Date.now();
    await this.repository.append('plan-authority-approved', {
      schemaVersion: 1, ...decision, decisionId, approvedAt, source, planVersion: baseVersion + 1,
      normalizedTasks: prepared.tasks,
      tasks: prepared.tasks.map((task) => ({
        taskId: task.id, authorityRequestHash: hashTaskAuthorityRequest(task.authorityRequest),
      })),
    });
    if (this.isClosed() || !isCurrent() || this.scheduler.getPlanVersion() !== baseVersion) {
      return { ok: false, error: 'Plan installation interrupted' };
    }
    await this.repository.append('plan-install-committed', {
      schemaVersion: 1, decisionId, planVersion: baseVersion + 1, taskIds: prepared.tasks.map((task) => task.id),
    });
    if (!this.isClosed()) this.scheduler.installPreparedPlan(prepared.tasks, { decisionId, approvedAt });
    return { ok: true };
  }

  restore(journal: PersistedMeetingEvent[], recoveredTasks: Array<Record<string, unknown>>): void {
    const grants = new Map<string, Record<string, unknown>>();
    const installed = new Set<string>();
    let latestVersion = 0;
    let latestIds = new Set<unknown>();
    for (const event of journal) {
      const payload = objectRecord(event.payload);
      if (event.type === 'orchestration-mode-changed' && typeof payload.enabled === 'boolean') {
        this.preferences.autoOrchestration = payload.enabled;
      }
      if (event.type === 'host-plan-preferences' && payload.schemaVersion === 1
        && typeof payload.autoOrchestration === 'boolean' && typeof payload.autoApprovePlans === 'boolean') {
        this.preferences = { autoOrchestration: payload.autoOrchestration, autoApprovePlans: payload.autoApprovePlans };
      }
      if (event.type === 'plan-authority-approved' && typeof payload.decisionId === 'string') grants.set(payload.decisionId, payload);
      if (event.type === 'plan-install-committed' && typeof payload.decisionId === 'string') {
        const grant = grants.get(payload.decisionId);
        const taskIds = Array.isArray(grant?.normalizedTasks)
          ? grant.normalizedTasks.map((task) => objectRecord(task).id)
          : undefined;
        if (taskIds?.length && grant?.planVersion === payload.planVersion && payload.schemaVersion === 1
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
    this.restoreProposals(journal, installed);
  }

  private restoreProposals(journal: PersistedMeetingEvent[], installed: Set<string>) {
    let legacyProposal = false;
    for (const event of journal) {
      const payload = objectRecord(event.payload);
      if (event.type === 'plan-proposal-v1') {
        const proposal = payload as Partial<PlanProposal> & { schemaVersion?: number };
        if (proposal.schemaVersion === 1 && typeof proposal.proposalId === 'string' && Number.isSafeInteger(proposal.proposalVersion)
          && Number.isSafeInteger(proposal.basePlanVersion) && proposal.brief && Array.isArray(proposal.tasks)
          && proposal.tasks.every((task) => planMeetingTaskSchema.safeParse(task).success)
          && proposal.contentHash === hash({ normalized: proposal.tasks, brief: proposal.brief })) {
          this.pending = proposal as PlanProposal;
          this.version = Math.max(this.version, this.pending.proposalVersion);
          legacyProposal = false;
        }
      } else if (event.type === 'plan-proposed' && Array.isArray(payload.tasks) && payload.tasks.length > 0
        && payload.tasks.every((task) => planMeetingTaskSchema.safeParse(task).success)) {
        const tasks = payload.tasks as PlanMeetingTask[];
        const parsedBrief = meetingPlanBriefInputSchema.safeParse(payload.brief);
        const brief = normalizeMeetingPlanBrief(parsedBrief.success ? parsedBrief.data : undefined, tasks);
        this.pending = {
          proposalId: event.id, proposalVersion: ++this.version, basePlanVersion: this.scheduler.getPlanVersion(),
          tasks, brief, contentHash: hash({ normalized: tasks, brief }),
        };
        legacyProposal = true;
      }
      if (event.type !== 'plan-approval-result' && event.type !== 'plan-authority-approved') continue;
      if (typeof payload.approvalCommandId !== 'string' || typeof payload.fingerprint !== 'string'
        || typeof payload.proposalId !== 'string') {
        if (legacyProposal && payload.source === 'plan-meeting-confirmation') this.pending = null;
        continue;
      }
      const committed = installed.has(payload.approvalCommandId);
      const saved = objectRecord(payload.result);
      const result: PlanDecision = saved.ok === true || committed
        ? { ok: true }
        : { ok: false, error: typeof saved.error === 'string' ? saved.error : '上次审批未确认安装，请重新确认计划' };
      if (!committed && !payload.result) this.uncertain.add(payload.proposalId);
      else this.uncertain.delete(payload.proposalId);
      this.results.set(payload.approvalCommandId, { fingerprint: payload.fingerprint, result });
      if (result.ok && this.pending?.proposalId === payload.proposalId) this.pending = null;
    }
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
