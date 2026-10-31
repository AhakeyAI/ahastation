import { createHash, randomUUID } from 'node:crypto';
import { commandApprovalRisk, normalizeBackendPermissionRequest } from '../backends/canonical-execution.js';
import { evaluateTaskAuthority, isTaskAuthorityCurrent } from '../task-authority.js';
import type { TaskAuthorityGrant } from '../task-collaboration.js';
import { workReportSchema, type WorkReport } from '../worker-protocol.js';
import { WorkerOwnershipService, type ProcessIdentity, type WorkerBinding, type WorkerLaunch } from './ownership.js';

export interface RunBasis {
  hostEpoch: string; runtimeId: string; taskId: string; attemptId: string;
  credentialRef: string; authorityEpoch: number; controlEpoch: number;
}
export interface NativeToolCall {
  invocationId: string; stage: 'PreToolUse' | 'PermissionRequest';
  sessionId: string; toolName: string; input: Record<string, unknown>;
}
export interface ExecutionPermit { id: string; digest: string; basis: RunBasis; expiresAt: number }
export interface NativeExecutionGuard {
  /** Trusted adapter must launch into confinement before any CLI instruction.
   * A normal PTY, hook, env token or post-hoc hash monitor is insufficient. */
  spawn(): Promise<ProcessIdentity>;
  /** Must verify the protected IPC peer against the actual owned tree, current
   * OS start/boot identity AND restricted credential. Caller data is no proof. */
  verifyPeer(peer: unknown, process: ProcessIdentity, binding: WorkerBinding): boolean;
  /** Separate writer capability, not a public basis/controlEpoch string. */
  verifyWriter(lease: unknown, writer: 'host' | 'human', basis: RunBasis): boolean;
  write(data: string, writer: 'host' | 'human'): boolean;
  seal(): void;
  interrupt(): Promise<void>;
  terminateTree(): Promise<{ confirmed: boolean }>;
  /** Must be OS/guardian tree evidence, never root-exit/EOF/hook Stop. */
  verifyTreeExit(evidence: unknown, process: ProcessIdentity): boolean;
}
export interface NativeRunOptions {
  binding: WorkerBinding; attempt: number; workspaceRoot: string;
  ownership: WorkerOwnershipService; guard: NativeExecutionGuard;
  getGrant: () => TaskAuthorityGrant | undefined;
  isCurrentAttempt: () => boolean;
  askUser: (request: { id: string; call: NativeToolCall; basis: RunBasis; digest: string }, signal: AbortSignal) => Promise<'allow' | 'deny'>;
  /** Hash checks cover a declared finite boundary. Confinement is independent. */
  checkBoundary: (stage: 'before' | 'after') => Promise<boolean>;
  onReport: (report: WorkReport) => void;
  onState?: (state: string) => void;
  approvalTimeoutMs?: number; stopTimeoutMs?: number;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}
function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }

/** Deterministic execution core behind the production admission gate. This
 * class does not certify a guard implementation or enable a provider. */
export class NativeWorkerRun {
  private launch?: WorkerLaunch;
  private authorityEpoch = 1;
  private controlEpoch = 1;
  private state: 'new' | 'starting' | 'automatic' | 'human' | 'stopping' | 'stopped' = 'new';
  private readonly pending = new Set<AbortController>();
  private readonly permits = new Map<string, ExecutionPermit>();
  private readonly invocations = new Set<string>();
  private reportReceipt?: { digest: string; id: string; delivered: boolean };
  private grantHash?: string;
  private stopPromise?: Promise<boolean>;
  private stopTimer?: ReturnType<typeof setTimeout>;
  private resolveStop?: (confirmed: boolean) => void;
  private isStarting(): boolean { return this.state === 'starting'; }
  constructor(private readonly options: NativeRunOptions) {
    if (!['claude', 'codex'].includes(options.binding.agent)) throw new Error('unsupported-worker-agent');
    if (options.attempt < 1 || !Number.isSafeInteger(options.attempt)) throw new Error('invalid-attempt');
  }
  basis(): RunBasis {
    const b = this.options.binding;
    return { hostEpoch: b.hostEpoch, runtimeId: b.runtimeId, taskId: b.taskId,
      attemptId: b.attemptId, credentialRef: b.credentialRef, authorityEpoch: this.authorityEpoch, controlEpoch: this.controlEpoch };
  }
  private sameBasis(basis: RunBasis) { return digest(basis) === digest(this.basis()); }
  private current(): boolean {
    try {
      const grant = this.options.getGrant();
      return this.options.isCurrentAttempt() && !!grant
        && isTaskAuthorityCurrent(grant, this.options.binding.taskId, this.options.attempt, this.options.workspaceRoot)
        && (!this.grantHash || grant.grantHash === this.grantHash);
    } catch { return false; }
  }
  private bound(): boolean {
    if (!this.launch?.sessionId) return false;
    if (!this.current()) { void this.stop(); return false; }
    const entry = this.options.ownership.lookup(this.options.binding.agent, this.launch.sessionId);
    const valid = entry.status === 'owned' && Object.entries(this.options.binding)
      .every(([key, value]) => entry.entry[key as keyof WorkerBinding] === value) && !entry.entry.ended;
    if (!valid) void this.stop();
    return valid;
  }
  private peer(peer: unknown): boolean {
    if (!this.current()) { void this.stop(); return false; }
    try { return !!this.launch?.processIdentity
      && this.options.guard.verifyPeer(peer, this.launch.processIdentity, this.options.binding); } catch { return false; }
  }
  private transition(state: typeof this.state) { this.state = state; try { this.options.onState?.(state); } catch { /* diagnostic only */ } }
  private async checkBoundary(stage: 'before' | 'after') {
    try { return await this.options.checkBoundary(stage); } catch { return false; }
  }
  async start(): Promise<void> {
    if (this.state !== 'new' || !this.current()) throw new Error('launch-not-current');
    this.grantHash = this.options.getGrant()!.grantHash;
    this.transition('starting');
    try {
      this.launch = this.options.ownership.reserve(this.options.binding);
      const process = await this.options.guard.spawn();
      // Even a late spawn must be attached for cleanup; stop never restores input.
      this.launch = this.options.ownership.attach(this.launch.runtimeId, this.launch.revision, process);
      if (!this.isStarting() || !this.current()) {
        void this.stop();
        // A spawn completing after the stop timeout must still be terminated.
        await this.options.guard.terminateTree();
        throw new Error('launch-revoked');
      }
    } catch (error) { await this.stop(); throw error; }
  }
  /** First verified hook need not be SessionStart. No tools/input until this
   * atomic commit returns AND the authority/stop check is repeated. */
  bind(peer: unknown, sessionId: string, basis: RunBasis): void {
    if (this.state !== 'starting' || !this.sameBasis(basis) || !this.peer(peer) || !this.launch) throw new Error('binding-rejected');
    this.launch = this.options.ownership.bind(this.launch.runtimeId, this.launch.revision, sessionId);
    if (!this.bound() || this.state !== 'starting') throw new Error('binding-revoked');
    this.transition('automatic');
  }
  bindFromHook(peer: unknown, sessionId: string, basis: RunBasis): boolean {
    if (this.state === 'starting') { this.bind(peer, sessionId, basis); return true; }
    return this.sameBasis(basis) && this.peer(peer) && this.bound() && this.launch?.sessionId === sessionId;
  }
  private invalidate() {
    this.authorityEpoch++;
    for (const controller of this.pending) controller.abort();
    this.pending.clear(); this.permits.clear();
  }
  async requestTool(peer: unknown, basis: RunBasis, call: NativeToolCall): Promise<ExecutionPermit | null> {
    if (!this.canTool(peer, basis, call)) return null;
    const key = JSON.stringify([call.sessionId, call.stage, call.invocationId]);
    if (!call.invocationId || this.invocations.has(key) || this.invocations.size >= 10_000) return null;
    this.invocations.add(key); // retries never create a second authorization
    const frozenCall = structuredClone(call);
    // A native tool must not smuggle an alternate argv next to the command
    // actually executed by its engine. Generic SDK normalization supports
    // several wire shapes; native adapters may use only one at a time.
    if ('command' in frozenCall.input && ['executable', 'argv', 'parsedCommand'].some(key => key in frozenCall.input)) return null;
    const callDigest = digest(frozenCall);
    const grant = this.options.getGrant()!;
    const normalized = normalizeBackendPermissionRequest(this.options.binding.agent === 'claude' ? 'claude-code' : 'codex', {
      taskId: grant.taskId, attempt: this.options.attempt,
      backendId: this.options.binding.agent === 'claude' ? 'claude-code' : 'codex',
      workspaceRoot: this.options.workspaceRoot, nativeRequestId: randomUUID(), toolName: frozenCall.toolName, input: frozenCall.input,
    });
    // Unknown/opaque native paths cannot be accurately confined by this core.
    if (!normalized.ok) return null;
    if (normalized.request.kind === 'command'
      && commandApprovalRisk(normalized.request.executable ?? '', normalized.request.argv ?? []) === 'opaque-shell') return null;
    const decision = evaluateTaskAuthority(grant, normalized.request);
    if (decision.kind === 'deny') return null;
    if (decision.kind === 'ask-user') {
      const controller = new AbortController(); this.pending.add(controller);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const answer = await Promise.race([
          this.options.askUser({ id: randomUUID(), call: frozenCall, basis: structuredClone(basis), digest: callDigest }, controller.signal),
          new Promise<'deny'>(resolve => {
            controller.signal.addEventListener('abort', () => resolve('deny'), { once: true });
            timer = setTimeout(() => { controller.abort(); resolve('deny'); }, this.options.approvalTimeoutMs ?? 120_000);
          }),
        ]);
        if (answer !== 'allow') return null;
      } catch { return null; }
      finally { clearTimeout(timer); this.pending.delete(controller); }
    }
    if (!this.canTool(peer, basis, frozenCall)) return null;
    if (!await this.checkBoundary('before')) { void this.stop(); return null; }
    if (!this.canTool(peer, basis, frozenCall)) return null;
    const permit = { id: randomUUID(), digest: callDigest, basis: structuredClone(basis), expiresAt: Date.now() + 5_000 };
    this.permits.set(permit.id, permit);
    return structuredClone(permit);
  }
  private canTool(peer: unknown, basis: RunBasis, call: NativeToolCall) {
    return (this.state === 'automatic' || this.state === 'human') && this.sameBasis(basis)
      && this.bound() && this.peer(peer) && call.sessionId === this.launch?.sessionId;
  }
  /** Called by the independent guardian at the execution boundary, not by a
   * provider after receiving allow. No reusable shell/task-wide approval. */
  consume(peer: unknown, permitId: string, call: NativeToolCall): boolean {
    const permit = this.permits.get(permitId); this.permits.delete(permitId);
    return !!permit && permit.expiresAt > Date.now() && permit.digest === digest(call)
      && this.canTool(peer, permit.basis, call);
  }
  async afterTool(peer: unknown, basis: RunBasis): Promise<boolean> {
    if (!this.peer(peer) || !this.sameBasis(basis) || !this.bound()) return false;
    if (!await this.checkBoundary('after')) { void this.stop(); return false; }
    return this.sameBasis(basis) && this.bound();
  }
  input(basis: RunBasis, writer: 'host' | 'human', data: string, lease?: unknown): boolean {
    if (!this.sameBasis(basis) || !this.bound() || (writer === 'host' ? this.state !== 'automatic' : this.state !== 'human')) return false;
    try {
      if (!this.options.guard.verifyWriter(lease, writer, basis)) return false;
      return this.options.guard.write(data, writer);
    } catch { void this.stop(); return false; }
  }
  takeover(basis: RunBasis): RunBasis {
    if (this.state !== 'automatic' || !this.sameBasis(basis) || !this.bound()) throw new Error('takeover-rejected');
    this.invalidate(); this.controlEpoch++; this.transition('human'); return this.basis();
  }
  /** reviewCurrent must verify full diff digest/read evidence and actual sole
   * local writer release. UI text, a checkbox or cwd is not that evidence. */
  async handback(basis: RunBasis, reviewCurrent: () => Promise<boolean>): Promise<RunBasis> {
    if (this.state !== 'human' || !this.sameBasis(basis) || !this.bound()) throw new Error('handback-rejected');
    this.invalidate(); this.controlEpoch++;
    const pending = this.basis();
    // During review, neither writer is valid.
    this.transition('starting');
    const reviewed = await reviewCurrent().catch(() => false);
    if (!reviewed || !this.sameBasis(pending) || !this.bound() || !this.isStarting()) {
      void this.stop(); throw new Error('handback-rejected');
    }
    this.transition('automatic'); return this.basis();
  }
  report(peer: unknown, basis: RunBasis, value: unknown): string {
    if (!this.peer(peer) || !this.sameBasis(basis) || !this.bound()
      || !['automatic', 'human'].includes(this.state)) throw new Error('report-rejected');
    const report = workReportSchema.parse(value), hash = digest(report);
    if (this.reportReceipt) {
      if (this.reportReceipt.digest !== hash) throw new Error('report-conflict');
      if (!this.reportReceipt.delivered) throw new Error('report-delivery-unconfirmed');
      return this.reportReceipt.id;
    }
    this.reportReceipt = { id: randomUUID(), digest: hash, delivered: false };
    try {
      this.options.onReport(report); // candidate only, never task success
      this.reportReceipt.delivered = true;
    } catch { void this.stop(); throw new Error('report-delivery-unconfirmed'); }
    return this.reportReceipt.id;
  }
  /** Root exit, hook Stop, EOF and reports deliberately have no stop-confirm API. */
  confirmTreeExit(evidence: unknown): boolean {
    if (this.state !== 'stopping' || !this.launch?.processIdentity) return false;
    try { if (!this.options.guard.verifyTreeExit(evidence, this.launch.processIdentity)) return false; } catch { return false; }
    clearTimeout(this.stopTimer); this.transition('stopped');
    try { this.options.ownership.end(this.launch.runtimeId, this.launch.revision); } catch { /* retain ownership for recovery */ }
    this.resolveStop?.(true);
    return true;
  }
  stop(): Promise<boolean> {
    if (this.state === 'stopped') return Promise.resolve(true);
    if (this.stopPromise) return this.stopPromise;
    // Set the fence synchronously before invoking ANY external callback.
    this.invalidate(); this.controlEpoch++; this.transition('stopping');
    try { this.options.guard.seal(); } catch { /* still attempt tree termination */ }
    this.stopPromise = new Promise<boolean>(resolve => {
      this.resolveStop = resolve;
      this.stopTimer = setTimeout(() => {
        void Promise.resolve().then(() => this.options.guard.terminateTree()).then(result => {
          // terminateTree's boolean is only a diagnostic. Actual tree evidence
          // must arrive through confirmTreeExit, including after a late spawn.
          void result; resolve(this.state === 'stopped');
        }, () => resolve(false));
      }, this.options.stopTimeoutMs ?? 5_000);
      void Promise.resolve().then(() => this.options.guard.interrupt()).catch(() => {});
    });
    return this.stopPromise;
  }
  /** Authority owner/transport must call this synchronously on revocation,
   * disconnect or host change, rather than wait for the next hook. */
  revoke(): Promise<boolean> { return this.stop(); }
}
