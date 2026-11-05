// orchestrator.ts — coordinates M HostGroups (each: 1 Host + N Workers).
//
//   HostGroup "default" (Claude Code, always present)
//     ├── Host (Talker — Haiku-class, meeting-MCP tools, faces the user)
//     └── Workers (0..4, Sonnet-class, full Claude Code preset)
//
//   HostGroup "codex-host" (added via addHost)
//     ├── Host (Codex agent)
//     └── Workers (0..4, Codex sessions)
//
// When only the default HostGroup exists, behavior is identical to the
// pre-multi-host architecture. The public API is unchanged.
//
// MCP tool callbacks for both roles live in `meeting-mcp.ts` and reach back
// here through the `OrchestratorBridge` interface this class implements.
// Recap (post-meeting Haiku summarisation) lives in `recap.ts`. Per-worker
// scheduling, spawn / dispose / DAG cascades, file-collision tracking, and
// the bursty worker→talker update queue live in `worker-scheduler.ts` —
// this file owns the coordination layer and delegates all per-host mechanics
// to HostGroup.

import { createHash, randomUUID } from 'node:crypto';
import { ClaudeSession, type SessionEvent } from './claude-session.js';
import type { BackendSession, BackendSessionSnapshot } from './backends/cli-backend.js';
import { getBackendRegistry } from './backends/registry.js';
import {
  hostTerminalWorkerId,
  isNativeCliWorkerBackend,
  isTerminalWorkerBackend,
} from './backends/terminal-cli-adapter.js';
import { parsePocketVibeRemoteTarget, parsePocketVibeRemoteHosts, remoteSessionKey, remoteMentionIds, resolveRemoteTarget, REMOTE_ATTACHMENT_ERROR, type PocketVibeRemoteTarget, type PocketVibeRemoteHost, type PocketVibeRemoteDirectory } from './backends/pocket-vibe-target.js';
import type { AutoApproveScope } from './auto-approve-policy.js';
import {
  coerceWorkspaceModeForBaseline,
  normalizeMeetingPlanBrief,
  normalizePlanMeetingTasks,
  type AppliedTaskDefaults,
  type MeetingPlanBrief,
  type MeetingPlanBriefInput,
  type PlanMeetingTask,
  type PlanMeetingTaskInput,
} from './meeting-tools.js';
import {
  DecisionWatcher,
  createDecisionDoc,
  type CreateDecisionPayload,
  type ResolvedDecision,
} from './decisions.js';
import {
  appendEntry,
  computeProjectId,
  type MemoryCategory,
} from './memory.js';
import { getBackendAuth, getSettings } from './store.js';
import { homedir } from 'node:os';
import {
  SAVE_MEMORY_PER_SESSION_LIMIT,
  extractText,
  inferSpecialty,
  titleFromDescription,
} from './orchestrator-helpers.js';
import {
  type DecisionCreationResult,
  type MeetingNotes,
  type OrchestratorBridge,
  type SaveMemoryResult,
  type SteerResult,
} from './meeting-mcp.js';
import { buildTalkerMcp, buildWorkerMcp } from './meeting-mcp.js';
import { BrowserTabManager } from './browser-tab-manager.js';
import { startRecap, type RecapHandle } from './recap.js';
import type { WorkerScheduler, WorkerSchedulerOpts, SessionFactory } from './worker-scheduler.js';
import { HostRuntime } from './host/runtime.js';
import { buildComputerUseMcp } from './computer-use-mcp.js';
import { buildBrowserMcp } from './browser-mcp.js';
import { HostInbox, type UserHostInputSource } from './host/inbox.js';
import { ensureDir, maybeAppendGitignore } from './attachments/workspace.js';
import { listAuthorizedAssetReferences } from './attachments/assets.js';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { HostGroup } from './host-group.js';
import { CrossHostBus } from './cross-host-bus.js';
import {
  MeetingRepository,
  type PersistedMeetingEvent,
} from './meeting-repository.js';
import { TaskMailbox } from './task-mailbox.js';
import {
  projectMeetingTasks,
  type TaskProjectionResult,
} from './task-projection.js';
import { DeliveryHarness } from './delivery-harness.js';
import { CommandDeliveryVerifier } from './delivery-verifier.js';
import { DeterministicDeliveryReviewer } from './delivery-reviewer.js';
import { GitDeliveryIntegrator } from './delivery-integrator.js';
import { IntegrationQueue } from './integration-queue.js';
import {
  buildMeetingDelivery,
  MeetingDeliveryNotReadyError,
  parseMeetingDelivery,
  publishedMeetingDelivery,
  type FinalMeetingDecision,
  type MeetingDelivery,
} from './meeting-delivery.js';
import { prepareFrozenDeliveryCandidate } from './delivery-candidate.js';
import {
  CoordinatorReviewDriver,
  type CoordinatorReviewBriefing,
} from './coordinator-review-driver.js';
import {
  listUncoveredCoordinatorReviewChunkIds,
  safeCoordinatorReviewProjection,
  type CoordinatorReviewFinding,
  type CoordinatorReviewSession,
} from './coordinator-review.js';
import { authorizeMeetingCommand, reviewCommandSchema, type MeetingCommandResult } from './meeting-command.js';
import { TaskWorkspaceManager } from './task-workspace.js';
import { DiagnosticLogger } from './diagnostic-logger.js';
import { resolveDefaultWorkerBackendId } from './worker-backend-default.js';
import { nativeWorkerBackendId } from './worker-backend-policy.js';
import { PORTABLE_MEETING_COMMAND_PROMPT, REVIEWER_PROMPT } from './orchestrator-prompts.js';
import {
  assessConfiguredWorkerRuntime,
  probeWorkerRuntimeVersion,
} from './backends/worker-runtime-contract.js';
import {
  backendRuntimeSchema,
  type BackendRuntime,
} from './backends/task-profile.js';
import type {
  MeetingPlan,
  MeetingPlanNode,
  OrchestratorEvent,
  OrchestratorSource,
  WorkerSpecialtyKind,
  CoordinatorBriefing,
  WorkerStatusKind,
} from './orchestrator-types.js';
import type { SDKMessage, SDKUserMessage } from './claude-cli/types.js';
import type { ObservedSnapshot } from './observe/types.js';
import {
  listBoardableObservedSessionRows,
  runObservedSessionAction,
  type ObservedActionOutcome,
  type ObservedSessionToolRow,
} from './observe/session-actions.js';
import type {
  AuthorizedMeetingContextSource,
  ContextSelection,
} from './task-context.js';
import {
  backendEffectiveProfileSchema,
  type BackendEffectiveProfile,
  type ContextPackage,
  type TaskAuthorityGrant,
  type TaskExecutionProfile,
  type TaskMessage,
} from './task-collaboration.js';
import {
  compileTaskAuthority,
  hashTaskAuthorityRequest,
} from './task-authority.js';
import { taskBudgetSchema, type TaskBudget } from './task-budget.js';
import {
  assertRecoveryActionAllowed,
  assessTaskRecovery,
  unresolvedNativeLaunches,
  type TaskRecoveryAction,
} from './task-recovery.js';
import type { HostProfile } from './orchestrator-types.js';

export const MAX_HOSTS = 3;

/** Kickoff for an empty project (docs/design/2026-10-30-project-rooms-and-kickoff.md):
 *  brainstorm = read-only research; develop = code in a worktree. */
export type KickoffMode = 'brainstorm' | 'develop';

/** Map an expert Host backend to its admitted Native CLI Worker counterpart
 *  when available (`claude-code` -> `claude-code-terminal`, `codex` ->
 *  `codex-terminal`); other backends remain on themselves. */
export function terminalWorkerBackendFor(backendId: string): string {
  if (backendId === 'claude-code') return 'claude-code-terminal';
  if (backendId === 'codex') return 'codex-terminal';
  return backendId;
}

export function kickoffTaskPrompt(mode: KickoffMode, profile: HostProfile): string {
  return mode === 'brainstorm'
    ? `你是「${profile.title} ${profile.name}」派出的调研子 Agent。项目刚开始，还没有 Issue 和计划。只读调查当前目录：README、目录结构、已有代码和文档；`
      + '整理出项目现状、可能的目标用户与要解决的问题、三个可选方向及各自取舍。不要修改任何文件。把结论写进最终工作报告，专家会继续给你派后续调研。'
    : `你是「${profile.title} ${profile.name}」派出的开发子 Agent。项目刚开始。先只读了解目录和已有代码，再按项目语言搭最小可运行骨架`
      + '（README 说明如何运行、一个可执行入口、一条能跑的测试）。只改工作树里的文件；不确定的选型写进工作报告让专家决定。专家会继续给你派后续开发。';
}

export type {
  OrchestratorEvent,
  OrchestratorSource,
  MeetingPlan,
  MeetingPlanNode,
  WorkerStatusKind,
  WorkerSpecialtyKind,
} from './orchestrator-types.js';

/** Default host group id. Always present in every meeting. */
const DEFAULT_HOST_ID = 'default';
type ExpertAsk = {
  requestId: string;
  fromHostId: string;
  targetHostId: string;
  question: string;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
  answering?: boolean;
  timedOut?: boolean;
};
type Reviewer = {
  reviewId: string;
  session?: BackendSession;
  busy: boolean;
  finishing?: boolean;
  commands: Promise<void>;
  results: Array<{ commandId: string; result: MeetingCommandResult }>;
  completedTurns: Set<string>;
};
const DEFAULT_BACKEND_ID = 'claude-code';

interface OrchestratorOpts {
  /** Shared meetings retain this Orchestrator as their sole planning authority.
   * These hooks replace local execution, never mirror it. */
  sharedExecution?: {
    propose(tasks:PlanMeetingTaskInput[],brief:MeetingPlanBrief):Promise<void>;
    consult(memberId:string,text:string):Promise<unknown>;
    control(taskId:string,operation:string,text?:string):Promise<unknown>;
  };
  emit: (e: OrchestratorEvent) => void;
  cwd: string;
  autoApproveScope?: AutoApproveScope;
  workerEnv?: NodeJS.ProcessEnv;
  /** Model override for the talker session. When unset the talker defaults to
   *  Haiku for latency; a custom gateway/model (ANTHROPIC_MODEL) is threaded
   *  here so the talker doesn't request a model the gateway can't serve. */
  talkerModel?: string;
  /** Optional override for ClaudeSession construction. Production code leaves
   *  this unset; tests inject a stub so cleanup paths can run without
   *  spawning the real Claude CLI subprocess. */
  sessionFactory?: SessionFactory;
  /** S3: native OS confirmer for destructive tool calls when auto-approve is
   *  on. Main wires this to dialog.showMessageBox so a compromised renderer
   *  cannot fake the approval. Threaded through to every ClaudeSession. */
  confirmDestructive?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
  /** Optional browser tab manager for embedded browser MCP tools. When
   *  provided, all workers get browser_navigate/screenshot/click/type tools. */
  browserTabManager?: BrowserTabManager;
  /** Backend ID for the default host group. Defaults to 'claude-code'. */
  defaultBackendId?: string;
  /** Existing Meeting identity and native Host handles selected by the user for recovery. */
  meetingId?: string;
  /** Runtime session identity shared with the renderer for terminal-host PTY routing.
   *  This is deliberately separate from the durable meetingId during recovery. */
  ptyScopeId?: string;
  recoverySeq?: number;
  resumeBackendSessions?: Record<string, BackendSessionSnapshot>;
  remoteHosts?: PocketVibeRemoteHost[];
  recoveredTasks?: Array<Record<string, unknown>>;
  recoveredPlanVersion?: number;
  recoveredCoordinatorHostId?: string;
  recoveredReviewSessions?: CoordinatorReviewSession[];
  /** Host groups invited before the previous shutdown (from the recovered
   *  snapshot's `hosts` list). `start()` re-adds every non-default entry so
   *  invited agents come back with the meeting; 'default' is always created
   *  by the constructor and must be skipped here. `profile` is the expert's
   *  职能＋名字 when the snapshot recorded one. */
  recoveredHosts?: Array<{ id: string; backendId: string; profile?: HostProfile }>;
  /** Expert-owned sub-agent tasks from the previous snapshot. Without this,
   *  a restarted app loses the 子 Agent tab and 重新开始. */
  recoveredOwnedTasks?: Array<{ taskId: string; ownerHostId: string; input: PlanMeetingTaskInput }>;
  /** Workspace-tab notes from the previous snapshot. */
  recoveredMeetingNotes?: MeetingNotes;
  /** How long an active review may sit without Coordinator progress before the
   * stall budget is charged. Set to 0 to disable the watchdog in tests. */
  reviewStallTimeoutMs?: number;
  /** How long a Coordinator -> expert `ask_host` may sit without any talker
   *  reply from the target before the Coordinator is nudged to decide whether
   *  to keep waiting or proceed. Host-to-host asks have no request/response
   *  correlation otherwise. Set to 0 to disable the watchdog in tests. */
  hostAskTimeoutMs?: number;
  /** Optional workspace allocator override. Production uses the Meeting-owned
   * manager created below; tests with stub sessions may inject one to exercise
   * the real managed-worktree delivery path without spawning a backend CLI. */
  workspaceManager?: TaskWorkspaceManager;
  /** Live observed-session snapshot provider (main.ts's ObserveService cache).
   *  Feeds the Host observed_session_* MCP tools; defaults to an empty
   *  snapshot so tests and non-observed contexts degrade to "nothing
   *  actionable". */
  getObservedSnapshot?: () => ObservedSnapshot;
}

export class Orchestrator implements OrchestratorBridge {
  private sharedExecution?:OrchestratorOpts['sharedExecution'];
  /** All host groups in this meeting. Always has at least 'default'. */
  private hostGroups = new Map<string, HostGroup>();
  /**
   * Host that owns talker coordination (plan chat, review turns, user routing).
   * This can move via setCoordinator; execution stays on DEFAULT_HOST_ID.
   */
  private coordinatorHostId = DEFAULT_HOST_ID;
  /** AME-D14 职能＋名字 for experts; the coordinator stays 助理. */
  private hostProfiles = new Map<string, HostProfile>();
  /** taskId → expert hostId that owns it (AME-D14 sub-agent ownership). */
  private taskOwners = new Map<string, string>();
  /** Plan input of each expert-owned task, so a stopped sub-agent can restart. */
  private ownedTaskInputs = new Map<string, PlanMeetingTaskInput>();
  private meetingNotes: MeetingNotes = { conclusions: [], decisions: [], workItems: [], todos: [] };
  /** The meeting owns the task graph and Worker lifetimes across Host sessions. */
  private readonly hostRuntime: HostRuntime;
  private get meetingScheduler(): WorkerScheduler { return this.hostRuntime.scheduler; }
  private readonly hostInbox: HostInbox;
  private emit: (e: OrchestratorEvent) => void;
  private cwd: string;
  private autoApproveScope: AutoApproveScope;
  private workerEnv: NodeJS.ProcessEnv | undefined;
  private talkerModel: string | undefined;
  private confirmDestructive: ((toolName: string, input: Record<string, unknown>) => Promise<boolean>) | undefined;
  private browserTabManager: BrowserTabManager | undefined;
  private closed = false;
  private unsupportedRecovery = false;
  private projectId: string;
  private meetingId: string;
  private readonly ptyScopeId: string;
  private repository: MeetingRepository;
  private repositoryReady: Promise<void>;
  private taskMailbox: TaskMailbox;
  private taskProjection: TaskProjectionResult = { tasks: [], diagnostics: [] };
  private deliveryHarness: DeliveryHarness;
  private coordinatorReviewDriver: CoordinatorReviewDriver;
  private integrationQueue: IntegrationQueue;
  private deliveryVerifier: CommandDeliveryVerifier;
  private expectedUserBaseRevision: string;
  private finalMeetingDelivery: MeetingDelivery | null = null;
  private finalMeetingDecision: FinalMeetingDecision | null = null;
  private finalDeliveryBuild?: Promise<MeetingDelivery | null>;
  private workspaceManager: TaskWorkspaceManager;
  private customWorkspaceManager: boolean;
  private readonly getObservedSnapshot: () => ObservedSnapshot;
  private diagnostics: DiagnosticLogger;
  private resumeBackendSessions: Record<string, BackendSessionSnapshot>;
  private remoteTargets = new Map<string, PocketVibeRemoteTarget>();
  private recoveredTasks: Array<Record<string, unknown>>;
  private recoveringCoordinatorHostId?: string;
  private recoveredHosts: Array<{ id: string; backendId: string; profile?: HostProfile }>;
  private recoveredOwnedTasks: Array<{ taskId: string; ownerHostId: string; input: PlanMeetingTaskInput }>;
  private recoveredMeetingNotes: MeetingNotes | null;
  private recoveredPlanVersion: number;
  private saveMemoryCallsThisSession = 0;
  private reviewer?: Reviewer;
  private readonly queuedReviews = new Map<string, CoordinatorReviewBriefing>();
  private reviewStallTimer: ReturnType<typeof setInterval> | null = null;
  private readonly reviewStallTimeoutMs: number;
  /** Coordinator -> expert asks still awaiting any talker reply. Keyed by the
   *  target host id (one outstanding ask per expert; a new ask replaces it and
   *  re-arms the timer). Cleared when the expert emits any talker message. */
  private readonly pendingHostAsks = new Map<string, ExpertAsk>();
  private readonly hostAskTimeoutMs: number;
  /** Cross-host messages that arrived before the target Host talker was ready. */
  private pendingCrossHostMessages = new Map<string, Array<{ from: string; text: string }>>();
  // Active end-of-meeting recap, if any. Tracked so `interrupt()` can reach
  // into a closed orchestrator and abort the recap pass (B4) — otherwise
  // the user pressing the interrupt button after `end()` was a no-op while
  // Haiku continued to chew through the transcript.
  private recapHandle: RecapHandle | null = null;
  private sessionFactory: SessionFactory;
  // Async decision side-channel. Each open decision has a fs.watch entry that
  // fires onDecisionResolved() when the user fills in "✅ 确认结论". Cleaned up
  // in end().
  private decisions: DecisionWatcher = new DecisionWatcher();
  private decisionMeta: Map<string, { question: string; path: string }> = new Map();
  private resolvedDecisionContext = new Map<string, { id: string; summary: string }>();

  // Cross-host messaging bus. Each HostGroup subscribes on creation; the
  // orchestrator publishes when cross-host events occur (file writes, decision
  // resolutions, etc.).
  private crossHostBus = new CrossHostBus();

  // Cached in-flight `end()` Promise. Subsequent calls return the same Promise
  // so callers can `await orchestrator.end()` repeatedly without re-running
  // teardown. Distinct from `this.closed` so we can both gate the work AND
  // surface the async cleanup tail (recap) to a waiting before-quit handler.
  private endPromise: Promise<void> | null = null;
  private executionCleanup: Promise<void> | null = null;
  private unresolvedWorkerStops: string[] = [];

  // Process-level fallback: if main.ts forgets (or crashes) before its own
  // before-quit / window-all-closed hooks fire, `process.exit` still gives us
  // one synchronous chance to release native resources held by live workers.
  private static liveInstances: Set<Orchestrator> = new Set();
  private static shutdownHookInstalled = false;

  private static ensureShutdownHook() {
    if (Orchestrator.shutdownHookInstalled) return;
    Orchestrator.shutdownHookInstalled = true;
    const handler = () => {
      for (const inst of Orchestrator.liveInstances) {
        try { inst.end(); } catch { /* ignore */ }
      }
      Orchestrator.liveInstances.clear();
    };
    // 'exit' is sync-only and last-ditch; that's the right shape for "kill
    // anything still alive on the way out". We deliberately don't grab
    // SIGINT/SIGTERM — Electron owns those and would route them through its
    // own quit lifecycle, where main.ts's before-quit handler runs end()
    // for us via the normal path.
    process.once('exit', handler);
  }

  constructor(opts: OrchestratorOpts) {
    this.sharedExecution=opts.sharedExecution;
    this.emit = opts.emit;
    this.cwd = opts.cwd;
    this.autoApproveScope = opts.autoApproveScope ?? 'off';
    this.workerEnv = opts.workerEnv;
    this.talkerModel = opts.talkerModel;
    this.confirmDestructive = opts.confirmDestructive;
    this.browserTabManager = opts.browserTabManager;
    this.projectId = computeProjectId(this.cwd);
    this.meetingId = opts.meetingId ?? randomUUID();
    this.ptyScopeId = opts.ptyScopeId ?? this.meetingId;
    this.resumeBackendSessions = opts.resumeBackendSessions ?? {};
    this.recoveredTasks = opts.recoveredTasks ?? [];
    this.recoveringCoordinatorHostId = opts.recoveredCoordinatorHostId;
    this.recoveredHosts = opts.recoveredHosts ?? [];
    this.recoveredOwnedTasks = opts.recoveredOwnedTasks ?? [];
    this.recoveredMeetingNotes = opts.recoveredMeetingNotes ?? null;
    this.recoveredPlanVersion = Number.isSafeInteger(opts.recoveredPlanVersion)
      && (opts.recoveredPlanVersion ?? 0) >= 0
      ? opts.recoveredPlanVersion!
      : 0;
    this.repository = new MeetingRepository(this.meetingId, opts.recoverySeq);
    this.taskMailbox = new TaskMailbox(this.repository);
    this.customWorkspaceManager = opts.workspaceManager !== undefined;
    this.workspaceManager = opts.workspaceManager
      ?? new TaskWorkspaceManager(this.meetingId, this.cwd);
    this.getObservedSnapshot = opts.getObservedSnapshot
      ?? (() => ({ sessions: [], scannedAt: 0 }));
    const baseline = this.workspaceManager.inspectBaseline();
    const deliveryVerifier = new CommandDeliveryVerifier();
    this.deliveryVerifier = deliveryVerifier;
    this.expectedUserBaseRevision = baseline.revision;
    this.integrationQueue = new IntegrationQueue({
      meetingId: this.meetingId,
      expectedUserBaseRevision: baseline.revision,
      integrator: new GitDeliveryIntegrator(
        this.cwd,
        this.meetingId,
        path.join(homedir(), '.ahastation', 'integration-worktrees'),
      ),
      verify: (view, candidate, workspace) => deliveryVerifier.verify({
        deliveryId: view.id,
        ...(view.spec.taskId ? { taskId: view.spec.taskId } : {}),
        attempt: candidate.attempt,
        meetingId: view.meetingId,
        goal: view.spec.objective,
        acceptanceCriteria: structuredClone(view.spec.acceptanceCriteria),
        workspace,
        sourceRevision: view.sourceRevision,
      }, candidate.report),
      append: async (type, payload) => {
        const record = payload as {
          taskId?: string;
          attempt?: number;
        };
        await this.repository.appendTaskEvent(type, {
          schemaVersion: 1,
          taskId: record.taskId ?? 'unknown-integration-task',
          ...(record.attempt ? { attempt: record.attempt } : {}),
          data: payload,
        });
      },
      flush: () => this.repository.flush(),
    });
    this.reviewStallTimeoutMs = opts.reviewStallTimeoutMs ?? 180_000;
    this.hostAskTimeoutMs = opts.hostAskTimeoutMs ?? 120_000;
    this.coordinatorReviewDriver = new CoordinatorReviewDriver({
      append: async (type, payload) => {
        const projection = (payload as {
          session?: { taskId?: string; deliveryId?: string; attempt?: number };
        }).session;
        await this.repository.appendTaskEvent(type, {
          schemaVersion: 1,
          taskId: projection?.taskId ?? projection?.deliveryId ?? 'unknown-delivery',
          ...(projection?.attempt ? { attempt: projection.attempt } : {}),
          data: payload,
        });
      },
      flush: () => this.repository.flush(),
      notifyCoordinator: (briefing) => this.notifyCoordinatorReview(briefing),
      onCompleted: async (session) => {
        try { await this.deliveryHarness.completeCoordinatorReview(session.deliveryId, session); }
        finally { this.releaseReviewer(session.id); }
      },
      onReworkRequested: async (session) => {
        try { await this.meetingScheduler.requestCoordinatorRework(session.deliveryId, session); }
        finally { this.releaseReviewer(session.id); }
      },
      onPaused: (session) => {
        this.releaseReviewer(session.id);
        this.escalateStalledReview(session);
      },
    });
    for (const session of opts.recoveredReviewSessions ?? []) {
      try {
        this.coordinatorReviewDriver.restore(session);
      } catch {
        // A malformed review projection is never made authoritative.
      }
    }
    this.deliveryHarness = new DeliveryHarness({
      executionMode: 'external',
      verifier: deliveryVerifier,
      reviewer: new DeterministicDeliveryReviewer(),
      candidatePreparer: {
        prepare: (order, report, verification) =>
          prepareFrozenDeliveryCandidate({ order, report, verification }),
      },
      reviewDriver: this.coordinatorReviewDriver,
      integrator: {
        integrate: (view, candidate) => this.integrationQueue.enqueue(view, candidate),
      },
    });
    this.diagnostics = new DiagnosticLogger(this.meetingId);
    this.repositoryReady = this.repository
      .append(opts.meetingId ? 'meeting-recovered' : 'meeting-created', {
        cwd: this.cwd, runtimeVersion: 1, eventSchemaVersion: 1, transportProtocolVersion: 2,
        promptRevision: 'host-2026-11-04-v1',
      })
      .then(() => undefined, () => undefined);
    this.hostInbox = new HostInbox(
      this.repository,
      (id) => {
        const host = this.hostGroups.get(id);
        const session = host?.isReady() ? host.getHost() : null;
        if (this.closed || !host || !session) return undefined;
        return (input, sourceCursor, content) => {
          if (this.closed || this.hostGroups.get(id)?.getHost() !== session) return false;
          const context = host.backendId === 'pocket-vibe' ? '' : this.hostTurnContext(id, sourceCursor);
          if (content) {
            session.sendUserContent(context ? [...content, { type: 'text', text: context }] : content, 'high');
            return true;
          }
          const text = input.direct
            ? `[direct user mention from meeting chat]\n${input.deliveryText || input.text}\n\n直接用普通 assistant 文本回答用户；不要主持、派任务或输出 meeting-command。`
            : input.text;
          session.sendUserText(text + context, 'high');
          return true;
        };
      },
      (receipt, source) => {
        this.safeEmit({ source: 'system', hostId: receipt.hostId, event: { kind: 'host-input-state', ...receipt } });
        if (source !== 'worker-question' || receipt.state !== 'submitted') return;
        const messageId = receipt.inputId.slice('worker-question-'.length);
        void this.markHostQuestionSubmitted(messageId);
      },
      (error) => this.diagnostics.log('host-inbox-failed', { error: String(error) }),
    );
    this.sessionFactory = opts.sessionFactory ?? Orchestrator.defaultClaudeFactory;

    // Create the default HostGroup. Use the user's preferred backend if specified.
    const defaultBackend = opts.defaultBackendId ?? DEFAULT_BACKEND_ID;
    const defaultBackendAdapter = getBackendRegistry().get(defaultBackend);
    if (!defaultBackendAdapter) throw new Error(`backend '${defaultBackend}' is not registered`);
    if (!defaultBackendAdapter.capabilities.coordinate) {
      throw new Error(`backend '${defaultBackend}' cannot coordinate`);
    }
    this.hostRuntime = new HostRuntime(this.meetingSchedulerOptions(defaultBackend), this.repository, (event) => this.safeEmit(event), () => this.closed);
    this.createHostGroup(DEFAULT_HOST_ID, defaultBackend);
    for (const host of parsePocketVibeRemoteHosts(opts.remoteHosts)) {
      if (this.hostGroups.size >= MAX_HOSTS) break;
      this.remoteTargets.set(host.id, host.remoteTarget);
      this.createHostGroup(host.id, 'pocket-vibe');
    }
    if (this.recoveredTasks.length > 0) {
      this.meetingScheduler.restoreTasks(this.recoveredTasks);
    }

    Orchestrator.liveInstances.add(this);
    Orchestrator.ensureShutdownHook();
  }

  // ---------------------------------------------------------------------------
  // HostGroup management

  /** Build a SessionFactory only after the selected backend passes its role gate. */
  private buildSessionFactory(
    backendId: string,
    actorHostId = DEFAULT_HOST_ID,
    purpose: 'host' | 'worker' | 'reviewer' = 'host',
  ): SessionFactory {
    if (purpose === 'worker' && !isNativeCliWorkerBackend(backendId)) {
      throw new Error(`unsupported-contract: Worker '${backendId}' 必须使用本地原生 CLI`);
    }
    const backend = getBackendRegistry().get(backendId);
    if (!backend) throw new Error(`backend '${backendId}' is not registered`);
    if (purpose === 'worker' && !backend.capabilities.executeTasks) {
      throw new Error(`backend '${backendId}' cannot execute delivery tasks`);
    }
    // If a test-injected factory is set, use it for all backends.
    if (this.sessionFactory !== Orchestrator.defaultClaudeFactory) {
      return this.sessionFactory;
    }
    // Wrap the adapter's createSession to accept ClaudeSession-shaped opts,
    // translating the fields that differ between the two interfaces.
    return (opts) => {
      const so = (opts.sessionOptions ?? {}) as Record<string, unknown>;
      const isCurrent = typeof so.isCurrentHostSession === 'function'
        ? so.isCurrentHostSession as () => boolean
        : () => false;
      let systemPrompt: string | undefined;
      if (typeof so.systemPrompt === 'string') {
        systemPrompt = so.systemPrompt;
      } else if (so.systemPrompt && typeof so.systemPrompt === 'object' && 'append' in so.systemPrompt) {
        systemPrompt = (so.systemPrompt as { append?: string }).append;
      }
      // MCP-less backends speak the meeting protocol through fenced
      // ```meeting-command frames in their reply text instead of native
      // tools; teach them the portable command vocabulary.
      const remoteTarget = backendId === 'pocket-vibe' && purpose === 'host'
        ? this.remoteTargets.get(actorHostId) : undefined;
      if (remoteTarget) {
        // A selected native session executes on its own computer. It must not
        // inherit the local Talker's "delegate instead of edit" instructions.
        systemPrompt = `你是当前会议的远端成员「${remoteTarget.title}」。\n`
          + `在电脑端已有 ${remoteTarget.provider} 原生会话 ${remoteTarget.session_id} 中连续处理发给你的指令。\n`
          + `所有项目读取、修改和验证必须在电脑端项目目录 ${remoteTarget.cwd} 中执行。\n`
          + '直接在该远端会话执行任务，以普通 assistant 文本反馈结果、修改和失败原因。不要向 Station 派发本机 Worker、创建新会话或输出 meeting-command。';
      } else if (purpose === 'host' && (backendId === 'codex' || backendId === 'pocket-vibe')) {
        systemPrompt = `${systemPrompt ?? ''}${PORTABLE_MEETING_COMMAND_PROMPT}`;
      }
      const parentAuthBackendId = backendId === 'claude-code-terminal'
        ? 'claude-code'
        : backendId === 'codex-terminal'
          ? 'codex'
          : null;
      const authEntry = getBackendAuth(backendId)
        ?? (parentAuthBackendId ? getBackendAuth(parentAuthBackendId) : undefined);
      const auth = authEntry
        ? {
            authMode: authEntry.authMode,
            apiKey: authEntry.apiKey,
            baseUrl: authEntry.baseUrl,
            model: authEntry.model,
          }
        : { authMode: 'none' as const };
      // Every backend runs with the real HOME so OAuth/config locations
      // (~/.claude, ~/.codex) stay visible to each CLI.
      const backendBaseEnv = { ...(opts.envOverride ?? {}) };
      backendBaseEnv.HOME = homedir();
      backendBaseEnv.USERPROFILE = homedir();
      const env = backend.buildEnv(auth, backendBaseEnv);
      const parsedTaskProfile = backendEffectiveProfileSchema.safeParse(so.taskProfile);
      const taskProfile = parsedTaskProfile.success ? parsedTaskProfile.data : undefined;
      const {
        taskProfile: _taskProfile,
        resumeSessionId,
        nativeCliWorker,
        ...backendExtra
      } = so;
      const requestedModel = taskProfile?.model
        ?? (typeof so.model === 'string' ? so.model : undefined);
      // Codex honors only the model from user settings. Every other source
      // (the talker's Claude-centric fallback, compiled task profiles) can
      // name a model the configured provider doesn't serve; with no override
      // the CLI falls back to ~/.codex/config.toml's own `model`.
      const model = backendId === 'codex'
        ? auth.model
        : isNativeCliWorkerBackend(backendId)
          ? (taskProfile?.model && taskProfile.model !== 'auto'
              ? taskProfile.model
              : (auth.model ?? taskProfile?.model ?? backend.capabilities.defaultModel))
          : taskProfile
            ? taskProfile.model
            : backendId === 'claude-code'
              ? (auth.model ?? requestedModel ?? backend.capabilities.defaultModel)
              : requestedModel?.startsWith('claude-')
                ? (auth.model ?? backend.capabilities.defaultModel)
                : (auth.model ?? requestedModel ?? backend.capabilities.defaultModel);
      return backend.createSession(
        {
          cwd: opts.cwd,
          ...(backendId === 'pocket-vibe' && purpose === 'host'
            ? { remoteTarget } : {}),
          systemPrompt,
          model,
          taskProfile,
          ...(nativeCliWorker && typeof nativeCliWorker === 'object'
            ? {
                nativeCliWorker: nativeCliWorker as import('./backends/cli-backend.js').BackendSessionConfig['nativeCliWorker'],
              }
            : {}),
          env,
          mcpServers: so.mcpServers as Record<string, unknown> | undefined,
          skills: Array.isArray(so.skills) ? so.skills : undefined,
          autoApproveScope: opts.autoApproveScope,
          confirmDestructive: opts.confirmDestructive,
          hostId: actorHostId,
          meetingId: this.meetingId,
          resumeSessionId: purpose === 'host'
            ? this.resumeBackendSessions[actorHostId]?.sessionId
            : typeof resumeSessionId === 'string'
              ? resumeSessionId
              : undefined,
          executionRole: purpose === 'reviewer' ? 'host' : purpose,
          extra: {
            ...backendExtra,
            ...(remoteTarget ? { onRemoteTargetResolved: (target: PocketVibeRemoteTarget) => {
              if (!isCurrent()) throw new Error('Host session was replaced');
              if ([...this.remoteTargets.entries()].some(([id, existing]) => id !== actorHostId && remoteSessionKey(existing) === remoteSessionKey(target))) {
                throw new Error('同一电脑的原生会话已加入会议，请移除重复成员。');
              }
              Object.assign(remoteTarget, target);
              void this.snapshotActiveMeeting().catch((err) => console.error('[remote-session] snapshot failed:', err));
            } } : {}),
            ...(backendId === 'codex' ? { codexTransport: 'app-server' } : {}),
            ...(purpose === 'reviewer' && backendId === 'codex' ? { restrictCodexReviewerTools: true } : {}),
            // Kimi: ACP mode only understands device-code OAuth — it ignores
            // API keys entirely. When an apiKey is configured, fall back to
            // the one-shot CLI mode (buildEnv injects MOONSHOT_API_KEY).
            ...(backendId === 'kimi' && !auth.apiKey ? { kimiTransport: 'acp' } : {}),
            // Terminal-mode hosts run their TUI as the host session itself:
            // pin the pty worker id so the renderer can attach a RealTerminal
            // (mirrored helper in src/lib/terminal-backends.ts).
            ...(purpose === 'host' && isTerminalWorkerBackend(backendId)
              ? { workerId: hostTerminalWorkerId(this.ptyScopeId, actorHostId) }
              : {}),
            ...(purpose === 'host' ? {
              meetingCommandHandler: (raw: unknown) => this.executeMeetingCommand(actorHostId, raw, isCurrent),
              meetingCommandFeedback: !this.sharedExecution && !remoteTarget,
            } : {}),
          },
        },
        // BackendSessionEvent is structurally compatible with SessionEvent
        // (same kind discriminators, NormalizedMessage mirrors SDKMessage shape).
        opts.emit as (e: import('./backends/cli-backend.js').BackendSessionEvent) => void,
      );
    };
  }

  /** Default ClaudeSession factory, used as identity check for test overrides. */
  private static readonly defaultClaudeFactory: SessionFactory =
    (o) => new ClaudeSession(o) as unknown as BackendSession;

  private defaultWorkerBackendId(): string {
    return resolveDefaultWorkerBackendId(this.defaultHost().backendId);
  }

  private meetingSchedulerOptions(backendId: string): WorkerSchedulerOpts {
    const browserTabManager = this.browserTabManager;
    const screenshotBridge = {
      injectScreenshot: (workerId: string, data: Parameters<WorkerScheduler['injectScreenshotToWorker']>[1]) => {
        this.meetingScheduler.injectScreenshotToWorker(workerId, data);
      },
    };
    return {
      emit: (event) => this.safeEmit(event),
      cwd: this.cwd,
      autoApproveScope: this.autoApproveScope,
      workerEnv: this.workerEnv,
      confirmDestructive: this.confirmDestructive,
      sessionFactory: this.sessionFactory,
      resolveSessionFactory: (id) => this.buildSessionFactory(
        id ?? this.defaultWorkerBackendId(),
        DEFAULT_HOST_ID,
        'worker',
      ),
      defaultBackendId: resolveDefaultWorkerBackendId(backendId),
      buildWorkerMcp: (id, attempt) => buildWorkerMcp(this, id, this.cwd, attempt),
      buildComputerUseMcp: process.platform === 'darwin'
        ? (id) => buildComputerUseMcp(screenshotBridge, id)
        : undefined,
      buildBrowserMcp: browserTabManager
        ? (id) => buildBrowserMcp(browserTabManager, screenshotBridge, id)
        : undefined,
      getTalker: () => {
        const host = this.coordinatorTalkerHost();
        return host.isReady() ? host.getHost() : null;
      },
      publishWorkerQuestion: (message) => this.publishWorkerQuestion(message),
      publishCoordinatorBriefing: (briefing, attempt) => this.publishCoordinatorBriefing(briefing, attempt),
      getSpeechFilterMode: () => (getSettings().speechFilterMode === 'off' ? 'off' : 'strict'),
      isClosed: () => this.closed,
      contextCompilerRequired: true,
      workspaceManager: (
        this.sessionFactory === Orchestrator.defaultClaudeFactory
        || this.customWorkspaceManager
      )
        ? this.workspaceManager
        : undefined,
      meetingId: this.meetingId,
      deliveryHarness: this.deliveryHarness,
      deliveryArtifactRoot: this.repository.deliveryArtifactRoot(),
      flushEvents: () => this.repository.flush(),
      getIntegrationHead: () => this.integrationQueue.currentHead(),
      initialPlanVersion: this.recoveredPlanVersion,
      getAuthorizedTaskContextSource: (taskId, selection) =>
        this.getAuthorizedTaskContextSource(taskId, selection),
      persistContextPackage: (contextPackage) =>
        this.persistContextPackage(contextPackage),
      compileTaskProfile: this.sessionFactory === Orchestrator.defaultClaudeFactory
        ? (requestedProfile) => this.compileTaskProfile(requestedProfile)
        : undefined,
      persistTaskProfile: this.sessionFactory === Orchestrator.defaultClaudeFactory
        ? (input) => this.persistTaskProfile(input)
        : undefined,
      taskProfileCompilerRequired: this.sessionFactory === Orchestrator.defaultClaudeFactory,
      compileTaskAuthority: this.sessionFactory === Orchestrator.defaultClaudeFactory
        ? (input) => compileTaskAuthority(
            input.taskId,
            input.attempt,
            input.planVersion,
            input.approvalDecisionId,
            input.workspaceRoot,
            input.authorityRequest,
            input.approvedAt,
          )
        : undefined,
      persistTaskAuthority: this.sessionFactory === Orchestrator.defaultClaudeFactory
        ? (input) => this.persistTaskAuthority(input)
        : undefined,
      normalizePermissionRequest: this.sessionFactory === Orchestrator.defaultClaudeFactory
        ? (backendId, native) => {
            const backend = getBackendRegistry().get(backendId);
            return backend?.normalizePermissionRequest?.(native) ?? {
              ok: false as const,
              diagnostic: 'unsupported-native-tool' as const,
              requiresUser: true as const,
            };
          }
        : undefined,
      persistPermissionDecision: this.sessionFactory === Orchestrator.defaultClaudeFactory
        ? (input) => this.persistPermissionDecision(input)
        : undefined,
      taskAuthorityCompilerRequired: this.sessionFactory === Orchestrator.defaultClaudeFactory,
      taskMailbox: this.taskMailbox,
      recordCustomEvent: async (kind, payload) => {
        await this.repository.append(kind, payload);
        await this.repository.flush();
      },
    };
  }

  private createHostGroup(id: string, backendId: string): HostGroup {
    const hg = new HostGroup({
      id,
      backendId,
      emit: (e) => this.onHostGroupEvent(id, e),
      cwd: this.cwd,
      projectId: this.projectId,
      autoApproveScope: this.autoApproveScope,
      workerEnv: this.workerEnv,
      talkerModel: this.talkerModel,
      confirmDestructive: this.confirmDestructive,
      sessionFactory: this.buildSessionFactory(backendId, id),
      bridge: this,
      isClosed: () => this.closed,
      isCoordinator: () => this.coordinatorHostId === id,
      coordinatorPrompt: () => (this.recoveringCoordinatorHostId ?? this.coordinatorHostId) === id,
    });
    this.hostGroups.set(id, hg);

    // Subscribe to cross-host messages targeting this group. Queue while the
    // talker handshake is still in flight so early broadcasts are not dropped.
    this.crossHostBus.subscribe(id, (msg) => {
      this.deliverCrossHostMessage(id, msg.from, msg.text);
    });

    return hg;
  }

  private deliverCrossHostMessage(hostId: string, from: string, text: string): void {
    const hg = this.hostGroups.get(hostId);
    const host = hg?.isReady() ? hg.getHost() : null;
    if (host) {
      host.sendUserText(`[cross-host from ${from}] ${text}`, 'normal');
      return;
    }
    const queue = this.pendingCrossHostMessages.get(hostId) ?? [];
    queue.push({ from, text });
    // Bound memory if a host never becomes ready.
    if (queue.length > 100) queue.splice(0, queue.length - 100);
    this.pendingCrossHostMessages.set(hostId, queue);
  }

  private flushPendingCrossHostMessages(hostId: string): void {
    this.hostInbox.wake(hostId);
    const pending = this.pendingCrossHostMessages.get(hostId);
    if (!pending || pending.length === 0) return;
    this.pendingCrossHostMessages.delete(hostId);
    const host = this.hostGroups.get(hostId)?.getHost();
    if (!host) return;
    for (const msg of pending) {
      host.sendUserText(`[cross-host from ${msg.from}] ${msg.text}`, 'normal');
    }
  }

  /** Add a new host group to this meeting. Returns the host group id.
   *  The host's talker session is started asynchronously — the renderer shows
   *  a "Connecting…" placeholder until the session-ready event arrives. */
  addHost(backendId: string, hostId?: string, remoteTarget?: PocketVibeRemoteTarget, profile?: HostProfile): { ok: true; hostId: string } | { ok: false; error: string } {
    if (this.unsupportedRecovery) return { ok: false, error: 'Meeting journal version requires a newer runtime' };
    if (this.closed) return { ok: false, error: 'orchestrator is closed' };
    const target = remoteTarget === undefined ? undefined : parsePocketVibeRemoteTarget(remoteTarget);
    if (remoteTarget !== undefined && (backendId !== 'pocket-vibe' || !target)) {
      return { ok: false, error: 'remoteTarget 仅支持 Pocket Vibe，且必须包含有效的 Agent、provider、原生会话 ID 和远端目录。' };
    }
    if (target && [...this.remoteTargets.values()].some((existing) => remoteSessionKey(existing) === remoteSessionKey(target))) {
      return { ok: false, error: '该远端会话已加入当前会议。' };
    }
    if (this.hostGroups.size >= MAX_HOSTS) {
      return { ok: false, error: `host capacity reached (${MAX_HOSTS}/${MAX_HOSTS})` };
    }
    if (hostId && !/^[a-zA-Z0-9._-]{1,64}$/.test(hostId)) {
      return { ok: false, error: 'hostId must be alphanumeric with dots/hyphens/underscores, max 64 chars' };
    }
    const backend = getBackendRegistry().get(backendId);
    if (!backend) return { ok: false, error: `backend '${backendId}' not found` };
    if (!backend.resolveBinary()) return { ok: false, error: `backend '${backendId}' runtime is not available` };
    this.diagnostics.log('host-add-requested', {
      hostId: hostId ?? null,
      backendId,
      runtimePath: backend.resolveBinary(),
      cwd: this.cwd,
      homeSource: 'real-home',
    });
    const id = hostId ?? (target ? `pocket-vibe-${randomUUID()}` : `${backendId}-host-${this.hostGroups.size}`);
    if (this.hostGroups.has(id)) {
      return { ok: false, error: `host group '${id}' already exists` };
    }
    if (target) this.remoteTargets.set(id, target);
    if (profile) this.hostProfiles.set(id, profile);
    const hg = this.createHostGroup(id, backendId);
    if (target) void this.snapshotActiveMeeting().catch((err) => console.error('[remote-session] snapshot failed:', err));

    // Announce the group before the handshake so the renderer can show a
    // "Connecting…" tile. Live invites already add one optimistically, but
    // recovery re-adds (start()) have no renderer-side seed — this event is
    // the only signal that rebuilds the participant tile there.
    this.safeEmit({
      source: 'system',
      hostId: id,
      event: { kind: 'host-added', backendId, ...(profile ? { profile } : {}) },
    });

    // Fire-and-forget the talker transport handshake. Starting a Host must not
    // spend a model turn: delayed startup greetings used to surface minutes
    // later as unrelated "welcome back" messages in the live transcript.
    void (async () => {
      try {
        await hg.start();
        if (this.closed || this.hostGroups.get(id) !== hg) return;
        this.restoreCoordinatorIfReady(id);
        this.flushPendingCrossHostMessages(id);
        await this.snapshotActiveMeeting();
        if (!this.closed && this.hostGroups.get(id) === hg && hg.isReady()) {
          this.safeEmit({
            source: 'system',
            hostId: id,
            event: { kind: 'session-ready', ...(target ? { remoteTarget: target } : {}) },
          });
        }
      } catch (err: unknown) {
        if (this.closed || this.hostGroups.get(id) !== hg) return;
        this.diagnostics.log('host-start-failed', {
          hostId: id,
          backendId,
          error: err instanceof Error ? { name: err.name, message: err.message, cause: err.cause } : String(err),
        });
        console.error(`[orchestrator] failed to start host '${id}':`, err);
        this.safeEmit({
          source: 'system',
          hostId: id,
          event: {
            kind: 'session-start-failed',
            ...(target ? { remoteTarget: target } : {}),
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    })();

    return { ok: true, hostId: id };
  }

  /** A refreshed directory can complete legacy references before join deduplication. */
  enrichRemoteTargets(directory: PocketVibeRemoteDirectory): void {
    for (const target of this.remoteTargets.values()) {
      if (target.device_id) continue;
      try { Object.assign(target, resolveRemoteTarget(target, directory)); }
      catch { /* Offline/invalid references retain their identity and fail at start/send. */ }
    }
  }

  /** Remove a host group. Cannot remove the default host. */
  removeHost(hostId: string): { ok: true } | { ok: false; error: string } {
    if (hostId === DEFAULT_HOST_ID) {
      return { ok: false, error: 'cannot remove the default host group' };
    }
    if (hostId === this.coordinatorHostId) {
      return { ok: false, error: 'cannot remove the active coordinator; transfer coordination first' };
    }
    const hg = this.hostGroups.get(hostId);
    if (!hg) {
      return { ok: false, error: `host group '${hostId}' not found` };
    }
    void hg.end().catch((err) => console.error('[orchestrator] host removal cleanup failed:', err));
    this.hostGroups.delete(hostId);
    const wasRemote = this.remoteTargets.delete(hostId);
    this.crossHostBus.unsubscribeHost(hostId);
    this.pendingCrossHostMessages.delete(hostId);
    if (wasRemote) void this.snapshotActiveMeeting().catch((err) => console.error('[remote-session] snapshot failed:', err));
    return { ok: true };
  }

  /** Re-emit the plan state a freshly attached renderer cannot rebuild from
   *  hosts and transcript alone (a second window, or a reload). */
  republishState(): void {
    if (this.meetingScheduler) this.meetingScheduler.republishPlan();
    else if (this.recoveredTasks.length > 0) this.emitRecoveredPlan();
    this.hostRuntime.publishPlanState();
    void this.publishRecoveredHostInputs();
  }

  private async publishRecoveredHostInputs(): Promise<void> {
    try {
      const recent = await this.hostInbox.recent();
      if (this.closed) return;
      for (const input of recent) {
        this.emit({ source: 'system', hostId: input.hostId, event: { kind: 'host-input-state', ...input } });
      }
    } catch (error) {
      this.diagnostics.log('host-input-recovery-failed', { error: String(error) });
    }
  }

  /** List all host groups with their ids and backend ids. */
  listHosts(): Array<{
    id: string;
    backendId: string;
    role: 'coordinator' | 'expert';
    profile?: HostProfile;
    backendSession?: BackendSessionSnapshot;
    remoteTarget?: PocketVibeRemoteTarget;
    ready: boolean;
    phase: 'starting' | 'ready' | 'ended' | 'failed';
    error?: string;
  }> {
    return Array.from(this.hostGroups.entries()).map(([id, hg]) => ({
      id,
      backendId: hg.backendId,
      role: id === this.coordinatorHostId ? 'coordinator' : 'expert',
      backendSession: hg.getHost()?.snapshot?.() ?? undefined,
      ready: hg.isReady(),
      ...hg.getLifecycle(),
      ...(this.hostProfiles.has(id) ? { profile: this.hostProfiles.get(id)! } : {}),
      ...(this.remoteTargets.has(id) ? { remoteTarget: { ...this.remoteTargets.get(id)! } } : {}),
    }));
  }

  /**
   * Transfer coordination while the meeting keeps its Worker pool and workspaces.
   */
  async setCoordinator(hostId: string): Promise<{
    ok: true;
    coordinatorHostId: string;
    executionHostId: typeof DEFAULT_HOST_ID;
    handoff: 'talker-role-only';
  } | { ok: false; error: string }> {
    return this.hostRuntime.mutatePlan(() => this.applyCoordinatorChange(hostId));
  }

  private async applyCoordinatorChange(hostId: string): Promise<{
    ok: true;
    coordinatorHostId: string;
    executionHostId: typeof DEFAULT_HOST_ID;
    handoff: 'talker-role-only';
  } | { ok: false; error: string }> {
    if (this.closed) return { ok: false, error: 'Meeting is closed' };
    const hg = this.hostGroups.get(hostId);
    if (!hg) return { ok: false, error: `host group '${hostId}' not found` };
    if (!hg.isReady()) return { ok: false, error: `host group '${hostId}' is not ready` };
    const backend = getBackendRegistry().get(hg.backendId);
    if (!backend) return { ok: false, error: `backend '${hg.backendId}' not found` };
    if (!backend.capabilities.coordinate) {
      return { ok: false, error: `backend '${hg.backendId}' cannot coordinate yet` };
    }
    const previous = this.coordinatorHostId;
    const session = hg.getHost();
    await this.repository.append('coordinator-changed', {
      schemaVersion: 1, previous, current: hostId, executionHostId: DEFAULT_HOST_ID, handoff: 'talker-role-only',
    });
    if (this.closed || this.hostGroups.get(hostId) !== hg || hg.getHost() !== session || !hg.isReady()) {
      await this.repository.append('coordinator-changed', {
        schemaVersion: 1, previous: hostId, current: previous, executionHostId: DEFAULT_HOST_ID, handoff: 'cancelled',
      });
      return { ok: false, error: 'Host session changed during coordination transfer' };
    }
    this.recoveringCoordinatorHostId = undefined;
    this.coordinatorHostId = hostId;
    if (previous === hostId) {
      return { ok: true, coordinatorHostId: hostId, executionHostId: DEFAULT_HOST_ID, handoff: 'talker-role-only' };
    }
    hg.getHost()?.sendUserText(
      `[coordinator handoff] You are now the meeting talker/coordinator. Previous: ${previous}. `
      + 'The meeting keeps its running Workers. '
      + `Current worker state:\n${this.describeWorkers()}`,
      'high',
    );
    this.hostGroups.get(previous)?.getHost()?.sendUserText(
      `[coordinator handoff] You are now an Expert Talker. ${hostId} is the sole Coordinator talker. `
      + 'Do not schedule or speak for the meeting; answer only direct mentions or coordinator requests.',
      'high',
    );
    this.resumeDisconnectedReviews();
    void this.meetingScheduler.redeliverPendingWorkerQuestions();
    return {
      ok: true,
      coordinatorHostId: hostId,
      executionHostId: DEFAULT_HOST_ID,
      handoff: 'talker-role-only',
    };
  }

  getCoordinatorHostId(): string {
    return this.coordinatorHostId;
  }

  private restoreCoordinatorIfReady(hostId: string) {
    if (this.closed || this.recoveringCoordinatorHostId !== hostId) return;
    const host = this.hostGroups.get(hostId);
    if (!host?.isReady() || !getBackendRegistry().get(host.backendId)?.capabilities.coordinate) return;
    this.coordinatorHostId = hostId;
    this.recoveringCoordinatorHostId = undefined;
    this.safeEmit({ source: 'system', hostId, event: { kind: 'coordinator-restored', hostId } });
  }

  sendHostMessage(fromHostId: string, toHostId: string, text: string): { ok: boolean; error?: string; truncated?: boolean } {
    if (!this.hostGroups.has(fromHostId)) return { ok: false, error: `source host '${fromHostId}' not found` };
    if (!this.hostGroups.has(toHostId)) return { ok: false, error: `target host '${toHostId}' not found` };
    if (text.length === 0) return { ok: false, error: 'message length is invalid' };
    // Truncate to fit the bus cap instead of rejecting. The auto-forwarded
    // expert response path builds `[expert response from X] <text.slice>` and
    // ignores the return value, so an over-length reply used to be silently
    // dropped and the Coordinator never saw it. A marker keeps the cut visible.
    const HOST_MESSAGE_MAX = 20_000;
    const TRUNCATE_MARKER = '…[truncated]';
    let payload = text;
    let truncated = false;
    if (text.length > HOST_MESSAGE_MAX) {
      payload = text.slice(0, HOST_MESSAGE_MAX - TRUNCATE_MARKER.length) + TRUNCATE_MARKER;
      truncated = true;
    }
    this.crossHostBus.publish({ from: fromHostId, to: toHostId, text: payload });
    void this.repository.append('host-message', {
      fromHostId,
      toHostId,
      chars: payload.length,
      truncated,
    });
    return { ok: true, truncated };
  }

  async askExpert(fromHostId: string, targetHostId: string, question: string, isCurrent = () => !this.closed): Promise<string> {
    if (this.closed || !isCurrent() || fromHostId !== this.coordinatorHostId || fromHostId === targetHostId
      || !this.hostGroups.has(targetHostId)) throw new Error('Expert target or Coordinator is unavailable');
    const ask: ExpertAsk = {
      requestId: randomUUID(), fromHostId, targetHostId, question: question.trim(),
      expiresAt: this.hostAskTimeoutMs > 0 ? Date.now() + this.hostAskTimeoutMs : 0,
    };
    if (!ask.question || ask.question.length > 100_000) throw new Error('Invalid expert question');
    await this.repository.append('host-expert-requested', { schemaVersion: 1, ...ask });
    if (this.closed) return ask.requestId;
    this.pendingHostAsks.set(ask.requestId, ask);
    this.trackHostAsk(ask);
    if (!isCurrent() || fromHostId !== this.coordinatorHostId) return ask.requestId;
    await this.deliverExpertAsk(ask);
    return ask.requestId;
  }

  async replyExpertAsk(hostId: string, requestId: string, text: string, isCurrent = () => !this.closed): Promise<void> {
    const ask = this.pendingHostAsks.get(requestId);
    if (!ask || ask.targetHostId !== hostId || ask.answering || !isCurrent() || this.closed) {
      throw new Error('Expert reply has no matching open request');
    }
    const answer = text.trim();
    if (!answer || answer.length > 100_000) throw new Error('Invalid expert reply');
    ask.answering = true;
    try {
      const targetHostId = this.coordinatorHostId;
      await this.repository.append('host-expert-replied', { schemaVersion: 1, requestId, hostId, targetHostId, text: answer });
      clearTimeout(ask.timer);
      this.pendingHostAsks.delete(requestId);
      if (!this.closed) {
        await this.deliverExpertReply(requestId, targetHostId, answer);
      }
    } finally {
      ask.answering = false;
    }
  }

  private async deliverExpertAsk(ask: ExpertAsk): Promise<void> {
    const text = `[expert request ${ask.requestId}]\n`
      + `答复时使用 reply_to_coordinator 并传入 requestId，或在正文开头写 [expert reply ${ask.requestId}]。\n${ask.question}`;
    await this.hostInbox.receive(`expert-request-${ask.requestId}`, text.slice(0, 100_000),
      () => ({ hostId: ask.targetHostId, direct: false }), undefined, 'expert-request');
  }

  private async deliverExpertReply(requestId: string, targetHostId: string, answer: string): Promise<void> {
    const text = `[expert reply ${requestId}] ${answer}`;
    await this.hostInbox.receive(`expert-reply-${requestId}`, text.slice(0, 100_000),
      () => ({ hostId: targetHostId, direct: false }), undefined, 'expert-reply');
  }

  private trackHostAsk(ask: ExpertAsk): void {
    if (!ask.expiresAt || ask.timedOut) return;
    ask.timer = setTimeout(() => {
      if (this.closed || ask.answering || !this.pendingHostAsks.has(ask.requestId)) return;
      ask.timedOut = true;
      void this.repository.append('host-expert-timed-out', { schemaVersion: 1, requestId: ask.requestId }).then(() => {
        if (!this.closed) this.notifyHostAskStalled(ask.targetHostId, `[${ask.requestId}] ${ask.question.slice(0, 400)}`);
      }).catch((error) => this.diagnostics.log('expert-timeout-write-failed', { error: String(error) }));
    }, Math.max(0, ask.expiresAt - Date.now()));
    ask.timer.unref?.();
  }

  private restoreExpertAsks(journal: PersistedMeetingEvent[]) {
    for (const event of journal) {
      const ask = event.payload as ExpertAsk | null;
      if (!ask || typeof ask.requestId !== 'string') continue;
      if (event.type === 'host-expert-requested' && typeof ask.targetHostId === 'string'
        && typeof ask.question === 'string' && Number.isFinite(ask.expiresAt)) {
        this.pendingHostAsks.set(ask.requestId, { ...ask });
      } else if (event.type === 'host-expert-replied') {
        this.pendingHostAsks.delete(ask.requestId);
        const reply = objectRecord(event.payload);
        if (typeof reply.targetHostId === 'string' && typeof reply.text === 'string') {
          void this.deliverExpertReply(ask.requestId, reply.targetHostId, reply.text).catch((error) => {
            this.diagnostics.log('expert-reply-recovery-failed', { requestId: ask.requestId, error: String(error) });
          });
        }
      } else if (event.type === 'host-expert-timed-out') {
        const existing = this.pendingHostAsks.get(ask.requestId);
        if (existing) existing.timedOut = true;
      }
    }
    for (const ask of this.pendingHostAsks.values()) {
      this.trackHostAsk(ask);
      if (!ask.timedOut) void this.deliverExpertAsk(ask).catch((error) => {
        this.diagnostics.log('expert-request-recovery-failed', { requestId: ask.requestId, error: String(error) });
      });
    }
  }

  private clearAllHostAsks(): void {
    for (const entry of this.pendingHostAsks.values()) {
      clearTimeout(entry.timer);
    }
    this.pendingHostAsks.clear();
  }

  private notifyHostAskStalled(targetHostId: string, question: string): void {
    this.meetingScheduler.briefCoordinator({
      kind: 'stalled',
      title: `Expert ${targetHostId} 长时间未回复`,
      summary: `你向 ${targetHostId} 提出的问题已超过 ${Math.round(this.hostAskTimeoutMs / 1000)} 秒未收到回复：${question}\n可以继续等待，或自行推进 / 换一个专家 / 让用户决定；不要无限期阻塞。`,
      blockers: ['host-ask-timeout'],
      recommendedAction: 'request-user-decision',
    });
  }

  async executeMeetingCommand(hostId: string, raw: unknown, isCurrent = () => !this.closed): Promise<MeetingCommandResult> {
    const actor = this.hostGroups.get(hostId);
    if (!actor) return { ok: false, code: 'forbidden', error: `host '${hostId}' not found` };
    const expired = { ok: false, code: 'forbidden', error: 'Host session was replaced' } as const;
    if (!isCurrent()) return expired;
    const { commandId, ...commandInput } = objectRecord(raw);
    if (commandId !== undefined && (typeof commandId !== 'string' || !/^[\w.-]{1,128}$/.test(commandId))) {
      return { ok: false, code: 'invalid-command', error: 'Invalid commandId' };
    }
    const authorized = authorizeMeetingCommand(commandInput, {
      hostId,
      role: hostId === this.coordinatorHostId ? 'coordinator' : 'expert',
      ownsTask: (taskId) => this.isTaskOwnedBy(taskId, hostId),
    }, {
      defaultBackendId: this.defaultWorkerBackendId(),
      ...this.normalizePlanOptions(),
    });
    if (!authorized.ok) return authorized;
    const command = authorized.command;
    if(this.sharedExecution && command.kind!=='propose-plan') {
      try {
        if(command.kind==='ask-host')return {ok:true,value:await this.sharedExecution.consult(command.hostId,command.question)};
        if(command.kind==='send-task-message'||command.kind==='follow-up-task'||command.kind==='steer-task')return {ok:true,value:await this.sharedExecution.control(command.taskId,'supplement',command.message)};
        if(command.kind==='interrupt-task')return {ok:true,value:await this.sharedExecution.control(command.taskId,'stop')};
        return {ok:false,code:'forbidden',error:'Shared tasks require a visible revised plan or an exact task action; local scheduling is disabled.'};
      }catch(error){return {ok:false,code:'execution-failed',error:String(error)};}
    }
    try {
      switch (command.kind) {
        case 'propose-plan': {
          const result = await this.proposePlan(command.tasks, {
            goal: command.goal,
            approach: command.approach,
            steps: command.steps,
            risks: command.risks,
            openQuestions: command.openQuestions,
          }, () => isCurrent() && hostId === this.coordinatorHostId);
          return result.ok
            ? { ok: true, value: { tasks: command.tasks.length, status: 'installed' } }
            : { ok: false, code: 'execution-failed', error: result.error };
        }
        case 'revise-plan': {
          const operations = command.operations.map((operation) =>
            !this.sharedExecution && operation.kind === 'update-task' && operation.executionProfile
              ? { ...operation, executionProfile: { ...operation.executionProfile,
                backendId: nativeWorkerBackendId(operation.executionProfile.backendId) } }
              : operation);
          const addedTasks = operations.flatMap((operation) =>
            operation.kind === 'add-task' ? [operation.task] : [],
          );
          const backendError = await this.validateExecutionBackends(addedTasks);
          if (!isCurrent() || hostId !== this.coordinatorHostId) return expired;
          if (backendError) {
            return { ok: false, code: 'execution-failed', error: backendError };
          }
          const result = await this.hostRuntime.mutatePlan(async () => {
            if (!isCurrent() || hostId !== this.coordinatorHostId) return { ok: false as const, error: expired.error };
            return this.meetingScheduler.revisePlan(
              command.expectedPlanVersion, operations, () => isCurrent() && hostId === this.coordinatorHostId,
            );
          });
          if (result.ok) {
            await this.repository.append('plan-revised-by-coordinator', {
              reason: command.reason,
              expectedPlanVersion: command.expectedPlanVersion,
              planVersion: result.planVersion,
              operations,
            });
            await this.repository.flush();
            await this.snapshotActiveMeeting();
          }
          return result.ok
            ? { ok: true, value: { planVersion: result.planVersion } }
            : { ok: false, code: 'execution-failed', error: result.error };
        }
        case 'ask-host': {
          return { ok: true, value: { requestId: await this.askExpert(hostId, command.hostId, command.question, isCurrent) } };
        }
        case 'reply-host-ask': {
          await this.replyExpertAsk(hostId, command.requestId, command.text, isCurrent);
          return { ok: true };
        }
        case 'inspect-tasks': {
          if (hostId !== this.coordinatorHostId && (!command.taskId || !this.isTaskOwnedBy(command.taskId, hostId))) return expired;
          return { ok: true, value: this.describeWorkers(command.taskId) };
        }
        case 'read-meeting-context': {
          return { ok: true, value: this.readMeetingContext(hostId, command) };
        }
        case 'broadcast-hosts': {
          for (const target of this.hostGroups.keys()) {
            if (target !== hostId) this.sendHostMessage(hostId, target, command.question);
          }
          return { ok: true };
        }
        case 'steer-worker': {
          const result = await this.steerWorker(command.workerId, command.addendum);
          return result.ok ? { ok: true, value: result } : { ok: false, code: 'execution-failed', error: result.reason };
        }
        case 'send-task-message': {
          const valid = () => isCurrent() && (hostId === this.coordinatorHostId || this.isTaskOwnedBy(command.taskId, hostId));
          const message = await this.meetingScheduler.sendTaskMessage(command.taskId, command.message, undefined, valid);
          return { ok: true, value: { messageId: message.id, status: message.status } };
        }
        case 'follow-up-task': {
          const valid = () => isCurrent() && (hostId === this.coordinatorHostId || this.isTaskOwnedBy(command.taskId, hostId));
          const message = await this.meetingScheduler.queueFollowUp(command.taskId, command.message, undefined, undefined, valid);
          return { ok: true, value: { messageId: message.id, status: message.status } };
        }
        case 'steer-task': {
          const result = await this.meetingScheduler.steerTask(command.taskId, command.message,
            () => isCurrent() && (hostId === this.coordinatorHostId || this.isTaskOwnedBy(command.taskId, hostId)));
          return result.ok
            ? { ok: true, value: result }
            : { ok: false, code: 'execution-failed', error: result.reason };
        }
        case 'interrupt-task': {
          const result = await this.meetingScheduler.interruptTask(command.taskId, command.reason);
          return result.ok
            ? { ok: true, value: { messageId: result.message.id } }
            : { ok: false, code: 'execution-failed', error: result.error };
        }
        case 'forward-task-message': {
          const message = await this.meetingScheduler.forwardTaskMessage(
            command.fromTaskId,
            command.toTaskId,
            command.messageId,
          );
          return { ok: true, value: { messageId: message.id, status: message.status } };
        }
        case 'request-decision': {
          const result = await this.createDecision({
            question: command.question,
            context: command.context,
            options: command.options,
            deadline: command.deadlineMs,
          });
          return { ok: true, value: result };
        }
        case 'save-memory': {
          const result = await this.saveMemory({
            category: command.category,
            content: command.content,
            tags: command.tags,
          });
          return result.ok
            ? { ok: true, value: result }
            : { ok: false, code: 'execution-failed', error: result.error ?? 'memory save failed' };
        }
        case 'speak':
          this.narrateAssistantLine(command.text);
          return { ok: true };
      }
      return { ok: false, code: 'invalid-command', error: 'unsupported command' };
    } catch (err) {
      return { ok: false, code: 'execution-failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Get the default host group (always present). */
  /** HostGroup that currently owns the Coordinator talker (may differ from execution). */
  private coordinatorTalkerHost(): HostGroup {
    const hg = this.hostGroups.get(this.coordinatorHostId);
    if (!hg) throw new Error('coordinator host group missing — this is a bug');
    return hg;
  }

  /**
   * Historical name: returns the current Coordinator talker host, not necessarily
   * the initial Host. Prefer coordinatorTalkerHost().
   */
  private defaultHost(): HostGroup {
    return this.coordinatorTalkerHost();
  }

  /** Handle events from a HostGroup, tagging with hostId before re-emitting. */
  private onHostGroupEvent(hostId: string, e: OrchestratorEvent) {
    this.safeEmit({ ...e, hostId });
    if (
      hostId !== this.coordinatorHostId
      && e.source === 'talker'
      && e.event.kind === 'message'
      && e.event.message.type === 'assistant'
    ) {
      const text = extractText(e.event.message);
      const reply = /^\[expert reply ([0-9a-f-]{36})\]\s*([\s\S]+)$/iu.exec(text ?? '');
      if (reply) {
        void this.replyExpertAsk(hostId, reply[1], reply[2]).catch((error) => {
          this.diagnostics.log('unassociated-expert-reply', { hostId, requestId: reply[1], error: String(error) });
        });
      }
    }
    if (
      hostId === this.coordinatorHostId
      && e.source === 'talker'
      && e.event.kind === 'ended'
      && !this.closed
    ) {
      const candidate = Array.from(this.hostGroups.entries()).find(([id, hg]) =>
        id !== hostId
        && hg.isReady()
        && getBackendRegistry().get(hg.backendId)?.capabilities.coordinate === true,
      )?.[0] ?? null;
      this.safeEmit({
        source: 'system',
        event: { kind: 'coordinator-failed', hostId, candidateHostId: candidate },
      });
      void this.repository.append('coordinator-failed', { hostId, candidateHostId: candidate });
    }
  }

  async restartHost(hostId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.unsupportedRecovery) return { ok: false, error: 'Meeting journal version requires a newer runtime' };
    const hg = this.hostGroups.get(hostId);
    if (!hg) return { ok: false, error: `host '${hostId}' not found` };
    if (hg.isReady()) return { ok: false, error: `host '${hostId}' is already running` };
    try {
      await hg.start();
      if (this.closed || this.hostGroups.get(hostId) !== hg || !hg.isReady()) {
        return { ok: false, error: 'Host startup was cancelled' };
      }
      this.restoreCoordinatorIfReady(hostId);
      this.flushPendingCrossHostMessages(hostId);
      this.safeEmit({ source: 'system', hostId, event: { kind: 'session-ready' } });
      if (hostId === this.coordinatorHostId) {
        this.resumeDisconnectedReviews();
        await this.meetingScheduler.redeliverPendingWorkerQuestions();
      }
      return { ok: true };
    } catch (err) {
      this.diagnostics.log('host-restart-failed', {
        hostId,
        backendId: hg.backendId,
        error: err instanceof Error ? { name: err.name, message: err.message, cause: err.cause } : String(err),
      });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // Public API (delegates to default host for backward compatibility)

  setAutoApproveScope(scope: AutoApproveScope) {
    this.autoApproveScope = scope;
    this.meetingScheduler.setAutoApproveScope(scope);
    for (const hg of this.hostGroups.values()) {
      hg.setAutoApproveScope(scope);
    }
  }

  private safeEmit(e: OrchestratorEvent) {
    if (this.closed || this.repository.isWriteFaulted()) return;
    // Ensure hostId is always present; default to 'default' when absent.
    if (!e.hostId) e = { ...e, hostId: DEFAULT_HOST_ID };
    const append = this.repository.append(`event:${e.event.kind}`, e);
    const shouldSnapshot = (
      e.event.kind === 'plan-updated'
      || e.event.kind === 'worker-spawned'
      || e.event.kind === 'worker-ended'
      || e.event.kind === 'coordinator-failed'
      || e.event.kind === 'worker-event'
      || e.event.kind === 'delivery-status'
      || e.event.kind === 'worker-delivery'
      || e.event.kind === 'meeting-delivery-updated'
    );
    // Every renderer-visible orchestration event is emitted only after its
    // journal line is durable. If one write fails, MeetingRepository faults
    // permanently and later live notifications are suppressed.
    void append.then(() => {
      if (this.closed || this.repository.isWriteFaulted()) return;
      this.emit(e);
      if (shouldSnapshot) {
        void this.snapshotActiveMeeting().catch((error) => {
          console.error('[orchestrator] rebuildable Meeting snapshot write failed', {
            kind: e.event.kind,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      if (
        e.event.kind === 'delivery-status'
        && e.event.delivery.status === 'accepted'
      ) {
        void this.prepareFinalMeetingDelivery().catch((error) => {
          console.error('[orchestrator] final Meeting delivery preparation failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }).catch((error) => {
      console.error('[orchestrator] event journal write failed; Meeting is fail-stopped', {
        kind: e.event.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async start(greeting?: string) {
    await this.repositoryReady;
    this.repository.assertWritable();
    const journal = await MeetingRepository.replay(this.meetingId, undefined, (message) => {
      this.diagnostics.log('meeting-replay-diagnostic', { message });
    });
    this.unsupportedRecovery = journal.some((event) => {
      if (event.type !== 'meeting-created' && event.type !== 'meeting-recovered') return false;
      const meta = objectRecord(event.payload);
      return Object.entries({ runtimeVersion: 1, eventSchemaVersion: 1, transportProtocolVersion: 2 })
        .some(([key, max]) => meta[key] !== undefined && (
          typeof meta[key] !== 'number' || !Number.isSafeInteger(meta[key]) || Number(meta[key]) < 1 || Number(meta[key]) > max
        ));
    });
    if (this.unsupportedRecovery) throw new Error('会议日志版本需要更新的运行时。执行恢复已阻止。');
    const latestCoordinator = [...journal].reverse().find((event) => event.type === 'coordinator-changed');
    const recoveredCoordinator = objectRecord(latestCoordinator?.payload).current;
    if (typeof recoveredCoordinator === 'string') this.recoveringCoordinatorHostId = recoveredCoordinator;
    if (this.recoveringCoordinatorHostId === DEFAULT_HOST_ID) this.recoveringCoordinatorHostId = undefined;
    this.integrationQueue.restore(journal);
    const interruptedIntegration = await this.integrationQueue.detectInterruptedOperation();
    if (interruptedIntegration) {
      const integrationTaskId = this.integrationQueue.snapshot().activeTaskId;
      const recovered = this.recoveredTasks.find((task) => task.id === integrationTaskId);
      if (recovered) {
        recovered.status = 'integration-conflict';
        recovered.recovery = assessTaskRecovery(recovered);
        this.meetingScheduler.markRecoveredIntegrationConflict(String(integrationTaskId));
      }
    }
    this.restoreFinalMeetingDelivery(journal);
    await this.reconcileInterruptedFinalAcceptance(journal);
    this.taskMailbox.restore(journal);
    this.hostRuntime.restore(journal, this.recoveredTasks);
    const unresolvedLaunches = unresolvedNativeLaunches(journal);
    for (const task of this.recoveredTasks) {
      if (typeof task.id !== 'string' || !unresolvedLaunches.get(task.id)?.size) continue;
      task.launchPhase = 'uncertain';
      task.recovery = assessTaskRecovery(task);
      this.meetingScheduler.markRecoveredNativeExitUncertain(task.id);
    }
    if (!this.closed) this.restoreExpertAsks(journal);
    this.taskProjection = projectMeetingTasks(journal);
    await this.publishRecoveredHostInputs();
    await this.defaultHost().start(greeting);
    if (this.hostRuntime.hasRetainedState) this.republishState();
    // Restoring references reconnects transports only; it sends no model turn.
    for (const [id] of this.remoteTargets) {
      try {
        await this.hostGroups.get(id)!.start();
        this.restoreCoordinatorIfReady(id);
        this.flushPendingCrossHostMessages(id);
        this.safeEmit({ source: 'system', hostId: id, event: { kind: 'session-ready', remoteTarget: this.remoteTargets.get(id) } });
      } catch (err) {
        this.safeEmit({ source: 'system', hostId: id, event: { kind: 'session-start-failed', error: String(err), remoteTarget: this.remoteTargets.get(id) } });
      }
    }
    this.flushPendingCrossHostMessages(DEFAULT_HOST_ID);
    // Re-add the host groups that were invited before the previous shutdown.
    // The default host is already up; the rest reconnect asynchronously and
    // each announces itself via host-added/session-ready exactly like a live
    // invite. A backend that disappeared in the meantime is skipped — the
    // meeting must still recover when one invited runtime is gone.
    for (const host of this.recoveredHosts) {
      if (this.hostGroups.has(host.id)) continue;
      const result = this.addHost(host.backendId, host.id, undefined, host.profile);
      if (!result.ok) {
        this.diagnostics.log('host-recovery-skipped', {
          hostId: host.id,
          backendId: host.backendId,
          error: result.error,
        });
      }
    }
    // Ownership and notes live in the snapshot, not only in this process.
    // Restore them before read-only auto-resume so a respawned sub-agent is
    // already tagged as the expert's when its terminal tab opens.
    this.restoreKickoffState();
    // A worker may have asked a question while the Coordinator host was still
    // starting; those messages are durable but undelivered. Re-deliver now.
    await this.meetingScheduler.redeliverPendingWorkerQuestions();
    if (this.recoveredTasks.length > 0) {
      this.meetingScheduler.emitRecoveredState();
      await this.autoResumeRecoveredReadOnlyTasks();
    }
    this.announceStoppedOwnedWorkers();
    for (const session of this.coordinatorReviewDriver.activeSessions()) {
      await this.coordinatorReviewDriver.resume(session.id);
    }
    this.resumeDisconnectedReviews();
    if (this.finalMeetingDelivery || this.finalMeetingDecision) {
      this.safeEmit({
        source: 'system',
        event: {
          kind: 'meeting-delivery-updated',
          delivery: this.finalMeetingDelivery
            ? structuredClone(this.finalMeetingDelivery)
            : null,
          decision: this.finalMeetingDecision
            ? structuredClone(this.finalMeetingDecision)
            : null,
        },
      });
    }
    // Persist the native backend handle before the renderer is told the Host
    // is ready. A crash after readiness can then recover the exact thread.
    await this.snapshotActiveMeeting();
  }

  async resolveRecoveredTask(
    taskId: string,
    action: TaskRecoveryAction,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.resolveRecoveredTaskWithActor(taskId, action, 'user');
  }

  private async autoResumeRecoveredReadOnlyTasks(): Promise<void> {
    const candidates = this.recoveredTasks
      .filter((task) => assessTaskRecovery(task).autoResume)
      .map((task) => String(task.id ?? ''))
      .filter(Boolean);
    for (const taskId of candidates) {
      const result = await this.resolveRecoveredTaskWithActor(
        taskId,
        'continue-read-only',
        'system-auto-read-only',
      );
      if (!result.ok) {
        await this.repository.append('recovered-task-auto-resume-failed', {
          schemaVersion: 1,
          taskId,
          error: result.error.slice(0, 2_000),
        });
      }
    }
  }

  private async resolveRecoveredTaskWithActor(
    taskId: string,
    action: TaskRecoveryAction,
    actor: 'user' | 'system-auto-read-only',
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const index = this.recoveredTasks.findIndex((task) => task.id === taskId);
    if (index < 0) return { ok: false, error: 'interrupted task not found' };
    const current = this.recoveredTasks[index];
    if (
      current.status !== 'interrupted'
      && current.status !== 'running'
      && current.status !== 'budget-paused'
      && current.status !== 'integration-conflict'
      && !(current.launchPhase === 'uncertain' && action === 'abandon-task')
    ) {
      return { ok: false, error: `task is already ${String(current.status)}` };
    }
    let recovery;
    try {
      recovery = assertRecoveryActionAllowed(current, action);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (actor === 'system-auto-read-only' && !recovery.autoResume) {
      return { ok: false, error: 'only explicit read-only tasks may auto-resume' };
    }
    if (actor !== 'user' && action !== 'continue-read-only') {
      return { ok: false, error: 'side-effecting recovery requires a user decision' };
    }
    if (action === 'resolve-integration-conflict') {
      const resolution = await this.integrationQueue.resolveInterruptedOperation(taskId);
      if (!resolution.ok) return resolution;
      await this.repository.append('recovered-integration-conflict-resolved', {
        schemaVersion: 1,
        taskId,
        action,
        actor,
        recovery,
      });
      await this.repository.flush();
      this.recoveredTasks[index] = { ...current, status: 'interrupted' };
      this.meetingScheduler.clearRecoveredIntegrationConflict(taskId);
      await this.snapshotActiveMeeting();
      return { ok: true };
    }

    const recoveredTask: PlanMeetingTaskInput = {
      id: String(current.id ?? ''),
      title: String(current.title ?? current.id ?? 'Recovered task'),
      prompt: String(current.prompt ?? ''),
      deps: Array.isArray(current.deps) ? current.deps.map(String) : [],
      executorBackendId: typeof current.executorBackendId === 'string'
        ? current.executorBackendId
        : undefined,
      writePaths: Array.isArray(current.writePaths) ? current.writePaths.map(String) : undefined,
      executionProfile: current.executionProfile as PlanMeetingTaskInput['executionProfile'],
      contextSelection: current.contextSelection as PlanMeetingTaskInput['contextSelection'],
      workspaceMode: current.workspaceMode as PlanMeetingTaskInput['workspaceMode'],
      authorityRequest: current.authorityRequest as PlanMeetingTaskInput['authorityRequest'],
      budget: current.budget as PlanMeetingTaskInput['budget'],
      acceptanceCriteria: Array.isArray(current.acceptanceCriteria)
        ? current.acceptanceCriteria
        : undefined,
      requiresDecision: typeof current.requiresDecision === 'boolean'
        ? current.requiresDecision
        : undefined,
    };
    let task: PlanMeetingTask;
    try {
      task = normalizePlanMeetingTasks(
        [recoveredTask],
        this.defaultWorkerBackendId(),
        this.normalizePlanOptions(),
      ).tasks[0];
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!task.id || !task.prompt) return { ok: false, error: 'recovered task is missing its id or prompt' };
    if (action !== 'abandon-task') {
      const backendError = await this.validateExecutionBackends([task]);
      if (backendError) return { ok: false, error: backendError };
    }
    // Persist and fsync the exact user/automatic authorization before any
    // Backend prompt can be sent by Scheduler.spawnReadyWorkers().
    await this.repository.append('recovered-task-resolution-authorized', {
      schemaVersion: 1,
      taskId,
      action,
      actor,
      recovery,
      attempt: typeof current.attempt === 'number' ? current.attempt : 1,
    });
    await this.repository.flush();
    const result = await this.meetingScheduler.resolveRecoveredTask(
      taskId,
      action as Exclude<TaskRecoveryAction, 'resolve-integration-conflict'>,
    );
    if (!result.ok) return result;
    if (action === 'abandon-task') {
      this.recoveredTasks[index] = { ...current, status: 'failed' };
    } else {
      this.recoveredTasks.splice(index, 1);
    }
    await this.repository.append('recovered-task-resolved', {
      schemaVersion: 1,
      taskId,
      action,
      actor,
    });
    await this.snapshotActiveMeeting();
    return { ok: true };
  }

  private emitRecoveredPlan(): void {
    const nodes = this.recoveredTasks.map((task) => ({
      id: String(task.id ?? ''),
      title: String(task.title ?? task.id ?? 'Interrupted task'),
      status: task.status === 'running' ? 'interrupted' : task.status,
      deps: Array.isArray(task.deps) ? task.deps.map(String) : [],
    })).filter((node) => node.id) as MeetingPlanNode[];
    this.safeEmit({
      source: 'system',
      event: {
        kind: 'plan-updated',
        plan: { version: this.meetingScheduler.getPlanVersion(), nodes },
      },
    });
  }

  private snapshotActiveMeeting(): Promise<void> {
    const liveTasks = this.meetingScheduler.snapshot();
    return this.repository.snapshot({
      status: 'active',
      cwd: this.cwd,
      coordinatorHostId: this.coordinatorHostId,
      hosts: this.listHosts().map((host) => ({
        ...host,
        // A host that has not finished (re)starting has no live session
        // handle yet; keep the recovered one so a crash in this window does
        // not strand the next recovery without a thread to resume.
        backendSession: host.backendSession ?? this.resumeBackendSessions[host.id],
      })),
      tasks: liveTasks.length > 0 ? liveTasks : this.recoveredTasks,
      taskMailboxes: (liveTasks.length > 0 ? liveTasks : this.recoveredTasks)
        .map((task) => {
          const taskId = String(task.id ?? '');
          const messages = taskId ? this.taskMailbox.list(taskId) : [];
          return {
            taskId,
            cursor: messages.at(-1)?.seq ?? 0,
            pending: messages
              .filter((message) => message.status !== 'acknowledged')
              .slice(-500)
              .map((message) => ({
                id: message.id,
                seq: message.seq,
                attempt: message.attempt,
                kind: message.kind,
                status: message.status,
              })),
          };
        })
        .filter((mailbox) => mailbox.taskId),
      ownedTasks: this.ownedTasksSnapshot(),
      meetingNotes: structuredClone(this.meetingNotes),
      reviewSessions: this.coordinatorReviewDriver.snapshot(),
      integrationQueue: this.integrationQueue.snapshot(),
      planVersion: this.meetingScheduler.getPlanVersion(),
      ...this.hostRuntime.planPreferences,
      finalMeetingDelivery: this.finalMeetingDelivery
        ? structuredClone(this.finalMeetingDelivery)
        : null,
      finalMeetingDecision: this.finalMeetingDecision
        ? structuredClone(this.finalMeetingDecision)
        : null,
    });
  }

  async sendUserText(text: string, inputId: string = randomUUID(), source: Exclude<UserHostInputSource, 'attachment'> = 'user-text') {
    // Shared inputs already have a durable Hub checkpoint and a single owner.
    if (this.sharedExecution) {
      const host = this.defaultHost();
      const session = host.isReady() ? host.getHost() : null;
      if (this.closed || !session) throw new Error('Shared Host is unavailable');
      session.sendUserText(text, 'high');
      return { inputId, hostId: host.id, state: 'submitted' as const };
    }
    const receipt = await this.hostInbox.receive(inputId, text, () => {
      if (this.closed) throw new Error('Meeting is closed');
      const error = this.remoteInputError(text);
      if (error) throw new Error(error);
      const mentions = this.resolveHostMentions(text);
      const mention = mentions.length === 1 ? mentions[0] : undefined;
      return {
        hostId: mention?.hostId ?? this.recoveringCoordinatorHostId ?? this.coordinatorHostId,
        direct: Boolean(mention), ...(mention ? { deliveryText: mention.text || '用户点名了你，请简短回应。' } : {}),
        ...(mentions.length > 1 ? { targetChoices: mentions.map(({ hostId }) => hostId) } : {}),
      };
    }, undefined, source);
    if (receipt.state !== 'awaiting-target') this.safeEmit({
      source: 'system',
      hostId: receipt.hostId,
      event: { kind: 'user-mentioned-host', backendId: this.hostGroups.get(receipt.hostId)?.backendId ?? '', chars: text.length },
    });
    return receipt;
  }

  readHostInput(inputId: string) {
    return this.hostInbox.read(inputId);
  }

  assignHostInput(inputId: string, hostId: string) {
    return this.hostInbox.assignTarget(inputId, hostId, () => !this.closed && this.hostGroups.has(hostId));
  }

  cancelHostInput(inputId: string) {
    return this.hostInbox.cancel(inputId);
  }

  private resolveHostMentions(text: string): Array<{ hostId: string; text: string }> {
    const remoteId = remoteMentionIds(text, this.listHosts())[0];
    const mentions = new Map<string, string>();
    for (const match of text.matchAll(/@([a-zA-Z0-9._-]+)/g)) {
      if (match.index && /[a-zA-Z0-9_.+-]/.test(text[match.index - 1])) continue;
      const token = match[1].toLowerCase();
      const hosts = [...this.hostGroups.entries()];
      const exact = hosts.filter(([id]) => id.toLowerCase() === token);
      const matches = exact.length ? exact : hosts.filter(([, host]) => host.backendId.toLowerCase() === token);
      const start = match.index ?? 0;
      const withoutMention = `${text.slice(0, start)}${text.slice(start + match[0].length)}`
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
      for (const [id] of matches) {
        if (this.remoteTargets.has(id) && id !== remoteId) continue;
        if (!mentions.has(id)) mentions.set(id, withoutMention);
      }
    }
    return [...mentions].map(([hostId, text]) => ({ hostId, text }));
  }

  async sendUserImage(content: SDKUserMessage['message']['content'], inputId: string = randomUUID(), requestHash?: string) {
    const text = typeof content === 'string' ? content : content.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('\n');
    return this.hostInbox.receive(inputId, text.slice(0, 100_000) || 'Shared attachment', () => {
      if (this.closed) throw new Error('Meeting is closed');
      const error = this.remoteInputError(text, true);
      if (error) throw new Error(error);
      return { hostId: this.recoveringCoordinatorHostId ?? this.coordinatorHostId, direct: false };
    }, typeof content === 'string' ? undefined : content as import('./backends/cli-backend.js').UserContentBlock[], 'attachment', requestHash);
  }

  remoteInputError(text: string, hasAttachments = false): string | null {
    const ids = remoteMentionIds(text, this.listHosts(), hasAttachments);
    if (hasAttachments && (ids.length || this.hostGroups.get(this.coordinatorHostId)?.backendId === 'pocket-vibe')) return REMOTE_ATTACHMENT_ERROR;
    if (ids.length > 1) return '请一次明确点名一个远端成员，本次未执行。';
    if (!ids.length) return null;
    const id = ids[0];
    const target = this.remoteTargets.get(id);
    const host = this.hostGroups.get(id);
    if (!target || !host) return '所点名的远端成员不可用或不唯一，请重新选择成员；本次未执行。';
    if (!host.isReady()) return `远端成员「${target.title}」正在连接、连接失败或已停止，请检查该成员状态后重试；本次未执行。`;
    return null;
  }

  resolvePermission(
    id: string,
    decision: 'allow' | 'deny',
    message?: string,
    scope: 'worker' | 'task-wide' = 'worker',
  ) {
    // Try every active host group; only the one that issued the permission
    // request actually has a matching pending entry.
    for (const hg of this.hostGroups.values()) {
      hg.resolvePermission(id, decision, message);
    }
    this.meetingScheduler.resolvePermissionInAny(id, decision, message, scope);
  }

  /** Live backend session of a meeting host (for IPC accessors that need
   *  adapter-specific optional methods, e.g. the editor snapshot getter). */
  getHostSession(hostId: string): BackendSession | null {
    return this.hostGroups.get(hostId)?.getHost() ?? null;
  }

  /** Journal meeting id — server-registry key component (PTY creation needs
   *  it to acquire the shared server for a meeting tab). */
  getMeetingId(): string {
    return this.meetingId;
  }

  getDeliveryArtifactRoot(): string {
    return this.repository.deliveryArtifactRoot();
  }

  async interrupt(hostId = this.coordinatorHostId) {
    // B4: abort end-of-meeting recap if it's mid-flight. Recap runs after
    // `end()` so an interrupt arriving here may be the only signal to stop.
    if (this.closed && this.recapHandle) {
      await this.recapHandle.abort();
      return;
    }
    const host = this.hostGroups.get(hostId);
    if (!host) throw new Error('Host not found');
    const controlId = randomUUID();
    const request = this.repository.append('host-interrupt-requested', { schemaVersion: 1, controlId, hostId });
    const [recorded, stopped] = await Promise.allSettled([request, host.interrupt()]);
    if (recorded.status === 'rejected') {
      this.diagnostics.log('host-interrupt-journal-failed', { controlId, hostId, error: String(recorded.reason) });
    } else {
      await this.repository.append('host-interrupt-result', {
        schemaVersion: 1, controlId, hostId, outcome: stopped.status === 'fulfilled' ? 'requested' : 'failed',
      }).catch((error) => this.diagnostics.log('host-interrupt-journal-failed', { controlId, hostId, error: String(error) }));
    }
    if (stopped.status === 'rejected') throw stopped.reason;
  }

  /** Returns true if the post-meeting recap is still in flight. Main process
   *  checks this to decide whether to keep the orchestrator reference alive
   *  past `end()` so a follow-up interrupt can still reach it. */
  isRecapActive(): boolean {
    return this.recapHandle?.isActive() ?? false;
  }

  /** Promise that resolves when the post-meeting recap finishes (success,
   *  abort, or failure). Main uses this to clear its held reference once the
   *  recap is no longer reachable. Null if no recap was started. */
  recapDonePromise(): Promise<void> | null {
    return this.recapHandle?.done ?? null;
  }

  async setPermissionMode(mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan') {
    const tasks = this.meetingScheduler.setPermissionModeAll(mode);
    for (const hg of this.hostGroups.values()) {
      tasks.push(hg.setPermissionMode(mode));
    }
    await Promise.allSettled(tasks);
  }

  /** `appQuit`: the app is shutting down rather than the user ending this
   *  meeting; only then does the next meeting in the folder pick up the
   *  kickoff state (experts, unfinished sub-agents, notes). */
  end(opts?: { appQuit?: boolean }): Promise<void> {
    if (this.endPromise) return this.endPromise;

    // Merge transcripts from all host groups for recap.
    const allTranscripts: import('./orchestrator-types.js').TalkerTurn[] = [];
    for (const hg of this.hostGroups.values()) {
      allTranscripts.push(...hg.getTranscript());
    }

    this.recapHandle = this.sharedExecution?null:startRecap({
      transcript: allTranscripts,
      cwd: this.cwd,
      env: this.workerEnv,
      projectId: this.projectId,
      meetingId: this.meetingId,
    });

    // Flush any unfinished worker progress into one final talker line so the
    // user isn't left wondering what happened. Done BEFORE closing the gate.
    const dh = this.defaultHost();
    const dhHost = dh.getHost();
    if (dhHost) {
      const finalLines = this.meetingScheduler.collectFinalBufferedLines();
      if (finalLines.length > 0) {
        this.safeEmit({
          source: 'talker',
          event: {
            kind: 'message',
            message: {
              type: 'assistant',
              message: { role: 'assistant', content: [{ type: 'text', text: `（会话结束前各 worker 最后动作）\n${finalLines.join('\n')}` }] },
              parent_tool_use_id: null,
              session_id: 'orchestrator-shutdown',
            } as unknown as SDKMessage,
          },
        });
      }
    }

    this.closed = true;
    this.queuedReviews.clear();
    if (this.reviewer) this.releaseReviewer(this.reviewer.reviewId);
    this.stopReviewStallWatchdog();
    this.clearAllHostAsks();

    const workerCleanup = this.meetingScheduler.endAll();
    const hostCleanup = Array.from(this.hostGroups.values(), (hg) =>
      hg.end().catch((err) => console.error('[orchestrator] host cleanup failed:', err)),
    );

    this.decisions.dispose();
    this.decisionMeta.clear();
    this.crossHostBus.dispose();
    Orchestrator.liveInstances.delete(this);

    const cleanup = Promise.allSettled([
      workerCleanup.then((unresolved) => { this.unresolvedWorkerStops = unresolved; }),
      ...hostCleanup, this.hostInbox.flush(), this.hostRuntime.flushPlanMutations(),
    ]).then(async (results) => {
      const failures = results.filter((result) => result.status === 'rejected');
      if (this.unresolvedWorkerStops.length || failures.length) {
        // Keep a recoverable record while the process owner is uncertain.
        await this.snapshotActiveMeeting();
      } else {
        await this.repository.snapshot({
          status: 'ended',
          cwd: this.cwd,
          coordinatorHostId: this.coordinatorHostId,
          hosts: this.listHosts(),
          workers: this.meetingScheduler.describeWorkers(),
          endedBy: opts?.appQuit ? 'app-quit' : 'user',
          ownedTasks: this.ownedTasksSnapshot(new Set(['done', 'accepted']), true),
          meetingNotes: structuredClone(this.meetingNotes),
        });
      }
      await this.repository.flush();
      if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), 'Meeting cleanup failed');
    });
    this.executionCleanup = cleanup;
    const cleanupPromises = [cleanup];
    if (this.recapHandle) cleanupPromises.push(this.recapHandle.done);

    this.endPromise = Promise.all(cleanupPromises).then(() => undefined);
    return this.endPromise;
  }

  async waitForExecutionCleanup(): Promise<void> {
    await this.executionCleanup;
    if (this.unresolvedWorkerStops.length) {
      throw new Error(`以下任务的原生进程树退出待核对：${this.unresolvedWorkerStops.join(', ')}`);
    }
  }

  /** Manual entry point: renderer-side "Plan meeting" button. */
  // ---- Empty-project kickoff, expert-owned sub-agents, meeting notes -------

  isTaskOwnedBy(taskId: string, hostId: string): boolean {
    return this.taskOwners.get(taskId) === hostId;
  }

  getHostProfile(hostId: string): HostProfile | undefined {
    return this.hostProfiles.get(hostId);
  }

  updateMeetingNotes(notes: MeetingNotes): void {
    this.meetingNotes = notes;
    const updatedAt = Date.now();
    this.safeEmit({ source: 'system', event: { kind: 'meeting-notes-updated', notes, updatedAt } });
    void this.snapshotActiveMeeting().catch((err) => console.error('[orchestrator] notes snapshot failed:', err));
  }

  getMeetingNotes(): MeetingNotes {
    return this.meetingNotes;
  }

  /**
   * User confirmed the kickoff card (AME-D23 stage confirmation): invite the
   * expert, install one sub-agent task it owns on a native-CLI worker, then
   * brief the expert and the coordinator. The task goes through the same
   * backend validation and authority envelope as any installed plan.
   */
  async startKickoff(input: {
    mode: KickoffMode;
    expertBackendId: string;
    profile: HostProfile;
  }): Promise<{ ok: true; expertHostId: string; taskId: string } | { ok: false; error: string }> {
    if (this.closed) return { ok: false, error: 'orchestrator is closed' };
    if (input.mode === 'brainstorm' && isNativeCliWorkerBackend(terminalWorkerBackendFor(input.expertBackendId))) {
      return { ok: false, error: '当前原生 CLI Worker 未验证只读权限配置，不能运行只读脑暴任务。请明确选择支持只读任务的执行方式。' };
    }
    const expertHostId = `expert-${randomUUID().slice(0, 8)}`;
    const added = this.addHost(input.expertBackendId, expertHostId, undefined, input.profile);
    if (!added.ok) return added;
    const taskId = `kickoff-${input.mode}-${randomUUID().slice(0, 6)}`;
    const title = input.mode === 'brainstorm' ? '调研项目现状与方向' : '搭建最小可运行骨架';
    const task: PlanMeetingTaskInput = {
      id: taskId,
      title,
      prompt: kickoffTaskPrompt(input.mode, input.profile),
      deps: [],
      executorBackendId: terminalWorkerBackendFor(input.expertBackendId),
      ...(input.mode === 'brainstorm'
        ? { workspaceMode: 'read-only' as const }
        : { workspaceMode: 'git-worktree' as const, writePaths: ['.'] }),
    };
    const installed = await this.installPlan([task]);
    if (!installed.ok) {
      this.removeHost(expertHostId);
      return installed;
    }
    this.taskOwners.set(taskId, expertHostId);
    this.ownedTaskInputs.set(taskId, task);
    void this.repository.append('kickoff-started', { mode: input.mode, expertHostId, taskId, profile: input.profile });
    this.safeEmit({ source: 'system', hostId: expertHostId, event: { kind: 'task-owner-assigned', taskId, title } });
    const who = `${input.profile.title} ${input.profile.name}`;
    // Queued on the cross-host bus until the expert's talker is ready.
    this.sendHostMessage(this.coordinatorHostId, expertHostId,
      `(kickoff) 你是本场会议的「${who}」。用户选择了${input.mode === 'brainstorm' ? '讨论脑暴' : '开始开发'}。`
      + `你名下有一个子 Agent 任务 ${taskId}「${title}」，它在共享区原生 CLI 里工作，用户只能看不能直接输入。`
      + `需要它做后续工作时，用 send_task_message 或 follow_up_task 给 ${taskId} 派具体、可验收的小任务；它的进展会转给你。`
      + '与用户讨论时简短、专业；需要用户拍板的事交给助理统一询问。');
    this.hostGroups.get(this.coordinatorHostId)?.getHost()?.sendUserText(
      `(kickoff) 用户选择了${input.mode === 'brainstorm' ? '讨论脑暴' : '开始开发'}。「${who}」已入会（hostId ${expertHostId}），`
      + `并派出子 Agent 任务 ${taskId}「${title}」。请你主持讨论：先用一两句话欢迎并说明接下来怎么聊，`
      + '然后每轮有实质进展就调用 update_meeting_notes 更新工作区纪要（核心结论、决策、待派工的工作项、零碎 TODO）。',
      'high',
    );
    await this.snapshotActiveMeeting();
    return { ok: true, expertHostId, taskId };
  }

  takeoverTask(taskId: string, reason?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.meetingScheduler.takeoverTask(taskId, reason);
  }

  /** The user took over a terminal worker or an expert's sub-agent and hands it
   *  back: read actual workspace changes FIRST on Native CLI Workers, then
   *  notify any owning expert Host before directing it again. */
  async handBackTask(
    taskId: string,
    note?: string,
  ): Promise<{ ok: true; workspaceSummary?: import('./worker-report-files.js').HandbackWorkspaceSummary } | { ok: false; error: string }> {
    if (this.meetingScheduler.hasWorker(taskId)) {
      const terminalHandback = await this.meetingScheduler.handBackTask(taskId, note);
      if (terminalHandback.ok) {
        const owner = this.taskOwners.get(taskId);
        if (owner) {
          void this.repository.append('task-handed-back', { taskId, owner });
          const filesDesc = terminalHandback.workspaceSummary.changedFiles.length > 0
            ? terminalHandback.workspaceSummary.changedFiles.map((f) => `${f.action}:${f.path}`).join(', ')
            : '无未提交文件改动';
          this.hostGroups.get(owner)?.getHost()?.sendUserText(
            `(handback) 用户刚才接管了你的子 Agent ${taskId}，现在交还给你。`
            + `已读取工作树实际改动（${filesDesc}）。${note ? `用户留言：${note}。` : ''}`
            + '基于最新内容再用 follow_up_task 继续派活，不要覆盖用户的改动。',
            'high',
          );
        }
        return terminalHandback;
      }
      if (!terminalHandback.error.includes('does not support terminal handback')) {
        return terminalHandback;
      }
    }
    const owner = this.taskOwners.get(taskId);
    if (!owner) return { ok: false, error: 'task has no owning expert' };
    const host = this.hostGroups.get(owner)?.getHost();
    if (!host) return { ok: false, error: 'owning expert is not connected' };
    void this.repository.append('task-handed-back', { taskId, owner });
    host.sendUserText(
      `(handback) 用户刚才接管了你的子 Agent ${taskId}，现在交还给你。${note ? `用户留言：${note}。` : ''}`
      + '先让它看一下工作树里用户改了什么（git status、git diff），基于最新内容再用 follow_up_task 继续派活，不要覆盖用户的改动。',
      'high',
    );
    return { ok: true };
  }

  /** A stopped (failed / ended) expert sub-agent: install a fresh attempt of
   *  the same task under the same expert. Running ones go through takeover. */
  async restartOwnedTask(taskId: string): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> {
    const owner = this.taskOwners.get(taskId);
    const input = this.ownedTaskInputs.get(taskId);
    if (!owner || !input) return { ok: false, error: 'task has no owning expert' };
    const base = taskId.replace(/-r\d+$/, '');
    let n = 2;
    while (this.taskOwners.has(`${base}-r${n}`)) n += 1;
    const nextId = `${base}-r${n}`;
    const installed = await this.installPlan([{ ...input, id: nextId }]);
    if (!installed.ok) return installed;
    this.taskOwners.set(nextId, owner);
    this.ownedTaskInputs.set(nextId, { ...input, id: nextId });
    void this.repository.append('owned-task-restarted', { from: taskId, to: nextId, owner });
    const title = input.title ?? nextId;
    this.safeEmit({ source: 'system', hostId: owner, event: { kind: 'task-owner-assigned', taskId: nextId, title } });
    this.hostGroups.get(owner)?.getHost()?.sendUserText(
      `(restart) 你名下的子 Agent ${taskId} 已停止，用户让它重新开始，新任务是 ${nextId}「${title}」。后续用 send_task_message / follow_up_task 给 ${nextId} 派活。`,
      'normal',
    );
    await this.snapshotActiveMeeting();
    return { ok: true, taskId: nextId };
  }

  private ownedTasksSnapshot(
    skipStatuses?: ReadonlySet<string>,
    latestAttemptOnly = false,
  ): { taskId: string; ownerHostId: string; input: PlanMeetingTaskInput }[] {
    const live = new Map(this.meetingScheduler.snapshot().map((task) => [task.id, task.status]));
    // 重新开始 makes `<task>-rN`; once a newer attempt exists the older one
    // has nothing left to restart.
    const attempt = (id: string) => Number(/-r(\d+)$/.exec(id)?.[1] ?? 1);
    const baseOf = (id: string) => id.replace(/-r\d+$/, '');
    const latest = new Map<string, number>();
    for (const taskId of this.taskOwners.keys()) {
      latest.set(baseOf(taskId), Math.max(latest.get(baseOf(taskId)) ?? 0, attempt(taskId)));
    }
    return [...this.taskOwners.entries()].flatMap(([taskId, ownerHostId]) => {
      const input = this.ownedTaskInputs.get(taskId);
      if (!input) return [];
      if (latestAttemptOnly && attempt(taskId) < (latest.get(baseOf(taskId)) ?? 0)) return [];
      const status = live.get(taskId);
      if (skipStatuses && status && skipStatuses.has(status)) return [];
      return [{ taskId, ownerHostId, input: structuredClone(input) }];
    });
  }

  /** Replay expert ownership and workspace notes from the recovered snapshot. */
  private restoreKickoffState(): void {
    if (this.recoveredMeetingNotes) {
      this.meetingNotes = this.recoveredMeetingNotes;
      this.safeEmit({
        source: 'system',
        event: { kind: 'meeting-notes-updated', notes: this.meetingNotes, updatedAt: Date.now() },
      });
    }
    for (const owned of this.recoveredOwnedTasks) {
      if (!owned?.taskId || !owned.ownerHostId || !owned.input?.prompt) continue;
      this.taskOwners.set(owned.taskId, owned.ownerHostId);
      this.ownedTaskInputs.set(owned.taskId, owned.input);
      const title = owned.input.title ?? owned.taskId;
      this.safeEmit({
        source: 'system',
        hostId: owned.ownerHostId,
        event: { kind: 'task-owner-assigned', taskId: owned.taskId, title },
      });
    }
  }

  /** A recovered sub-agent whose process is gone stays on the stage as stopped,
   *  so 重新开始 is reachable without a live terminal. Running ones are left
   *  to the scheduler's own worker-spawned event. */
  private announceStoppedOwnedWorkers(): void {
    const live = new Map(this.meetingScheduler.snapshot().map((task) => [task.id, task]));
    const stopped = new Set<WorkerStatusKind>(['failed', 'done', 'interrupted', 'accepted']);
    for (const [taskId] of this.taskOwners) {
      const input = this.ownedTaskInputs.get(taskId);
      if (!input) continue;
      const task = live.get(taskId);
      const status = task?.status ?? 'interrupted';
      if (!stopped.has(status)) continue;
      const backendId = task?.executorBackendId ?? input.executorBackendId;
      if (!backendId) continue;
      const title = task?.title || input.title || taskId;
      this.safeEmit({
        source: 'talker',
        event: {
          kind: 'worker-spawned',
          workerId: taskId,
          title,
          deps: task?.deps ?? [...(input.deps ?? [])],
          specialty: 'general',
          backendId,
        },
      });
      this.safeEmit({
        source: taskId,
        event: {
          kind: 'worker-ended',
          workerId: taskId,
          status,
          ...(task?.summary ? { summary: task.summary } : {}),
        },
      });
    }
  }

  private async publishWorkerQuestion(message: TaskMessage) {
    const text = objectRecord(message.payload).text;
    if (typeof text !== 'string') return;
    const inputId = `worker-question-${message.id}`;
    const prompt = `(task question from ${message.taskId}, message ${message.id}) ${text}`;
    const receipt = await this.hostInbox.receive(inputId, prompt.slice(0, 100_000),
      () => ({ hostId: this.recoveringCoordinatorHostId ?? this.coordinatorHostId, direct: false }), undefined, 'worker-question');
    if (receipt.state === 'submitted') await this.taskMailbox.markDelivered(message.taskId, message.id);
  }

  private async markHostQuestionSubmitted(messageId: string) {
    try {
      const question = this.taskMailbox.findMessage(messageId);
      if (question?.sender === 'worker' && question.kind === 'question') {
        await this.taskMailbox.markDelivered(question.taskId, messageId);
      }
    } catch (error) {
      this.diagnostics.log('worker-question-receipt-failed', { messageId, error: String(error) });
    }
  }

  private publishCoordinatorBriefing(briefing: CoordinatorBriefing, attempt?: number): void {
    if (this.closed || briefing.kind === 'capacity') return;
    const taskId = briefing.taskId ?? briefing.workerId;
    const coordinator = this.recoveringCoordinatorHostId ?? this.coordinatorHostId;
    const owner = taskId ? this.taskOwners.get(taskId) : undefined;
    const recipients = new Set([coordinator, ...(owner && this.hostGroups.has(owner) ? [owner] : [])]);
    for (const hostId of recipients) {
      const identity = createHash('sha256').update(JSON.stringify([
        taskId, attempt, briefing.kind, briefing.title, briefing.summary, briefing.blockers,
        briefing.files, briefing.testsPassed, briefing.testsFailed, hostId,
      ])).digest('hex');
      const text = (hostId === coordinator ? '[structured coordinator briefing]' : `(your sub-agent ${taskId})`)
        + `\n${JSON.stringify({
          id: identity, taskId, attempt, kind: briefing.kind, title: briefing.title, summary: briefing.summary,
          blockers: briefing.blockers, files: briefing.files, testsPassed: briefing.testsPassed, testsFailed: briefing.testsFailed,
        })}`
        + '\nUse the exact taskId for task commands. Surface the issue or decision without reading raw logs aloud.';
      void this.hostInbox.receive(`briefing-${identity}`, text.slice(0, 100_000),
        () => ({ hostId, direct: false }), undefined, 'runtime-notification').catch((error) => {
        this.diagnostics.log('worker-briefing-receive-failed', { identity, error: String(error) });
      });
    }
  }

  async installPlan(tasks: PlanMeetingTaskInput[]): Promise<{ ok: true } | { ok: false; error: string }> {
    if(this.sharedExecution)return this.proposePlan(tasks);
    let normalized: PlanMeetingTask[];
    try {
      normalized = normalizePlanMeetingTasks(
        tasks,
        this.defaultWorkerBackendId(),
        this.normalizePlanOptions(),
      ).tasks;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    normalized = this.adaptPlanForWorkspaceBaseline(normalized);
    const backendError = await this.validateExecutionBackends(normalized);
    if (backendError) return { ok: false, error: backendError };
    return this.hostRuntime.mutatePlan(() => this.hostRuntime.install(normalized, 'manual-install'));
  }

  /** Internal Task 9 seam; renderer and Backends never receive the repository
   * or mutate mailbox state directly. */
  getTaskMailbox(): TaskMailbox {
    return this.taskMailbox;
  }

  getTaskProjection(): TaskProjectionResult {
    return {
      tasks: structuredClone(this.taskProjection.tasks),
      diagnostics: structuredClone(this.taskProjection.diagnostics),
    };
  }

  /** Main-process Task IPC source. It intentionally returns internal records
   * only to the privileged IPC projector; the renderer receives a redacted
   * task view from electron/ipc/tasks.ts. */
  async getTaskInspectorSource(taskId: string): Promise<{
    meetingId: string;
    task: ReturnType<WorkerScheduler['snapshot']>[number];
    record: TaskProjectionResult['tasks'][number] | null;
    diagnostics: TaskProjectionResult['diagnostics'];
    mailbox: TaskMessage[];
    events: PersistedMeetingEvent[];
  } | null> {
    await this.repositoryReady;
    const task = this.meetingScheduler.snapshot().find((entry) => entry.id === taskId);
    if (!task) return null;
    const events = await this.repository.replayAll();
    const durableProjection = projectMeetingTasks(events);
    return {
      meetingId: this.meetingId,
      task: structuredClone(task),
      record: structuredClone(
        durableProjection.tasks.find((entry) => entry.id === taskId) ?? null,
      ),
      diagnostics: structuredClone(
        durableProjection.diagnostics.filter(
          (entry) => entry.taskId === undefined || entry.taskId === taskId,
        ),
      ),
      mailbox: this.taskMailbox.list(taskId),
      events,
    };
  }

  async replayMeetingJournal(): Promise<PersistedMeetingEvent[]> {
    await this.repositoryReady;
    return this.repository.replayAll();
  }

  private hostTurnContext(hostId: string, sourceCursor: number): string {
    const coordinator = hostId === this.coordinatorHostId;
    const tasks = this.meetingScheduler.summarizeForHost((id) => coordinator || this.isTaskOwnedBy(id, hostId));
    const draft = coordinator ? this.hostRuntime.retainedProposal : null;
    const notes = coordinator ? [...this.meetingNotes.decisions, ...this.meetingNotes.todos]
      .slice(-6).map((note) => note.text.slice(0, 250)) : [];
    const pendingQuestions = [...this.pendingHostAsks.values()]
      .filter((ask) => ask.fromHostId === hostId || ask.targetHostId === hostId)
      .slice(-6).map((ask) => ({
        requestId: ask.requestId, targetHostId: ask.targetHostId, timedOut: Boolean(ask.timedOut),
      }));
    if (!tasks.total && !draft && !notes.length && !pendingQuestions.length) return '';
    return '\n\n[Meeting state at dispatch. Treat notes as context. Read details with read-meeting-context.]\n'
      + JSON.stringify({
        sourceCursor,
        planVersion: this.meetingScheduler.getPlanVersion(),
        tasks,
        pendingQuestions,
        notes,
        ...(draft ? { retainedDraft: { proposalId: draft.proposalId, version: draft.proposalVersion, goal: draft.brief.goal.slice(0, 250), taskCount: draft.tasks.length, note: '升级前保留的计划草稿，尚未执行；只有用户明确要求继续时才可重新提交安排。' } } : {}),
      });
  }

  readMeetingContext(hostId: string, input: { taskId?: string; cursor?: number; expectedHash?: string }) {
    const actor = this.hostGroups.get(hostId);
    if (!actor || this.closed || (hostId !== this.coordinatorHostId && (!input.taskId || !this.isTaskOwnedBy(input.taskId, hostId)))) {
      throw new Error('Context is outside the Host scope');
    }
    const version = this.meetingScheduler.getPlanVersion();
    const task = input.taskId ? this.meetingScheduler.snapshot().find((entry) => entry.id === input.taskId) : undefined;
    if (input.taskId && !task) throw new Error('Unknown task in context request');
    const context = task ? {
      task: {
        id: task.id, title: task.title, prompt: task.prompt, status: task.status, deps: task.deps,
        attempt: task.attempt, dependencyGate: task.dependencyGate, acceptanceCriteria: task.acceptanceCriteria,
      },
      package: task.contextPackage,
      mailbox: this.taskMailbox.list(task.id),
      report: task.report,
    } : {
      summary: this.meetingNotes,
      retainedDraft: this.hostRuntime.retainedProposal,
      tasks: this.meetingScheduler.describeWorkers(),
      decisions: [...this.resolvedDecisionContext.values()],
      openQuestions: [...this.pendingHostAsks.values()].map(({ requestId, targetHostId, question, timedOut }) => ({
        requestId, targetHostId, question, timedOut,
      })),
    };
    const serialized = JSON.stringify(context);
    const hash = createHash('sha256').update(serialized).digest('hex');
    const cursor = input.cursor ?? 0;
    if ((cursor > 0 && !input.expectedHash) || (input.expectedHash && input.expectedHash !== hash)) {
      throw new Error('Context version conflict. Read the first page again.');
    }
    const scalars = Array.from(serialized);
    if (cursor > scalars.length) throw new Error('Context cursor is outside the resource');
    const next = Math.min(cursor + 8_000, scalars.length);
    return {
      schemaVersion: 1, version, hash, cursor,
      text: scalars.slice(cursor, next).join(''),
      nextCursor: next < scalars.length ? next : null,
      complete: next === scalars.length,
    };
  }

  subscribeMeetingJournal(
    listener: (event: PersistedMeetingEvent) => void,
  ): () => void {
    return this.repository.subscribe(listener);
  }

  private normalizePlanOptions(): {
    cwd: string;
    baselineKind: 'git-clean' | 'git-dirty' | 'non-git';
    nativeCliWorkers: boolean;
  } {
    return {
      cwd: this.cwd,
      baselineKind: this.workspaceManager.inspectBaseline().kind,
      nativeCliWorkers: !this.sharedExecution,
    };
  }

  async proposePlan(
    tasks: PlanMeetingTaskInput[],
    briefInput?: MeetingPlanBriefInput,
    isCurrent = () => !this.closed,
    requestId?: string,
  ): Promise<{ ok: true; status: 'installed'; appliedDefaults?: AppliedTaskDefaults[] } | { ok: false; error: string }> {
    if (!isCurrent() || this.closed) return { ok: false, error: 'Host session was replaced or meeting closed' };
    if(this.sharedExecution) {
      try {await this.sharedExecution.propose(tasks,normalizeMeetingPlanBrief(briefInput,tasks));return {ok:true,status:'installed'};}
      catch(error){return {ok:false,error:(typeof (error as {code?:unknown})?.code==='string'?String((error as {code:string}).code)+': ':'')+(error instanceof Error?error.message:String(error))};}
    }
    let normalized: PlanMeetingTask[];
    let appliedDefaults: AppliedTaskDefaults[];
    try {
      const result = normalizePlanMeetingTasks(
        tasks,
        this.defaultWorkerBackendId(),
        this.normalizePlanOptions(),
      );
      normalized = result.tasks;
      appliedDefaults = result.appliedDefaults;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    normalized = this.adaptPlanForWorkspaceBaseline(normalized);
    const backendError = await this.validateExecutionBackends(normalized);
    if (backendError) return { ok: false, error: backendError };
    const brief = normalizeMeetingPlanBrief(briefInput, normalized);
    const applied = appliedDefaults.length > 0 ? { appliedDefaults } : {};
    return this.hostRuntime.mutatePlan(async () => {
      if (!isCurrent() || this.closed) return { ok: false, error: 'Host session was replaced or meeting closed' };
      const installed = await this.hostRuntime.install(normalized, 'host-request', brief, isCurrent, requestId);
      return installed.ok ? { ok: true, status: 'installed' as const, ...applied } : installed;
    });
  }

  private adaptPlanForWorkspaceBaseline(tasks: PlanMeetingTask[]): PlanMeetingTask[] {
    const kind = this.workspaceManager.inspectBaseline().kind;
    if (kind === 'git-clean') return tasks;
    return tasks.map((task) => {
      const workspaceMode = coerceWorkspaceModeForBaseline(task.workspaceMode, kind);
      return workspaceMode === task.workspaceMode ? task : { ...task, workspaceMode };
    });
  }

  setAutoOrchestration(enabled: boolean): Promise<void> {
    return this.hostRuntime.setPlanPreferences({ autoOrchestration: enabled });
  }

  /** Only the coordinator talker; accepted Workers remain owned by their task. */
  async interruptHostReply():Promise<void> {await this.defaultHost().getHost()?.interrupt();}

  hostSessionSnapshot():BackendSessionSnapshot|undefined {return this.defaultHost().getHost()?.snapshot?.()??undefined;}

  private async validateExecutionBackends(tasks: PlanMeetingTask[]): Promise<string | null> {
    const defaultBackendId = this.defaultWorkerBackendId();
    const checked = new Set<string>();
    for (const task of tasks) {
      const backendId = task.executorBackendId ?? defaultBackendId;
      if (!isNativeCliWorkerBackend(backendId)) {
        return `unsupported-contract: Worker '${backendId}' 必须使用本地原生 CLI`;
      }
      if (isNativeCliWorkerBackend(backendId) && task.workspaceMode === 'read-only') {
        return `unsupported-contract: backend '${backendId}' 未验证原生只读权限配置，不能执行 read-only 任务`;
      }
      const backend = getBackendRegistry().get(backendId);
      if (!backend) return `backend '${backendId}' is not registered`;
      if (!backend.capabilities.executeTasks) {
        return `backend '${backendId}' cannot execute delivery tasks`;
      }
      if (!backend.compileTaskProfile) {
        return `backend '${backendId}' does not compile task profiles`;
      }
      if (!backend.normalizePermissionRequest) {
        return `backend '${backendId}' does not normalize permission requests`;
      }
      if (checked.has(backendId)) continue;
      checked.add(backendId);
      // Unit/integration tests inject a controlled SessionFactory. Production
      // plans must additionally pass the exact runtime/auth gate before any
      // task is installed into the global Scheduler.
      if (this.sessionFactory !== Orchestrator.defaultClaudeFactory) continue;
      const parentAuthBackendId = backendId === 'claude-code-terminal'
        ? 'claude-code'
        : backendId === 'codex-terminal'
          ? 'codex'
          : null;
      const authEntry = getBackendAuth(backendId)
        ?? (parentAuthBackendId ? getBackendAuth(parentAuthBackendId) : undefined);
      const auth = authEntry
        ? {
            authMode: authEntry.authMode,
            apiKey: authEntry.apiKey,
            baseUrl: authEntry.baseUrl,
            model: authEntry.model,
          }
        : { authMode: 'none' as const };
      const probe = await getBackendRegistry().probe(backendId, auth);
      const assessment = assessConfiguredWorkerRuntime({
        backendId,
        installed: probe.installed,
        implementationEnabled: backend.capabilities.executeTasks,
        authenticated: probe.auth !== 'required',
        version: probeWorkerRuntimeVersion(backendId, probe.runtimePath),
      });
      if (assessment.state !== 'available') {
        return `backend '${backendId}' is unavailable: ${assessment.reason}`;
      }
    }
    return null;
  }

  // ===========================================================================
  // OrchestratorBridge — methods called from the MCP tool factories in
  // meeting-mcp.ts. These route to the default host's scheduler. In a full
  // multi-host setup, the bridge would be hostId-aware; for now the default
  // host handles all MCP tool callbacks.

  async delegateSingleTask(input: string | {
    description: string;
    requestId?: string;
    writePaths?: string[];
    workspaceMode?: PlanMeetingTaskInput['workspaceMode'];
    commands?: string[][];
    networkHosts?: string[];
    toolKinds?: string[];
  }, isCurrent = () => !this.closed): Promise<
    | {
        ok: true;
        workerId: string;
        specialty: WorkerSpecialtyKind;
        reused: boolean;
        status: 'spawned' | 'installed';
        appliedDefaults?: string[];
      }
    | { ok: false; error: string }
  > {
    if (!isCurrent()) return { ok: false, error: 'Host session was replaced' };
    if(this.sharedExecution)return {ok:false,error:'共享派活必须提交明确设备与 Agent 的完整计划；请使用 plan_meeting / propose-plan'};
    const request = typeof input === 'string' ? { description: input } : input;
    const description = request.description.trim();
    if (!description) return { ok: false, error: 'description is required' };

    const backendId = this.defaultWorkerBackendId();
    const backend = getBackendRegistry().get(backendId);
    if (!backend) return { ok: false, error: `backend '${backendId}' is not registered` };
    if (!backend.capabilities.executeTasks) {
      return { ok: false, error: `backend '${backendId}' cannot execute delivery tasks` };
    }

    const title = titleFromDescription(description);
    const specialty = inferSpecialty(`${title} ${description}`);

    // Production Claude meetings require a compiled authority grant. Route the
    // single-task shorthand through proposePlan so it gets the same durable
    // envelope and direct install path as plan_meeting.
    if (this.sessionFactory === Orchestrator.defaultClaudeFactory) {
      const writePaths = request.writePaths ?? [];
      const workerId = `delegate-${request.requestId
        ? createHash('sha256').update(request.requestId).digest('hex').slice(0, 24)
        : randomUUID().slice(0, 8)}`;
      // Intent defaults (sandbox write path / test commands / workspace mode)
      // are applied inside normalizePlanMeetingTask via proposePlan.
      const task: PlanMeetingTaskInput = {
        id: workerId,
        title,
        prompt: description,
        deps: [],
        ...(writePaths.length > 0 ? { writePaths } : {}),
        ...(request.workspaceMode ? { workspaceMode: request.workspaceMode } : {}),
        ...(request.commands || request.networkHosts || request.toolKinds
          ? {
              authorityRequest: {
                writePaths,
                toolKinds: request.toolKinds
                  ?? (writePaths.length > 0 ? ['read', 'write'] : ['read']),
                workingDirectories: ['.'],
                commands: request.commands ?? [],
                environmentKeys: [],
                maxCommandTimeoutMs: 1_800_000,
                networkHosts: request.networkHosts ?? [],
              },
            }
          : {}),
      };
      const proposed = await this.proposePlan([task], undefined, isCurrent, request.requestId);
      if (!proposed.ok) return proposed;
      const notes = proposed.appliedDefaults?.find((entry) => entry.taskId === workerId)?.notes;
      return {
        ok: true,
        workerId,
        specialty,
        reused: false,
        status: proposed.status,
        ...(notes?.length ? { appliedDefaults: notes } : {}),
      };
    }

    const delegated = await this.hostRuntime.mutatePlan(async () => {
      if (!isCurrent()) return null;
      return this.meetingScheduler.delegateSingleTask(description);
    });
    if (!delegated) return { ok: false, error: 'Host session was replaced' };
    return { ok: true, ...delegated, status: 'spawned' };
  }

  steerWorker(workerId: string, addendum: string): Promise<SteerResult> {
    // Search across all host groups — worker IDs are unique.
    return this.meetingScheduler.steerWorker(workerId, addendum);
  }

  async sendTaskMessage(
    taskId: string,
    message: string,
    executorBackendId?: string,
    isCurrent?: () => boolean,
  ): Promise<{ id: string; status: string }> {
    const queued = await this.meetingScheduler.sendTaskMessage(taskId, message,
      executorBackendId ? nativeWorkerBackendId(executorBackendId) : undefined, isCurrent);
    return { id: queued.id, status: queued.status };
  }

  async queueTaskFollowUp(
    taskId: string,
    message: string,
    executorBackendId?: string,
    identity?: { inputId: string; replyTo?: string },
    isCurrent?: () => boolean,
  ): Promise<{ id: string; status: string }> {
    const queued = await this.meetingScheduler.queueFollowUp(taskId, message,
      executorBackendId ? nativeWorkerBackendId(executorBackendId) : undefined, identity, isCurrent);
    return { id: queued.id, status: queued.status };
  }

  extendTaskBudget(taskId: string, expectedPlanVersion: number, rawBudget: TaskBudget): Promise<{ planVersion: number; budget: TaskBudget }> {
    return this.hostRuntime.mutatePlan(() => this.applyTaskBudgetExtension(taskId, expectedPlanVersion, rawBudget));
  }

  private async applyTaskBudgetExtension(
    taskId: string,
    expectedPlanVersion: number,
    rawBudget: TaskBudget,
  ): Promise<{ planVersion: number; budget: TaskBudget }> {
    const budget = taskBudgetSchema.parse(rawBudget);
    if (expectedPlanVersion !== this.meetingScheduler.getPlanVersion()) {
      throw new Error(
        `stale plan version: expected ${expectedPlanVersion}, current ${this.meetingScheduler.getPlanVersion()}`,
      );
    }
    const task = this.meetingScheduler.snapshot().find((entry) => entry.id === taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    if (task.status !== 'budget-paused' || !task.budget) {
      throw new Error(`task ${taskId} is not paused by its budget`);
    }
    const keys = [
      'maxAttempts',
      'maxTotalTokens',
      'maxTotalDurationMs',
      'maxStagnantAttempts',
    ] as const;
    if (keys.some((key) => budget[key] < task.budget![key])) {
      throw new Error('a budget extension cannot reduce an approved limit');
    }
    if (keys.every((key) => budget[key] === task.budget![key])) {
      throw new Error('a budget extension must increase at least one limit');
    }
    const decisionId = `budget-${randomUUID()}`;
    await this.repository.appendTaskEvent('task-budget-extension-approved', {
      schemaVersion: 1,
      taskId,
      attempt: task.attempt,
      data: {
        schemaVersion: 1,
        decisionId,
        expectedPlanVersion,
        previousBudget: structuredClone(task.budget),
        budget: structuredClone(budget),
        authorityRequestHash: task.authorityRequest
          ? hashTaskAuthorityRequest(task.authorityRequest)
          : null,
        decidedAt: Date.now(),
      },
    });
    await this.repository.flush();
    const result = await this.meetingScheduler.extendTaskBudget(
      taskId,
      expectedPlanVersion,
      budget,
      decisionId,
    );
    await this.repository.appendTaskEvent('task-budget-extension-applied', {
      schemaVersion: 1,
      taskId,
      attempt: (task.attempt ?? 1) + 1,
      data: {
        schemaVersion: 1,
        decisionId,
        planVersion: result.planVersion,
        budget: structuredClone(result.budget),
      },
    });
    await this.snapshotActiveMeeting();
    await this.repository.flush();
    return result;
  }

  interruptWorker(workerId: string, reason?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.meetingScheduler.interruptWorker(workerId, reason);
  }

  async forwardTaskMessage(
    fromTaskId: string,
    toTaskId: string,
    messageId: string,
  ): Promise<{ id: string; status: string }> {
    const forwarded = await this.meetingScheduler.forwardTaskMessage(
      fromTaskId,
      toTaskId,
      messageId,
    );
    return { id: forwarded.id, status: forwarded.status };
  }

  async askCoordinator(
    workerId: string,
    question: string,
    sourceAttempt?: number,
  ): Promise<{ id: string; status: string }> {
    const message = await this.meetingScheduler.recordWorkerQuestion(
      workerId,
      question,
      sourceAttempt,
    );
    return { id: message.id, status: message.status };
  }

  hasWorker(workerId: string): boolean {
    return this.meetingScheduler.hasWorker(workerId);
  }

  activeWorkerIds(): string[] {
    return this.meetingScheduler.activeWorkerIds();
  }

  describeWorkers(workerId?: string): string {
    return this.meetingScheduler.describeWorkers(workerId);
  }

  // ---- Observed-session tools (Host voice-intent routing) ------------------
  // Thin bridge wrappers: resolution + action semantics live in
  // observe/session-actions.ts (electron-free, unit-tested with injected
  // exec/fs); the orchestrator only supplies the live snapshot.

  listObservedSessions(): ObservedSessionToolRow[] {
    return listBoardableObservedSessionRows(this.getObservedSnapshot(), Date.now());
  }

  focusObservedSessionById(id: string): Promise<ObservedActionOutcome> {
    return runObservedSessionAction(this.getObservedSnapshot(), { kind: 'focus', id });
  }

  sendTextToObservedSessionById(id: string, text: string): Promise<ObservedActionOutcome> {
    return runObservedSessionAction(this.getObservedSnapshot(), { kind: 'send-text', id, text });
  }

  narrateAssistantLine(text: string): void {
    this.safeEmit({
      source: 'talker',
      event: {
        kind: 'message',
        message: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: 'orchestrator-narrate',
        } as unknown as SDKMessage,
      },
    });
  }

  async createDecision(payload: CreateDecisionPayload): Promise<DecisionCreationResult> {
    const created = await createDecisionDoc(payload);
    const recommended = payload.options[created.recommendedIndex];
    this.decisionMeta.set(created.id, { question: payload.question, path: created.path });
    this.decisions.watch(created.id, created.path, (r) => this.onDecisionResolved(r));
    this.safeEmit({
      source: 'talker',
      event: {
        kind: 'decision-pending',
        decisionId: created.id,
        question: payload.question,
        path: created.path,
        recommendedTitle: recommended?.title ?? '',
        calendarOk: created.calendar.ok,
        remindersOk: created.reminders.ok,
      },
    });
    const sideChannelNote = [
      created.calendar.ok ? 'Calendar ✓' : 'Calendar ✗',
      created.reminders.ok ? 'Reminders ✓' : 'Reminders ✗',
    ].join(' / ');
    return {
      id: created.id,
      path: created.path,
      recommendedTitle: recommended?.title ?? '',
      calendarOk: created.calendar.ok,
      remindersOk: created.reminders.ok,
      sideChannelNote,
    };
  }

  private async getAuthorizedTaskContextSource(
    taskId: string,
    selection: ContextSelection,
  ): Promise<AuthorizedMeetingContextSource> {
    const messages = Array.from(this.hostGroups.values())
      .flatMap((host) => host.getTranscript())
      .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
    const meetingSummary = messages
      .slice(-40)
      .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`)
      .join('\n');
    return {
      messages,
      meetingSummary,
      decisions: Array.from(this.resolvedDecisionContext.values())
        .sort((left, right) => left.id.localeCompare(right.id)),
      dependencyReports: this.meetingScheduler.getAcceptedDependencyReports(taskId),
      attachments: await listAuthorizedAssetReferences(this.cwd, selection.attachmentIds),
    };
  }

  private async persistContextPackage(contextPackage: ContextPackage): Promise<void> {
    await this.repository.appendTaskEvent('context-package-frozen', {
      schemaVersion: 1,
      taskId: contextPackage.taskId,
      attempt: contextPackage.attempt,
      data: { package: contextPackage },
    });
    await this.repository.flush();
  }

  private async compileTaskProfile(
    requestedProfile: TaskExecutionProfile,
  ): Promise<{
    runtime: BackendRuntime;
    effectiveProfile: BackendEffectiveProfile;
  }> {
    const registry = getBackendRegistry();
    nativeWorkerBackendId(requestedProfile.backendId);
    if (!isNativeCliWorkerBackend(requestedProfile.backendId)) {
      throw new Error('unsupported-contract: task profile must use the normalized native CLI backend');
    }
    const backend = registry.get(requestedProfile.backendId);
    if (!backend) {
      throw new Error(`backend '${requestedProfile.backendId}' is not registered`);
    }
    if (!backend.capabilities.executeTasks || !backend.compileTaskProfile) {
      throw new Error(`backend '${requestedProfile.backendId}' cannot compile Worker task profiles`);
    }
    const runtimePath = backend.resolveBinary();
    if (!runtimePath) {
      throw new Error(`backend '${requestedProfile.backendId}' runtime is unavailable`);
    }
    const version = probeWorkerRuntimeVersion(requestedProfile.backendId, runtimePath);
    const assessment = assessConfiguredWorkerRuntime({
      backendId: requestedProfile.backendId,
      installed: true,
      implementationEnabled: true,
      authenticated: true,
      version,
    });
    if (assessment.state !== 'available' || !assessment.version) {
      throw new Error(
        `backend '${requestedProfile.backendId}' runtime profile is unavailable: ${assessment.reason}`,
      );
    }
    const runtime = backendRuntimeSchema.parse({
      schemaVersion: 1,
      backendId: requestedProfile.backendId,
      runtimeVersion: assessment.version,
    });
    return {
      runtime,
      effectiveProfile: registry.compileTaskProfile(
        requestedProfile.backendId,
        requestedProfile,
        runtime,
      ),
    };
  }

  private async persistTaskProfile(input: {
    taskId: string;
    attempt: number;
    requestedProfile: TaskExecutionProfile;
    runtime: BackendRuntime;
    effectiveProfile: BackendEffectiveProfile;
  }): Promise<void> {
    await this.repository.appendTaskEvent('backend-profile-compiled', {
      schemaVersion: 1,
      taskId: input.taskId,
      attempt: input.attempt,
      data: {
        requestedProfile: input.requestedProfile,
        runtime: input.runtime,
        effectiveProfile: input.effectiveProfile,
        capabilityHash: input.effectiveProfile.capabilityHash,
      },
    });
    await this.repository.flush();
  }

  private async persistTaskAuthority(input: {
    taskId: string;
    attempt: number;
    authorityGrant: TaskAuthorityGrant;
  }): Promise<void> {
    await this.repository.appendTaskEvent('task-authority-compiled', {
      schemaVersion: 1,
      taskId: input.taskId,
      attempt: input.attempt,
      data: {
        authorityGrant: input.authorityGrant,
        grantHash: input.authorityGrant.grantHash,
      },
    });
    await this.repository.flush();
  }

  private async persistPermissionDecision(input: {
    taskId: string;
    attempt: number;
    nativeRequestId: string;
    decision: 'allow' | 'ask-user' | 'deny';
    reason: string;
    safeInput: Record<string, unknown>;
    grantHash?: string;
  }): Promise<void> {
    await this.repository.appendTaskEvent('task-permission-decided', {
      schemaVersion: 1,
      taskId: input.taskId,
      attempt: input.attempt,
      data: {
        nativeRequestId: input.nativeRequestId,
        decision: input.decision,
        reason: input.reason,
        safeInput: input.safeInput,
        ...(input.grantHash ? { grantHash: input.grantHash } : {}),
      },
    });
    await this.repository.flush();
  }

  async saveMemory(input: { category: MemoryCategory; content: string; tags: string[] }): Promise<SaveMemoryResult> {
    if (this.saveMemoryCallsThisSession >= SAVE_MEMORY_PER_SESSION_LIMIT) {
      return { ok: false, error: `rate limit reached (${SAVE_MEMORY_PER_SESSION_LIMIT}/session)` };
    }
    this.saveMemoryCallsThisSession += 1;
    const r = await appendEntry({
      category: input.category,
      content: input.content,
      tags: input.tags,
      projectId: this.projectId,
      sourceMeetingId: this.meetingId,
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, preview: input.content.slice(0, 40) };
  }

  /** Save a report-mode document to .vibe-docs/ and emit a document-saved
   *  event so the renderer can display it. Filename is derived from date + title. */
  async saveDocument(input: { title: string; content: string; spokenSummary: string }): Promise<{ ok: boolean; filename?: string; error?: string }> {
    try {
      const docsDir = await ensureDir(this.cwd, '.vibe-docs');
      if (!docsDir) return { ok: false, error: 'could not create .vibe-docs directory' };

      const now = new Date();
      const pad2 = (n: number) => String(n).padStart(2, '0');
      const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
      const safeTitle = input.title
        .replace(/[^a-zA-Z0-9一-鿿\s_-]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 40);
      const filename = `${dateStr}-${safeTitle}.md`;
      const filePath = path.join(docsDir, filename);

      // Prepend YAML front-matter with title for the renderer to display
      const header = `---\ntitle: ${input.title}\ncreated: ${now.toISOString()}\n---\n\n`;
      await fsp.writeFile(filePath, header + input.content, 'utf8');
      await maybeAppendGitignore(this.cwd, '.vibe-docs');

      // Emit event so the renderer can show the document
      this.safeEmit({
        source: 'talker',
        event: {
          kind: 'document-saved',
          title: input.title,
          filename,
          path: filePath,
        },
      });

      return { ok: true, filename };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[orchestrator] saveDocument failed:', msg);
      return { ok: false, error: msg };
    }
  }

  markWorkerTaskDone(workerId: string, summary: string, sourceAttempt?: number): void {
    // Search across all host groups.
    this.meetingScheduler.markTaskDone(workerId, summary, sourceAttempt);
  }

  /** Build and durably expose the sole final Meeting delivery. Per-task
   * acceptance only advances the private integration branch; this method
   * additionally re-verifies every accepted task on the exact final head. */
  async prepareFinalMeetingDelivery(): Promise<MeetingDelivery | null> {
    if (this.finalDeliveryBuild) return this.finalDeliveryBuild;
    this.finalDeliveryBuild = this.buildFinalMeetingDelivery().finally(() => {
      this.finalDeliveryBuild = undefined;
    });
    return this.finalDeliveryBuild;
  }

  getMeetingDelivery(): Promise<MeetingDelivery | null> {
    return this.prepareFinalMeetingDelivery();
  }

  getFinalMeetingDecision(): FinalMeetingDecision | null {
    return this.finalMeetingDecision
      ? structuredClone(this.finalMeetingDecision)
      : null;
  }

  async acceptMeetingDelivery(
    deliveryId: string,
    contentHash: string,
  ): Promise<MeetingDelivery> {
    const delivery = await this.requireCurrentMeetingDelivery(deliveryId, contentHash);
    if (this.finalMeetingDecision) {
      if (
        this.finalMeetingDecision.kind === 'accept'
        && this.finalMeetingDecision.deliveryId === deliveryId
        && this.finalMeetingDecision.contentHash === contentHash
      ) return structuredClone(this.finalMeetingDelivery ?? delivery);
      throw new Error('final Meeting delivery already has a conflicting decision');
    }
    const intent = {
      schemaVersion: 1,
      deliveryId,
      contentHash,
      integrationHead: delivery.integrationHead,
      decidedAt: Date.now(),
    };
    await this.repository.append('meeting-delivery-accept-intent', intent);
    await this.repository.flush();
    const publication = await this.integrationQueue.publishFinalDelivery({
      deliveryId,
      contentHash,
      integrationHead: delivery.integrationHead,
      expectedUserBaseRevision: delivery.expectedUserBaseRevision,
    });
    const published = publishedMeetingDelivery(delivery);
    const decision: FinalMeetingDecision = {
      kind: 'accept',
      deliveryId,
      contentHash,
      integrationHead: publication.publishedHead,
      decidedAt: intent.decidedAt,
    };
    await this.repository.append('meeting-delivery-accepted', {
      schemaVersion: 1,
      delivery: published,
      decision,
      publication,
    });
    await this.repository.flush();
    this.finalMeetingDelivery = published;
    this.finalMeetingDecision = decision;
    this.safeEmit({
      source: 'system',
      event: {
        kind: 'meeting-delivery-updated',
        delivery: structuredClone(published),
        decision: structuredClone(decision),
      },
    });
    await this.snapshotActiveMeeting();
    await this.integrationQueue.cleanupPublishedIntegration(publication.publishedHead);
    return structuredClone(published);
  }

  requestMeetingDeliveryRework(deliveryId: string, contentHash: string, reason: string): Promise<{ planVersion: number; taskIds: string[] }> {
    return this.hostRuntime.mutatePlan(() => this.applyMeetingDeliveryRework(deliveryId, contentHash, reason));
  }

  private async applyMeetingDeliveryRework(
    deliveryId: string,
    contentHash: string,
    reason: string,
  ): Promise<{ planVersion: number; taskIds: string[] }> {
    const delivery = await this.requireCurrentMeetingDelivery(deliveryId, contentHash);
    const normalizedReason = reason.trim();
    if (!normalizedReason || normalizedReason.length > 20_000) {
      throw new Error('final Meeting rework reason must contain 1-20000 characters');
    }
    if (this.finalMeetingDecision) {
      if (
        this.finalMeetingDecision.kind === 'rework'
        && this.finalMeetingDecision.deliveryId === deliveryId
        && this.finalMeetingDecision.contentHash === contentHash
        && this.finalMeetingDecision.reason === normalizedReason
      ) {
        return {
          planVersion: this.finalMeetingDecision.planVersion,
          taskIds: [...this.finalMeetingDecision.taskIds],
        };
      }
      throw new Error('final Meeting delivery already has a conflicting decision');
    }
    await this.repository.append('meeting-delivery-rework-intent', {
      schemaVersion: 1,
      deliveryId,
      contentHash,
      integrationHead: delivery.integrationHead,
      reason: normalizedReason,
    });
    await this.repository.flush();
    const replacement = this.meetingScheduler.createFinalDeliveryRework(
      normalizedReason,
      contentHash,
    );
    const decision: FinalMeetingDecision = {
      kind: 'rework',
      deliveryId,
      contentHash,
      reason: normalizedReason,
      planVersion: replacement.planVersion,
      taskIds: [...replacement.taskIds],
      decidedAt: Date.now(),
    };
    await this.repository.append('meeting-delivery-rework-created', {
      schemaVersion: 1,
      decision,
      operations: replacement.taskIds.map((taskId, index) => ({
        kind: 'add-rework-task',
        taskId,
        supersedesTaskId: delivery.tasks[index]?.taskId,
        deliveryHash: contentHash,
        reason: normalizedReason,
      })),
    });
    await this.repository.flush();
    this.finalMeetingDecision = decision;
    this.safeEmit({
      source: 'system',
      event: {
        kind: 'meeting-delivery-updated',
        delivery: structuredClone(delivery),
        decision: structuredClone(decision),
      },
    });
    await this.snapshotActiveMeeting();
    return replacement;
  }

  private async buildFinalMeetingDelivery(): Promise<MeetingDelivery | null> {
    const tasks = this.meetingScheduler.snapshot();
    const integration = await this.integrationQueue.inspectState();
    if (
      this.finalMeetingDelivery
      && this.finalMeetingDelivery.planVersion === this.meetingScheduler.getPlanVersion()
      && this.finalMeetingDelivery.integrationHead === integration.durableHead
    ) return structuredClone(this.finalMeetingDelivery);

    const meetingChecks: Array<{ taskId: string; summary: string }> = [];
    try {
      for (const task of tasks) {
        if (task.status !== 'accepted') continue;
        const delivery = task.delivery;
        const candidate = delivery?.candidate;
        if (!delivery || !candidate) {
          throw new MeetingDeliveryNotReadyError([`${task.id}:missing accepted candidate`]);
        }
        const verification = await this.deliveryVerifier.verify({
          deliveryId: delivery.id,
          taskId: task.id,
          attempt: candidate.attempt,
          meetingId: this.meetingId,
          goal: delivery.spec.objective,
          acceptanceCriteria: structuredClone(delivery.spec.acceptanceCriteria),
          workspace: integration.workspace,
          sourceRevision: integration.durableHead,
        }, candidate.report);
        if (!verification.passed) {
          throw new MeetingDeliveryNotReadyError([
            `${task.id}:${verification.error ?? 'full Meeting verification failed'}`,
          ]);
        }
        const summaries = verification.checks.map((check) => {
          if (typeof check === 'string') return check;
          if (check && typeof check === 'object') {
            const record = check as Record<string, unknown>;
            return String(record.summary ?? record.description ?? record.status ?? 'passed');
          }
          return String(check);
        });
        meetingChecks.push({
          taskId: task.id,
          summary: summaries.join('; ') || 'verification passed on final integration head',
        });
      }
      const delivery = buildMeetingDelivery({
        meetingId: this.meetingId,
        planVersion: this.meetingScheduler.getPlanVersion(),
        tasks,
        integrationHead: integration.durableHead,
        expectedUserBaseRevision: this.expectedUserBaseRevision,
        meetingVerification: {
          integrationHead: integration.durableHead,
          checks: meetingChecks,
        },
      });
      await this.repository.append('meeting-delivery-ready', {
        schemaVersion: 1,
        delivery,
      });
      await this.repository.flush();
      this.finalMeetingDelivery = delivery;
      this.finalMeetingDecision = null;
      this.safeEmit({
        source: 'system',
        event: {
          kind: 'meeting-delivery-updated',
          delivery: structuredClone(delivery),
          decision: null,
        },
      });
      await this.snapshotActiveMeeting();
      return structuredClone(delivery);
    } catch (error) {
      if (error instanceof MeetingDeliveryNotReadyError) return null;
      throw error;
    }
  }

  private async requireCurrentMeetingDelivery(
    deliveryId: string,
    contentHash: string,
  ): Promise<MeetingDelivery> {
    if (
      !deliveryId
      || !/^[0-9a-f]{64}$/u.test(contentHash)
    ) throw new Error('final Meeting delivery identity is invalid');
    const delivery = await this.prepareFinalMeetingDelivery();
    if (
      !delivery
      || delivery.id !== deliveryId
      || delivery.contentHash !== contentHash
    ) throw new Error('final Meeting delivery is stale or no longer ready');
    return delivery;
  }

  private restoreFinalMeetingDelivery(events: PersistedMeetingEvent[]): void {
    this.finalMeetingDelivery = null;
    this.finalMeetingDecision = null;
    for (const event of events) {
      if (event.type === 'meeting-delivery-ready') {
        const record = objectRecord(event.payload);
        const delivery = parseMeetingDelivery(record.delivery);
        if (delivery) {
          this.finalMeetingDelivery = delivery;
          this.finalMeetingDecision = null;
        }
        continue;
      }
      if (event.type === 'meeting-delivery-accepted') {
        const record = objectRecord(event.payload);
        const delivery = parseMeetingDelivery(record.delivery);
        const decision = parseFinalMeetingDecision(record.decision);
        if (delivery && decision?.kind === 'accept') {
          this.finalMeetingDelivery = delivery;
          this.finalMeetingDecision = decision;
        }
        continue;
      }
      if (event.type === 'meeting-delivery-rework-created') {
        const decision = parseFinalMeetingDecision(objectRecord(event.payload).decision);
        if (decision?.kind === 'rework') this.finalMeetingDecision = decision;
      }
    }
  }

  private async reconcileInterruptedFinalAcceptance(
    events: PersistedMeetingEvent[],
  ): Promise<void> {
    if (!this.finalMeetingDelivery || this.finalMeetingDecision) return;
    const intentEvent = [...events].reverse().find(
      (event) => event.type === 'meeting-delivery-accept-intent',
    );
    if (!intentEvent || !intentEvent.payload || typeof intentEvent.payload !== 'object') return;
    const intent = intentEvent.payload as Record<string, unknown>;
    const queue = this.integrationQueue.snapshot();
    const request = queue.publicationRequest;
    const publication = queue.publication;
    const delivery = this.finalMeetingDelivery;
    if (
      queue.publicationState !== 'published'
      || !request
      || !publication
      || intent.deliveryId !== delivery.id
      || intent.contentHash !== delivery.contentHash
      || intent.integrationHead !== delivery.integrationHead
      || request.deliveryId !== delivery.id
      || request.contentHash !== delivery.contentHash
      || request.integrationHead !== delivery.integrationHead
      || request.expectedUserBaseRevision !== delivery.expectedUserBaseRevision
      || publication.expectedUserBaseRevision !== delivery.expectedUserBaseRevision
      || publication.integrationHead !== delivery.integrationHead
      || publication.publishedHead !== delivery.integrationHead
    ) return;
    const decidedAt = typeof intent.decidedAt === 'number' && Number.isFinite(intent.decidedAt)
      ? intent.decidedAt
      : intentEvent.ts;
    const published = publishedMeetingDelivery(delivery);
    const decision: FinalMeetingDecision = {
      kind: 'accept',
      deliveryId: delivery.id,
      contentHash: delivery.contentHash,
      integrationHead: publication.publishedHead,
      decidedAt,
    };
    await this.repository.append('meeting-delivery-accepted', {
      schemaVersion: 1,
      delivery: published,
      decision,
      publication,
      recoveredFromAcceptIntentSeq: intentEvent.seq,
    });
    await this.repository.flush();
    this.finalMeetingDelivery = published;
    this.finalMeetingDecision = decision;
    await this.snapshotActiveMeeting();
    await this.integrationQueue.cleanupPublishedIntegration(publication.publishedHead);
  }

  async acceptDelivery(deliveryId: string, candidateId: string) {
    const view = await this.meetingScheduler.acceptDelivery(deliveryId, candidateId);
    await this.repository.append('delivery-user-accepted', {
      deliveryId,
      candidateId,
      attempt: view.attempt,
    });
    await this.snapshotActiveMeeting();
    await this.repository.flush();
    return view;
  }

  async returnDelivery(
    deliveryId: string,
    candidateId: string | undefined,
    feedback: string,
  ) {
    const view = await this.meetingScheduler.returnDelivery(
      deliveryId,
      candidateId,
      feedback,
    );
    await this.repository.append('delivery-user-returned', {
      deliveryId,
      candidateId: candidateId ?? null,
      feedback,
      attempt: view.attempt,
    });
    await this.snapshotActiveMeeting();
    await this.repository.flush();
    return view;
  }

  inspectDeliveryReview(reviewId: string) {
    return safeCoordinatorReviewProjection(this.coordinatorReviewDriver.inspect(reviewId));
  }

  getDeliveryReviewChunk(reviewId: string, chunkId?: string) {
    const chunk = this.coordinatorReviewDriver.getChunk(reviewId, chunkId);
    if (!chunk) return null;
    if (chunk.requiresUserConfirmation) {
      const { content: _content, ...safe } = chunk;
      return safe;
    }
    return chunk;
  }

  async submitDeliveryChunkReview(
    reviewId: string,
    input: {
      chunkId: string;
      chunkHash: string;
      verdict: 'passed' | 'blocking';
      findings: CoordinatorReviewFinding[];
    },
  ) {
    const session = await this.coordinatorReviewDriver.submitChunkReview(reviewId, input);
    return safeCoordinatorReviewProjection(session);
  }

  async completeDeliveryReview(reviewId: string) {
    const session = await this.coordinatorReviewDriver.complete(reviewId);
    return safeCoordinatorReviewProjection(session);
  }

  async requestDeliveryRework(
    reviewId: string,
    findings: CoordinatorReviewFinding[],
    executorBackendId?: string,
  ) {
    // Record the one-shot backend override before the rework request lands:
    // the scheduler consumes it at the fresh-attempt boundary the rework
    // triggers. A silent drop would be worse than failing the tool call.
    if (executorBackendId?.trim()) {
      const target = this.coordinatorReviewDriver.inspect(reviewId);
      if (!target.taskId) {
        throw new Error(`review ${reviewId} has no bound task; cannot override its executor backend`);
      }
      const recorded = this.meetingScheduler.setNextAttemptBackend(target.taskId, nativeWorkerBackendId(executorBackendId));
      if (!recorded.ok) throw new Error(recorded.error);
    }
    const session = await this.coordinatorReviewDriver.requestRework(reviewId, findings);
    return safeCoordinatorReviewProjection(session);
  }

  async confirmDeliveryReviewEvidence(
    reviewId: string,
    input: { chunkId: string; chunkHash: string; decisionId: string },
  ) {
    const session = await this.coordinatorReviewDriver.confirmEvidence(reviewId, input);
    return safeCoordinatorReviewProjection(session);
  }

  submitWorkerReport(workerId: string, report: import('./worker-protocol.js').WorkReport, sourceAttempt?: number): void {
    this.meetingScheduler.submitWorkerReport(workerId, report, sourceAttempt);
  }

  confirmTerminalReport(workerId: string, summary: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.meetingScheduler.confirmTerminalReport(workerId, summary);
  }

  resumeTerminalInput(workerId: string): { ok: boolean } {
    return this.meetingScheduler.resumeTerminalInput(workerId);
  }

  /** Renderer confirm bar for terminal-mode workers: mark the running
   *  attempt failed with a user-provided reason. */
  failWorkerFromUser(workerId: string, message: string): { ok: true } | { ok: false; error: string } {
    return this.meetingScheduler.failWorkerFromUser(workerId, message);
  }

  // Test-only proxy: forward session events to the scheduler for simulation.
  schedulerOnWorkerEvent(workerId: string, e: SessionEvent): void {
    this.meetingScheduler.onWorkerEvent(
      workerId,
      e as unknown as import('./backends/cli-backend.js').BackendSessionEvent,
    );
  }

  submitWorkerDelivery(workerId: string, files: string[], sourceAttempt?: number): void {
    this.meetingScheduler.submitWorkerDelivery(workerId, files, sourceAttempt);
  }

  private notifyCoordinatorReview(briefing: CoordinatorReviewBriefing): void {
    if (this.closed) return;
    this.queuedReviews.set(briefing.reviewId, briefing);
    this.pumpReviewer();
  }

  private pumpReviewer() {
    if (this.closed) return;
    if (this.reviewer) {
      const reviewer = this.reviewer;
      const briefing = this.queuedReviews.get(reviewer.reviewId);
      if (!briefing || reviewer.busy || !reviewer.session) return;
      this.queuedReviews.delete(briefing.reviewId);
      reviewer.busy = true;
      const results = reviewer.results.splice(0);
      try {
        reviewer.session.sendUserText(
          `(coordinator review)\n${JSON.stringify(briefing)}`
          + (results.length ? `\n<meeting-command-results>\n${JSON.stringify(results)}\n</meeting-command-results>` : ''),
          'high',
        );
      } catch (error) {
        this.failReviewer(reviewer, error);
      }
      return;
    }
    const [briefing] = this.queuedReviews.values();
    if (!briefing) return;
    const reviewer: Reviewer = {
      reviewId: briefing.reviewId, busy: true, commands: Promise.resolve(), results: [], completedTurns: new Set(),
    };
    this.reviewer = reviewer;
    this.ensureReviewStallWatchdog();
    void this.startReviewer(reviewer, briefing).catch((error) => this.failReviewer(reviewer, error));
  }

  private async startReviewer(reviewer: Reviewer, briefing: CoordinatorReviewBriefing) {
    const backendId = this.coordinatorTalkerHost().backendId;
    if (backendId !== 'claude-code' && backendId !== 'codex') {
      throw new Error(`Reviewer tools are unavailable for backend '${backendId}'`);
    }
    const isCurrent = () => {
      if (this.closed || this.reviewer !== reviewer) return false;
      const review = this.coordinatorReviewDriver.inspect(reviewer.reviewId);
      return review.status === 'active' && review.taskId === briefing.taskId && review.attempt === briefing.attempt
        && review.candidate.diffHash === briefing.diffHash;
    };
    const cwd = path.join(this.repository.deliveryArtifactRoot(), 'review-runtime');
    await fsp.mkdir(cwd, { recursive: true, mode: 0o700 });
    if (!isCurrent()) return;
    const runCommand = (raw: unknown, portable: boolean) => {
      const result = reviewer.commands.then(async () => {
        const input = objectRecord(raw);
        const { commandId, ...command } = input;
        let result: MeetingCommandResult;
        try {
          const parsed = reviewCommandSchema.safeParse(command);
          if (!parsed.success) throw new Error('Invalid review command');
          if (!isCurrent() || parsed.data.reviewId !== briefing.reviewId) throw new Error('Reviewer session or candidate scope expired');
          const review = parsed.data;
          const value = await (() => {
            switch (review.kind) {
              case 'inspect_delivery_review': return this.inspectDeliveryReview(review.reviewId);
              case 'get_delivery_review_chunk': return this.getDeliveryReviewChunk(review.reviewId, review.chunkId);
              case 'submit_delivery_chunk_review': return this.submitDeliveryChunkReview(review.reviewId, review);
              case 'complete_delivery_review': return this.completeDeliveryReview(review.reviewId);
              case 'request_delivery_rework': return this.requestDeliveryRework(review.reviewId, review.findings, review.executorBackendId);
            }
          })();
          result = { ok: true, value };
        } catch (error) {
          result = { ok: false, code: 'execution-failed', error: error instanceof Error ? error.message : String(error) };
        }
        if (portable) reviewer.results.push({
          commandId: typeof commandId === 'string' && /^[\w.-]{1,128}$/.test(commandId) ? commandId : randomUUID(), result,
        });
        return result;
      });
      reviewer.commands = result.then(() => undefined, () => undefined);
      return result;
    };
    const factory = this.buildSessionFactory(backendId, 'reviewer', 'reviewer');
    const session = factory({
      cwd,
      autoApproveScope: 'off',
      envOverride: this.workerEnv,
      emit: (event) => {
        if (!isCurrent()) return;
        if (event.kind === 'ended' || event.kind === 'auth-required' || event.kind === 'error') {
          this.failReviewer(reviewer, event.kind === 'ended' ? 'Reviewer session ended' : event.error);
          return;
        }
        if ((event.kind === 'turn-status' && event.status === 'completed')
          || (event.kind === 'message' && event.message.type === 'result')) {
          const rawTurnId = event.kind === 'turn-status' ? event.turnId : event.message.uuid;
          const turnId = typeof rawTurnId === 'string' ? rawTurnId : undefined;
          if (turnId && reviewer.completedTurns.has(turnId)) return;
          if (!reviewer.busy || reviewer.finishing) return;
          if (turnId) reviewer.completedTurns.add(turnId);
          // Keep the generation busy until command results and the next
          // briefing are ready. Multiple provider completion events coalesce.
          reviewer.finishing = true;
          setImmediate(() => {
            if (!isCurrent()) return;
            void this.finishReviewerTurn(reviewer).catch((error) => this.failReviewer(reviewer, error));
          });
        }
      },
      sessionOptions: {
        systemPrompt: REVIEWER_PROMPT
          + (backendId === 'codex' ? '\n使用单个 ```meeting-command JSON 围栏提交命令。字段为 kind、commandId、reviewId，取证时可加 chunkId。结论使用 submit_delivery_chunk_review，字段为 chunkId、chunkHash、verdict（passed 或 blocking）、findings 数组。其他 kind 为 inspect_delivery_review、get_delivery_review_chunk、complete_delivery_review、request_delivery_rework。下一轮读取对应 commandId 的结果。' : ''),
        tools: [],
        mcpServers: { meeting: buildTalkerMcp(this, isCurrent, 'reviewer', isCurrent, briefing.reviewId, (raw) => runCommand(raw, false)) },
        skills: [],
        settingSources: [],
        // Portable protocol errors travel as structured results instead of
        // being mistaken for an app-server turn failure.
        meetingCommandHandler: (raw: unknown) => runCommand(raw, true).then(() => ({ ok: true })),
      },
    });
    reviewer.session = session;
    await session.start();
    if (!isCurrent()) return;
    reviewer.busy = false;
    this.pumpReviewer();
  }

  private async finishReviewerTurn(reviewer: Reviewer) {
    await reviewer.commands;
    if (this.closed || this.reviewer !== reviewer) return;
    await this.coordinatorReviewDriver.onCoordinatorTurnEnded(reviewer.reviewId);
    if (this.reviewer === reviewer) {
      reviewer.finishing = false;
      reviewer.busy = false;
      this.pumpReviewer();
    }
  }

  private failReviewer(reviewer: Reviewer, error: unknown) {
    if (this.closed || this.reviewer !== reviewer) return;
    this.diagnostics.log('reviewer-failed', { reviewId: reviewer.reviewId, error: String(error) });
    void this.coordinatorReviewDriver.pauseForDisconnect(reviewer.reviewId, 'user-required').catch((failure) => {
      this.releaseReviewer(reviewer.reviewId);
      this.diagnostics.log('reviewer-pause-failed', { error: String(failure) });
    });
  }

  private releaseReviewer(reviewId: string) {
    this.queuedReviews.delete(reviewId);
    if (this.reviewer?.reviewId === reviewId) {
      const session = this.reviewer.session;
      this.reviewer = undefined;
      try {
        session?.end();
      } catch (error) {
        this.diagnostics.log('reviewer-cleanup-failed', { reviewId, error: String(error) });
      }
    }
    this.pumpReviewer();
  }

  /** A silent Coordinator never emits a turn boundary, so time also charges the budget. */
  private ensureReviewStallWatchdog(): void {
    if (this.reviewStallTimer || this.reviewStallTimeoutMs <= 0) return;
    const timer = setInterval(
      () => { void this.sweepStalledReviews(); },
      Math.max(1_000, Math.floor(this.reviewStallTimeoutMs / 2)),
    );
    timer.unref?.();
    this.reviewStallTimer = timer;
  }

  private stopReviewStallWatchdog(): void {
    if (!this.reviewStallTimer) return;
    clearInterval(this.reviewStallTimer);
    this.reviewStallTimer = null;
  }

  private async sweepStalledReviews(): Promise<void> {
    const active = this.closed || !this.reviewer
      ? [] : this.coordinatorReviewDriver.activeSessions().filter((session) => session.id === this.reviewer?.reviewId);
    if (active.length === 0) {
      this.stopReviewStallWatchdog();
      return;
    }
    const deadline = Date.now() - this.reviewStallTimeoutMs;
    for (const session of active) {
      if (session.updatedAt > deadline) continue;
      try {
        await this.coordinatorReviewDriver.pauseForDisconnect(session.id, 'user-required');
      } catch (err) {
        this.diagnostics.log('coordinator-review-stall-sweep-failed', {
          reviewId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * A paused review is never an implicit pass. Surface it to the user and tell
   * the Coordinator to hand the decision over instead of guessing.
   */
  private async escalateStalledReview(session: CoordinatorReviewSession): Promise<void> {
    const uncoveredChunkIds = listUncoveredCoordinatorReviewChunkIds(session);
    const remainingChunks = session.coverage.totalChunks - session.coverage.reviewedChunks;
    this.safeEmit({
      source: 'system',
      event: {
        kind: 'coordinator-review-stalled',
        reviewId: session.id,
        deliveryId: session.deliveryId,
        ...(session.taskId ? { taskId: session.taskId } : {}),
        reason: session.pauseReason ?? 'user-required',
        uncoveredChunkIds,
        remainingChunks,
      },
    });
    if (session.pauseReason === 'coordinator-disconnected') return;
    this.hostGroups.get(this.coordinatorHostId)?.getHost()?.sendUserText(
      `(coordinator review paused) 审查 ${session.id} 因为 ${session.pauseReason ?? 'user-required'} 已暂停，还有 ${remainingChunks} 个分片没有覆盖：${uncoveredChunkIds.join(', ') || 'none'}。请直接告诉用户审查没走完、卡在哪里，并让用户决定是继续审查还是自己接手。不要声称交付已通过。`,
      'normal',
    );
  }

  /** Resume a paused review. Exposed so the user can restart a stalled Coordinator. */
  async resumeDeliveryReview(reviewId: string) {
    const session = await this.coordinatorReviewDriver.resume(reviewId);
    return safeCoordinatorReviewProjection(session);
  }

  /** After the Coordinator comes back, reviews parked on disconnect resume themselves. */
  private resumeDisconnectedReviews(): void {
    if (this.closed) return;
    if (!this.hostGroups.get(this.coordinatorHostId)?.getHost()) return;
    for (const session of this.coordinatorReviewDriver.pausedSessions()) {
      if (session.pauseReason !== 'coordinator-disconnected') continue;
      void this.coordinatorReviewDriver.resume(session.id).catch((err) => {
        this.diagnostics.log('coordinator-review-resume-failed', {
          reviewId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  // ===========================================================================

  /**
   * Called from DecisionWatcher when the user fills in "✅ 确认结论". Pushes a
   * synthetic system message into the default host's talker so the model can
   * re-evaluate, and surfaces an activity entry to the renderer.
   */
  private onDecisionResolved(r: ResolvedDecision): void {
    if (this.closed) return;
    const meta = this.decisionMeta.get(r.id);
    const question = meta?.question ?? '';
    this.safeEmit({
      source: 'talker',
      event: {
        kind: 'decision-resolved',
        decisionId: r.id,
        question,
        path: r.path,
        conclusion: r.conclusion,
      },
    });
    const condensed = r.conclusion.length > 400 ? `${r.conclusion.slice(0, 398)}…` : r.conclusion;
    this.resolvedDecisionContext.set(r.id, {
      id: r.id,
      summary: question ? `${question}: ${condensed}` : condensed,
    });
    this.defaultHost().getHost()?.sendUserText(
      `(decision update) 用户对"${question}"给出了结论：${condensed}\n\n如果这跟你之前推进的方向不一致，请马上调整：可以 delegate_to 现有 worker 让他改，或开新 worker 走另一条路；并简短告诉用户你怎么调整。`,
      'normal',
    );
    this.decisionMeta.delete(r.id);
    this.decisions.unwatch(r.path);

    // Cross-host notification: if other hosts exist, tell them about the decision.
    if (this.hostGroups.size > 1) {
      this.crossHostBus.publish({
        from: DEFAULT_HOST_ID,
        to: '*',
        text: `Decision resolved: "${question}" → ${condensed}`,
        meta: { kind: 'decision-resolved', payload: { decisionId: r.id, question, conclusion: condensed } },
      });
    }
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseFinalMeetingDecision(value: unknown): FinalMeetingDecision | null {
  const record = objectRecord(value);
  const common = (
    typeof record.deliveryId === 'string'
    && typeof record.contentHash === 'string'
    && /^[0-9a-f]{64}$/u.test(record.contentHash)
    && typeof record.decidedAt === 'number'
    && Number.isFinite(record.decidedAt)
  );
  if (!common) return null;
  if (
    record.kind === 'accept'
    && typeof record.integrationHead === 'string'
    && /^[0-9a-f]{40,64}$/u.test(record.integrationHead)
  ) return structuredClone(record as unknown as FinalMeetingDecision);
  if (
    record.kind === 'rework'
    && typeof record.reason === 'string'
    && record.reason.trim().length > 0
    && record.reason.length <= 20_000
    && typeof record.planVersion === 'number'
    && Number.isSafeInteger(record.planVersion)
    && Array.isArray(record.taskIds)
    && record.taskIds.every((entry) => typeof entry === 'string')
  ) return structuredClone(record as unknown as FinalMeetingDecision);
  return null;
}
