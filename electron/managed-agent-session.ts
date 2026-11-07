import type { AutoApproveScope } from './auto-approve-policy.js';
import type {
  BackendSession, BackendSessionConfig, BackendSessionEvent, BackendSessionSnapshot,
  CliBackend, InputPriority, UserContentBlock,
} from './backends/cli-backend.js';
import { AgentResourcePool, getAgentResourcePool, type AgentLease } from './agent-resource-pool.js';

/** Keep the logical meeting session while an idle native runtime is absent.
 * Reclamation is deliberately opt-in: only host protocols with an authoritative
 * turn boundary and native resume are eligible. TUI silence is never idleness. */
export class ManagedAgentSession implements BackendSession {
  private inner?: BackendSession;
  private lease?: AgentLease;
  private starting?: Promise<void>;
  private abort = new AbortController();
  private cancelling?: Promise<void>;
  private inputEpoch = 0;
  private waitStartedAt?: number;
  private readonly waitHistory: Array<{ start: number; end: number }> = [];
  private prunedWaitEnd = 0;
  private closed = false;
  private generation = 0;
  private checkpoint: BackendSessionSnapshot | null = null;
  private pendingTurns = 0;
  private sentInput = false;
  private completedTurn = false;
  private uncertain = false;
  private readonly permissions = new Set<string>();
  private nativeConfirmations = 0;
  private operations = 0;
  private idleSince = 0;
  private permissionMode?: string;
  private waiting = false;

  constructor(
    private readonly backend: Pick<CliBackend, 'id' | 'createSession'>,
    private readonly config: BackendSessionConfig,
    private readonly emit: (event: BackendSessionEvent) => void,
    private readonly pool: AgentResourcePool = getAgentResourcePool(),
    private readonly now: () => number = Date.now,
  ) {}

  isWaitingForResources(): boolean { return this.waiting || Boolean(this.cancelling); }

  resourceWaitTimeSince(timestamp: number): number {
    // Bound history. A very old watchdog conservatively receives credit for
    // the pruned prefix rather than being charged for unobservable wait time.
    let waited = Math.max(0, this.prunedWaitEnd - timestamp);
    for (const interval of this.waitHistory) {
      waited += Math.max(0, interval.end - Math.max(timestamp, interval.start));
    }
    if (this.waitStartedAt !== undefined) {
      waited += Math.max(0, this.now() - Math.max(timestamp, this.waitStartedAt));
    }
    return waited;
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Agent session closed'));
    if (this.cancelling) return this.cancelling.then(() => this.start());
    if (this.starting) return this.starting;
    if (this.inner) return Promise.resolve();
    this.starting = this.startRuntime().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async startRuntime(): Promise<void> {
    this.waiting = true;
    this.waitStartedAt = this.now();
    const admission = this.abort;
    let lease: AgentLease;
    try {
      lease = await this.pool.acquire(this.backend.id, this.config.executionRole ?? 'host', admission.signal);
    } catch (error) {
      // Cancellation is a settled lifecycle transition, not a failed Host.
      if (this.closed || admission.signal.aborted) return;
      throw error;
    } finally {
      const end = this.now();
      if (end > this.waitStartedAt) {
        this.waitHistory.push({ start: this.waitStartedAt, end });
        if (this.waitHistory.length > 256) this.prunedWaitEnd = this.waitHistory.shift()!.end;
      }
      this.waitStartedAt = undefined;
      this.waiting = false;
    }
    if (this.closed || admission.signal.aborted) {
      this.pool.retire(lease);
      return;
    }
    this.lease = lease;
    const generation = ++this.generation;
    let inner: BackendSession | undefined;
    try {
      inner = lease.scope.run(() => this.backend.createSession({
        ...this.config,
        resumeSessionId: this.checkpoint?.sessionId ?? this.config.resumeSessionId,
        confirmDestructive: this.config.confirmDestructive ? async (name, input) => {
          this.nativeConfirmations += 1;
          try { return await this.config.confirmDestructive!(name, input); }
          finally { this.nativeConfirmations -= 1; this.idleSince = this.now(); }
        } : undefined,
      }, (event) => {
        if (this.closed || generation !== this.generation) return;
        this.onEvent(event);
      }));
      this.inner = inner;
      await lease.scope.run(() => inner!.start());
      if (this.closed || generation !== this.generation) {
        lease.scope.run(() => inner!.end());
        this.pool.retire(lease);
        return;
      }
      if (this.permissionMode !== undefined) {
        await lease.scope.run(() => inner!.setPermissionMode?.(this.permissionMode!) ?? Promise.resolve());
      }
      if (this.closed || generation !== this.generation) {
        lease.scope.run(() => inner!.end());
        this.pool.retire(lease);
        return;
      }
      this.checkpoint = inner.snapshot?.() ?? this.checkpoint;
      this.idleSince = this.now();
      lease.reclaim = () => this.reclaimIdle();
    } catch (error) {
      if (generation === this.generation) {
        this.generation += 1;
        this.inner = undefined;
        this.lease = undefined;
      }
      try { lease.scope.run(() => inner?.end()); }
      finally { this.pool.retire(lease); }
      if (this.closed || admission.signal.aborted) return;
      throw error;
    }
  }

  private onEvent(event: BackendSessionEvent): void {
    this.idleSince = this.now();
    if (event.kind === 'permission-request') this.permissions.add(event.id);
    if (event.kind === 'permission-cancelled') this.permissions.delete(event.id);
    if (event.kind === 'error' || event.kind === 'auth-required') this.uncertain = true;
    if (event.kind === 'turn-status' && event.status === 'started') {
      // Unsolicited native activity must also protect the session.
      this.completedTurn = false;
      if (this.pendingTurns === 0) this.pendingTurns = 1;
    }
    if ((event.kind === 'message' && event.message.type === 'result')
      || (event.kind === 'turn-status' && event.status === 'completed')) {
      this.pendingTurns = Math.max(0, this.pendingTurns - 1);
      this.completedTurn = true;
    }
    // A generic ended is a runtime failure, unlike worker-signal ended which
    // some adapters use for a completed turn. Let the existing owner handle it.
    try { this.emit(event); }
    finally {
      if (event.kind === 'ended'
        || (this.config.executionRole !== 'worker' && event.kind === 'worker-signal' && event.signal.kind === 'ended')) {
        this.end();
      }
    }
  }

  private reclaimIdle(): boolean {
    if (this.closed || this.starting || !this.inner || !this.lease) return false;
    if (this.config.executionRole === 'worker') return false;
    if (this.backend.id !== 'claude-code' && this.backend.id !== 'codex') return false;
    if (this.backend.id === 'codex' && this.config.extra?.codexTransport !== 'app-server') return false;
    if (this.pendingTurns || this.permissions.size || this.nativeConfirmations || this.operations || this.uncertain) return false;
    if (this.sentInput && !this.completedTurn) return false;
    if (this.now() - this.idleSince < this.pool.idleTimeoutMs) return false;
    const checkpoint = this.inner.snapshot?.();
    // A never-used host can be recreated from its original config. Once user
    // input exists, absence of a durable native handle means no reclamation.
    if (this.sentInput && !checkpoint?.sessionId) return false;
    this.checkpoint = checkpoint ?? this.checkpoint;
    const inner = this.inner;
    const lease = this.lease;
    this.inner = undefined;
    this.lease = undefined;
    this.generation += 1; // Suppress late ended/results from the retired runtime.
    try { lease.scope.run(() => inner.end()); }
    catch { console.warn('[agent-resources] idle runtime did not close cleanly; retaining its drain lease'); }
    finally { this.pool.retire(lease); }
    return true;
  }

  private send(deliver: (session: BackendSession) => void): void {
    if (this.closed) return;
    const epoch = this.inputEpoch;
    this.sentInput = true;
    this.pendingTurns += 1; // Count queued input before any asynchronous admission.
    this.completedTurn = false;
    this.idleSince = this.now();
    if (this.inner && !this.starting && this.lease) {
      try { this.lease.scope.run(() => deliver(this.inner!)); }
      catch (error) { this.fail(error); }
      return;
    }
    void this.start().then(() => {
      if (!this.closed && epoch === this.inputEpoch && this.inner && this.lease) {
        this.lease.scope.run(() => deliver(this.inner!));
      }
    }).catch((error) => {
      if (epoch === this.inputEpoch) this.fail(error);
    });
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.end();
    this.emit({ kind: 'error', error: `Agent runtime: ${error instanceof Error ? error.message : String(error)}` });
    this.emit({ kind: 'ended' });
  }

  sendUserText(text: string, priority?: InputPriority): void {
    if (text) this.send((inner) => inner.sendUserText(text, priority));
  }

  sendUserContent(content: string | UserContentBlock[], priority?: InputPriority): void {
    if (content.length) this.send((inner) => inner.sendUserContent(content, priority));
  }

  resolvePermission(id: string, decision: 'allow' | 'deny', message?: string): void {
    this.permissions.delete(id);
    this.idleSince = this.now();
    this.lease?.scope.run(() => this.inner?.resolvePermission(id, decision, message));
  }

  async interrupt(reason?: 'steer' | 'user' | 'shutdown'): Promise<void> {
    // No runtime has received input while waiting for admission. Cancel rather
    // than letting that queued input execute after an explicit stop.
    if (this.cancelling) return this.cancelling;
    if (this.waiting || (this.starting && !this.inner)) {
      if (this.config.executionRole === 'worker' && reason !== 'steer') {
        const starting = this.starting;
        this.end();
        this.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'interrupted' } });
        await starting;
        return;
      }
      this.inputEpoch += 1;
      this.pendingTurns = 0;
      this.sentInput = false;
      this.completedTurn = false;
      this.abort.abort();
      // Join the old start before admitting any new input. Only this batch is
      // cancelled; HostGroup still owns a usable logical session afterwards.
      this.cancelling = Promise.resolve(this.starting).finally(() => {
        if (!this.closed) this.abort = new AbortController();
        this.cancelling = undefined;
      });
      return this.cancelling;
    }
    this.operations += 1;
    this.uncertain = true; // Interrupted turns are not safe idle checkpoints.
    try { await this.lease?.scope.run(() => this.inner?.interrupt(reason)); }
    finally { this.operations -= 1; this.idleSince = this.now(); }
  }

  setAutoApproveScope(scope: AutoApproveScope): void {
    this.config.autoApproveScope = scope;
    this.lease?.scope.run(() => this.inner?.setAutoApproveScope?.(scope));
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.permissionMode = mode;
    this.operations += 1;
    try { await this.lease?.scope.run(() => this.inner?.setPermissionMode?.(mode)); }
    finally { this.operations -= 1; this.idleSince = this.now(); }
  }

  snapshot(): BackendSessionSnapshot | null {
    return this.inner?.snapshot?.() ?? this.checkpoint;
  }

  resumePendingInput(): boolean { return this.inner?.resumePendingInput?.() ?? false; }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.generation += 1;
    const inner = this.inner;
    const lease = this.lease;
    this.checkpoint = inner?.snapshot?.() ?? this.checkpoint;
    this.inner = undefined;
    this.lease = undefined;
    try { lease?.scope.run(() => inner?.end()); }
    finally {
      // startRuntime owns retirement during a handshake: it may still spawn
      // after an await. Do not return that lease before start has settled.
      if (lease && !this.starting) this.pool.retire(lease);
    }
  }
}

export function createManagedAgentSession(
  backend: Pick<CliBackend, 'id' | 'createSession'>,
  config: BackendSessionConfig,
  emit: (event: BackendSessionEvent) => void,
): BackendSession {
  // Remote work consumes neither a local runtime lease nor a local PID budget.
  return backend.id === 'pocket-vibe'
    ? backend.createSession(config, emit)
    : new ManagedAgentSession(backend, config, emit);
}
