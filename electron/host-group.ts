// HostGroup owns one Host session. Worker execution belongs to the meeting.

import type { SessionEvent } from './claude-session.js';
import type { BackendSession } from './backends/cli-backend.js';
import type { AutoApproveScope } from './auto-approve-policy.js';
import { buildTalkerMcp, type OrchestratorBridge } from './meeting-mcp.js';
import type { SessionFactory } from './worker-scheduler.js';
import {
  TALKER_PROMPT,
  COORDINATOR_ROLE_PROMPT,
  EXPERT_ROLE_PROMPT,
  REPORT_MODE_SUFFIX,
} from './orchestrator-prompts.js';
import {
  formatForPrompt,
  selectRelevant,
} from './memory.js';
import { getSettings } from './store.js';
import {
  MEMORY_TOKEN_BUDGET,
  TALKER_TRANSCRIPT_MAX_ENTRIES,
  extractText,
} from './orchestrator-helpers.js';
import type {
  OrchestratorEvent,
  TalkerTurn,
} from './orchestrator-types.js';
import type { SDKMessage, SDKUserMessage } from './claude-cli/types.js';

export interface HostGroupOpts {
  /** Unique identifier for this host group. Default = 'default'. */
  id: string;
  /** Backend identifier (e.g. 'claude-code', 'codex', 'kimi', 'qoder'). */
  backendId: string;
  /** Emit channel — should be the orchestrator's safeEmit wrapper. */
  emit: (e: OrchestratorEvent) => void;
  /** Shared workspace cwd. */
  cwd: string;
  /** Project ID for memory lookups. */
  projectId: string;
  autoApproveScope: AutoApproveScope;
  workerEnv?: NodeJS.ProcessEnv;
  talkerModel?: string;
  confirmDestructive?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
  sessionFactory: SessionFactory;
  /** Bridge to the orchestrator for MCP tool callbacks. */
  bridge: OrchestratorBridge;
  /** Reports orchestrator shutdown. */
  isClosed: () => boolean;
  isCoordinator: () => boolean;
  coordinatorPrompt?: () => boolean;
}

export class HostGroup {
  readonly id: string;
  readonly backendId: string;

  private host: BackendSession | null = null;
  private ready = false;
  // A newly registered group is pending even before start() reaches the
  // backend factory (meeting initialization and memory reads can await).
  private lifecycle: 'starting' | 'ready' | 'ended' | 'failed' = 'starting';
  private lifecycleError: string | undefined;
  private generation = 0;
  private starting: Promise<void> | null = null;
  private turnActive = false;
  private emit: (e: OrchestratorEvent) => void;
  private cwd: string;
  private projectId: string;
  private autoApproveScope: AutoApproveScope;
  private workerEnv: NodeJS.ProcessEnv | undefined;
  private talkerModel: string | undefined;
  private confirmDestructive: ((toolName: string, input: Record<string, unknown>) => Promise<boolean>) | undefined;
  private sessionFactory: SessionFactory;
  private bridge: OrchestratorBridge;
  private isClosed: () => boolean;
  private isCoordinator: () => boolean;
  private coordinatorPrompt: () => boolean;
  private readonly completedTurns = new Set<string>();

  /** Talker transcript for recap. Accumulates user+assistant text turns. */
  private talkerTranscript: TalkerTurn[] = [];
  private talkerTurnSeq = 0;

  constructor(opts: HostGroupOpts) {
    this.id = opts.id;
    this.backendId = opts.backendId;
    this.emit = opts.emit;
    this.cwd = opts.cwd;
    this.projectId = opts.projectId;
    this.autoApproveScope = opts.autoApproveScope;
    this.workerEnv = opts.workerEnv;
    this.talkerModel = opts.talkerModel;
    this.confirmDestructive = opts.confirmDestructive;
    this.sessionFactory = opts.sessionFactory;
    this.bridge = opts.bridge;
    this.isClosed = opts.isClosed;
    this.isCoordinator = opts.isCoordinator;
    this.coordinatorPrompt = opts.coordinatorPrompt ?? opts.isCoordinator;
  }

  getHost(): BackendSession | null {
    return this.host;
  }

  isReady(): boolean {
    return this.ready && this.host !== null;
  }

  getLifecycle(): { phase: 'starting' | 'ready' | 'ended' | 'failed'; error?: string } {
    return { phase: this.lifecycle, ...(this.lifecycleError ? { error: this.lifecycleError } : {}) };
  }

  getTranscript(): TalkerTurn[] {
    return [...this.talkerTranscript];
  }

  setAutoApproveScope(scope: AutoApproveScope) {
    this.autoApproveScope = scope;
    this.host?.setAutoApproveScope?.(scope);
  }

  start(greeting?: string): Promise<void> {
    if (this.isClosed()) return Promise.reject(new Error('meeting is closed'));
    if (this.starting) return this.starting;
    if (this.isReady()) return Promise.resolve();
    const generation = ++this.generation;
    this.lifecycle = 'starting';
    this.lifecycleError = undefined;
    const starting = this.startHost(generation, greeting).catch((error: unknown) => {
      if (this.isCurrent(generation)) {
        const host = this.invalidate('failed', error instanceof Error ? error.message : String(error));
        host?.end();
      }
      throw error;
    }).finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && !this.isClosed();
  }

  private invalidate(phase: 'ended' | 'failed', error?: string): BackendSession | null {
    const host = this.host;
    ++this.generation;
    this.starting = null;
    this.host = null;
    this.ready = false;
    this.turnActive = false;
    this.completedTurns.clear();
    this.lifecycle = phase;
    this.lifecycleError = error;
    return host;
  }

  private async startHost(generation: number, greeting?: string) {
    this.ready = false;
    const isCurrent = () => this.isCurrent(generation);
    const meetingMcp = buildTalkerMcp(this.bridge, this.isCoordinator, this.id, isCurrent);

    const rolePrompt = this.coordinatorPrompt()
      ? COORDINATOR_ROLE_PROMPT
      : EXPERT_ROLE_PROMPT;
    let systemPrompt: string = TALKER_PROMPT + rolePrompt;
    try {
      const memoryEntries = await selectRelevant(this.projectId, {
        tokenBudget: MEMORY_TOKEN_BUDGET,
      });
      const memoryBlock = formatForPrompt(memoryEntries);
      if (memoryBlock) {
        systemPrompt = `## 历史记忆 (从过往会议沉淀)\n\n${memoryBlock}\n\n---\n\n${TALKER_PROMPT}${rolePrompt}`;
      }
    } catch (err) {
      console.warn('[host-group] failed to load memory for system prompt:', err);
    }

    // Append report-mode instructions when the user enabled 汇报模式. The
    // talker's save_document tool is always available (no cost when unused),
    // but the prompt suffix is what makes it actually use the tool for long
    // responses instead of reading everything aloud.
    if (getSettings().reportModeEnabled) {
      systemPrompt += '\n' + REPORT_MODE_SUFFIX;
    }

    if (!isCurrent()) throw new Error('Host startup was cancelled');
    const host = this.sessionFactory({
      cwd: this.cwd,
      autoApproveScope: this.autoApproveScope,
      envOverride: this.workerEnv,
      confirmDestructive: this.confirmDestructive,
      emit: (e) => { if (isCurrent()) this.onHostEvent(e); },
      sessionOptions: {
        isCurrentHostSession: isCurrent,
        systemPrompt,
        tools: [],
        mcpServers: { meeting: meetingMcp },
        skills: [],
        settingSources: [],
        model: this.talkerModel ?? 'claude-haiku-4-5',
        includePartialMessages: true,
      },
    });

    if (!isCurrent()) {
      host.end();
      throw new Error('Host startup was cancelled');
    }
    this.host = host;
    await host.start();

    // The session may have been torn down while its handshake promise was
    // settling. A missing host is a failed readiness transition, never Ready.
    if (!isCurrent() || this.host !== host) {
      throw new Error(`backend '${this.backendId}' ended before readiness`);
    }
    this.lifecycle = 'ready';
    this.ready = true;
    if (greeting) host.sendUserText(greeting, 'normal');
  }

  sendUserText(text: string) {
    this.host?.sendUserText(text, 'high');
  }

  sendUserImage(content: SDKUserMessage['message']['content']) {
    this.host?.sendUserContent(
      content as string | import('./backends/cli-backend.js').UserContentBlock[],
      'high',
    );
  }

  resolvePermission(
    id: string,
    decision: 'allow' | 'deny',
    message?: string,
  ) {
    this.host?.resolvePermission(id, decision, message);
  }

  async interrupt() {
    await this.host?.interrupt();
  }

  async setPermissionMode(mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan') {
    await this.host?.setPermissionMode?.(mode);
  }

  /** Tear down only the Host session. */
  async end(): Promise<void> {
    this.invalidate('ended')?.end();
  }

  /** Returns true if the host session died unexpectedly (not from our end()). */
  isHostAlive(): boolean {
    return this.host !== null;
  }

  private onHostEvent(e: SessionEvent) {
    if (e.kind === 'native-launch-phase') return;
    // Terminal adapters originated as worker-only backends and report process
    // failures through WorkerAdapterSignal. A host cannot forward that private
    // protocol to the renderer: normalize it into the public host lifecycle so
    // errors are visible and the responding indicator always closes.
    if (e.kind === 'worker-signal') {
      if (e.signal.kind === 'failed') {
        this.emit({ source: 'talker', event: { kind: 'error', error: e.signal.message } });
        this.turnActive = false;
        this.emit({ source: 'talker', event: { kind: 'turn-status', status: 'completed' } });
      } else if (e.signal.kind === 'ended') {
        this.onHostEvent({ kind: 'ended' });
      }
      return;
    }
    if (e.kind === 'auth-required') {
      // Authentication failure is an intentional circuit-breaker, not a
      // subprocess crash. Stop routing new turns and preserve existing workers.
      this.invalidate('failed', e.error)?.end();
      this.emit({ source: 'talker', event: e });
      return;
    }
    if (e.kind === 'turn-status') {
      this.updateTurn(e.status, e.turnId);
      return;
    }
    if (e.kind === 'ended') this.invalidate('ended');
    this.emit({ source: 'talker', event: e });

    if (e.kind === 'ended' && !this.isClosed()) {
      this.emit({
        source: 'talker',
        event: {
          kind: 'message',
          message: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{
                type: 'text',
                text: `（Host [${this.id}] 进程意外退出，该主持的会议部分自动结束。）`,
              }],
            },
            parent_tool_use_id: null,
            session_id: `host-group-${this.id}-exit`,
          } as unknown as SDKMessage,
        },
      });
      return;
    }

    if (e.kind === 'message') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg: any = e.message;
      const t = msg?.type;
      if (t === 'assistant') {
        this.updateTurn('started');
        const text = extractText(msg);
        if (text) this.appendTurn({ role: 'assistant', text });
      } else if (t === 'user') {
        const text = extractText(msg);
        if (text) this.appendTurn({ role: 'user', text });
      } else if (t === 'result') {
        this.updateTurn('completed');
      }
    }
  }

  private updateTurn(status: 'started' | 'completed', turnId?: string) {
    if (turnId && this.completedTurns.has(turnId)) return;
    if (turnId && status === 'completed') {
      this.completedTurns.add(turnId);
      if (this.completedTurns.size > 128) this.completedTurns.delete(this.completedTurns.values().next().value!);
    }
    const active = status === 'started';
    if (this.turnActive === active) return;
    this.turnActive = active;
    this.emit({ source: 'talker', event: { kind: 'turn-status', status, turnId } });
  }

  private appendTurn(turn: Pick<TalkerTurn, 'role' | 'text'>) {
    this.talkerTurnSeq += 1;
    this.talkerTranscript = [...this.talkerTranscript, {
      ...turn,
      id: `${this.id}:turn:${this.talkerTurnSeq}`,
      timestamp: Date.now(),
    }].slice(
      -TALKER_TRANSCRIPT_MAX_ENTRIES,
    );
  }
}
