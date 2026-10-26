// claude-code-adapter.ts — wraps the existing ClaudeSession into the
// CliBackend/BackendSession interface.
//
// This adapter does NOT replace or modify ClaudeSession. It constructs one
// internally and translates SessionEvent → BackendSessionEvent at the
// boundary. Since NormalizedMessage is designed to be SDKMessage-compatible
// (same `message.content` shape), the translation is mostly a pass-through.
//
// The Orchestrator/WorkerScheduler consume BackendSession; this adapter is
// the bridge that lets them use Claude Code without knowing about SDK types.

import { execFileSync } from 'node:child_process';
import { ClaudeSession, type SessionEvent, type InputPriority as CSInputPriority } from '../claude-session.js';
import { resolveClaudeBinaryForSource } from '../claude-cli/resolve.js';
import type { ClaudeCliQueryFactory } from '../claude-cli/driver.js';
import { mergedSubprocessEnv } from '../settings-loader.js';
import type {
  BackendSession,
  BackendSessionConfig,
  BackendSessionEvent,
  BackendAuthConfig,
  BackendCapabilities,
  CliBackend,
  InputPriority,
  UserContentBlock,
} from './cli-backend.js';
import type { AutoApproveScope } from '../auto-approve-policy.js';
import type { ConfirmDestructive } from '../claude-session.js';
import { runTerminalLogin } from './terminal-login.js';
import { isolatedSubprocessEnv } from './backend-environment.js';
import {
  extractWorkReportFrame,
  truncateToolOutput,
  type WorkerAdapterSignal,
} from '../worker-protocol.js';
import {
  compileClaudeTaskProfile,
  type BackendRuntime,
} from './task-profile.js';
import {
  normalizeBackendPermissionRequest,
  type NativePermissionRequest,
  type PermissionNormalizationResult,
} from './canonical-execution.js';
import type {
  BackendEffectiveProfile,
  TaskExecutionProfile,
} from '../task-collaboration.js';

// ── Session adapter ────────────────────────────────────────────────────────────
// Wraps a ClaudeSession instance and exposes the BackendSession interface.

export function mapClaudeMessageToWorkerSignals(
  message: unknown,
  toolNames: Map<string, string> = new Map(),
  options: { suppressExpectedSteerBoundary?: boolean } = {},
): WorkerAdapterSignal[] {
  const msg = (message ?? {}) as Record<string, unknown>;
  const type = typeof msg.type === 'string' ? msg.type : '';
  if (type === 'result') {
    if (options.suppressExpectedSteerBoundary) return [];
    const failed = msg.is_error === true || msg.subtype === 'error';
    return failed
      ? [{
          kind: 'failed',
          code: 'claude-turn-failed',
          message: typeof msg.result === 'string' ? msg.result : 'Claude worker turn failed',
          retryable: true,
        }, { kind: 'ended', reason: 'completed' }]
      : [{ kind: 'ended', reason: 'completed' }];
  }

  const body = (msg.message ?? {}) as Record<string, unknown>;
  const content = body.content;
  if (!Array.isArray(content)) return [];
  const signals: WorkerAdapterSignal[] = [];
  for (const rawBlock of content) {
    const block = (rawBlock ?? {}) as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      if (
        options.suppressExpectedSteerBoundary
        && block.text.trim() === '[Request interrupted by user]'
      ) continue;
      const extracted = extractWorkReportFrame(block.text);
      if (extracted.visibleText) {
        signals.push({ kind: 'progress', message: extracted.visibleText });
      }
      if (extracted.error) {
        signals.push({
          kind: 'failed',
          code: 'invalid-work-report',
          message: `Claude Worker emitted an invalid WorkReport: ${extracted.error}`,
          retryable: true,
        });
      } else if (extracted.report) {
        signals.push({ kind: 'delivery', report: extracted.report });
      }
    } else if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' && block.name.trim()
        ? block.name.trim()
        : 'unknown';
      const callId = typeof block.id === 'string' && block.id.trim()
        ? block.id.trim().slice(0, 200)
        : undefined;
      if (callId) toolNames.set(callId, name);
      const input = (block.input && typeof block.input === 'object')
        ? block.input as Record<string, unknown>
        : null;
      const command = typeof input?.command === 'string' ? input.command : undefined;
      signals.push({
        kind: 'tool',
        toolName: name,
        phase: 'started',
        ...(callId ? { callId } : {}),
        ...(command ? { detail: command.slice(0, 4_000) } : {}),
      });
    } else if (block.type === 'tool_result') {
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id.trim().slice(0, 200) : '';
      const name = toolNames.get(id) ?? 'unknown';
      const failed = block.is_error === true;
      const rawOutput = typeof block.content === 'string'
        ? block.content
        : block.content != null
          ? JSON.stringify(block.content)
          : undefined;
      signals.push({
        kind: 'tool',
        toolName: name,
        phase: failed ? 'failed' : 'completed',
        ...(id ? { callId: id } : {}),
        ...(rawOutput !== undefined ? { output: truncateToolOutput(rawOutput) } : {}),
      });
      if (id) toolNames.delete(id);
    }
  }
  return signals;
}

class ClaudeCodeSession implements BackendSession {
  private inner: ClaudeSession;
  private readonly isWorker: boolean;
  private readonly workerTools = new Map<string, string>();
  private workerTurnTerminal = false;
  // Steer emits no terminal boundary and continues on the next turn, so its
  // native error result must be swallowed. User/shutdown closes the session.
  private pendingSteerInterrupts = 0;
  private closed = false;
  private readonly emit: (event: BackendSessionEvent) => void;

  constructor(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
    confirmDestructive?: ConfirmDestructive,
    queryFactory?: ClaudeCliQueryFactory,
    onModels?: (models: string[]) => void,
  ) {
    this.emit = emit;
    this.isWorker = config.executionRole === 'worker';
    // Translate BackendSessionConfig → ClaudeSession constructor options.
    // The NormalizedMessage shape is SDKMessage-compatible, so we can pass
    // the session events through with minimal wrapping.
    this.inner = new ClaudeSession({
      emit: (event: SessionEvent) => {
        if (!this.isWorker) {
          emit(event as BackendSessionEvent);
          return;
        }
        if (this.closed) return;
        if (event.kind === 'message') {
          const message = (event.message ?? {}) as Record<string, unknown>;
          const expectedInterruptResult = this.pendingSteerInterrupts > 0;
          const isTurnResult = message.type === 'result';
          for (const signal of mapClaudeMessageToWorkerSignals(
            event.message,
            this.workerTools,
            { suppressExpectedSteerBoundary: expectedInterruptResult },
          )) {
            if (signal.kind === 'ended') this.workerTurnTerminal = true;
            emit({ kind: 'worker-signal', signal });
          }
          if (expectedInterruptResult && isTurnResult) {
            this.pendingSteerInterrupts -= 1;
          }
        } else if (event.kind === 'auth-required') {
          emit({
            kind: 'worker-signal',
            signal: {
              kind: 'failed',
              code: 'auth-required',
              message: event.error,
              retryable: false,
            },
          });
        } else if (event.kind === 'error') {
          emit({
            kind: 'worker-signal',
            signal: {
              kind: 'failed',
              code: 'claude-runtime-error',
              message: event.error,
              retryable: true,
            },
          });
        } else if (event.kind === 'ended') {
          if (!this.workerTurnTerminal) {
            emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'crashed' } });
            this.workerTurnTerminal = true;
          }
        } else {
          // Permission requests are already provider-neutral security events
          // and remain outside the worker progress protocol.
          emit(event as BackendSessionEvent);
        }
      },
      cwd: config.cwd,
      sessionOptions: buildClaudeSessionOptions(config),
      autoApproveScope: config.autoApproveScope ?? 'off',
      envOverride: config.env,
      confirmDestructive,
      queryFactory,
      onModels,
    });
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  end(): void {
    this.closed = true;
    this.inner.end();
  }

  sendUserText(text: string, priority?: InputPriority): void {
    if (this.isWorker) this.workerTurnTerminal = false;
    this.inner.sendUserText(text, (priority ?? 'normal') as CSInputPriority);
  }

  sendUserContent(content: UserContentBlock[], priority?: InputPriority): void {
    if (this.isWorker) this.workerTurnTerminal = false;
    // UserContentBlock is compatible with SDKUserMessage content blocks
    // (same { type: 'text', text } and { type: 'image', source } shapes).
    this.inner.sendUserContent(
      content as Parameters<ClaudeSession['sendUserContent']>[0],
      (priority ?? 'normal') as CSInputPriority,
    );
  }

  resolvePermission(id: string, decision: 'allow' | 'deny', message?: string): void {
    this.inner.resolvePermission(id, decision, message);
  }

  async interrupt(reason: 'steer' | 'user' | 'shutdown' = 'user'): Promise<void> {
    if (this.isWorker && !this.closed) {
      if (reason === 'steer') {
        // Claude's SDK represents an intentional turn interruption as an error
        // result. Keep that provider-native boundary out of the canonical Worker
        // failure protocol: Scheduler immediately delivers the queued steering
        // message and the same persistent session continues on its next turn.
        this.pendingSteerInterrupts += 1;
      } else if (!this.workerTurnTerminal) {
        this.workerTurnTerminal = true;
        // The wrapper owns the terminal signal. The session then closes and
        // drops any native error result; scheduler resumes from the snapshot.
        this.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'interrupted' } });
      }
    }
    if (reason === 'steer' || !this.isWorker) await this.inner.interrupt();
    else this.end();
  }

  setAutoApproveScope(scope: AutoApproveScope): void {
    this.inner.setAutoApproveScope(scope);
  }

  async setPermissionMode(mode: string): Promise<void> {
    await this.inner.setPermissionMode(
      mode as Parameters<ClaudeSession['setPermissionMode']>[0],
    );
  }

  snapshot(): { protocol: string; sessionId: string } | null {
    return this.inner.snapshot();
  }
}

function buildClaudeSessionOptions(config: BackendSessionConfig): Record<string, unknown> {
  const extra = { ...(config.extra ?? {}) };
  delete extra.meetingCommandHandler;
  if (config.systemPrompt !== undefined && extra.systemPrompt === undefined) {
    extra.systemPrompt = config.systemPrompt;
  }
  // 'auto' is the compiled-profile sentinel for "no explicit model": leave
  // the flag out entirely so the CLI uses the account's own default model.
  if (config.model !== undefined && config.model !== 'auto') extra.model = config.model;
  if (config.mcpServers !== undefined) extra.mcpServers = config.mcpServers;
  if (config.skills !== undefined) extra.skills = config.skills;
  if (config.resumeSessionId !== undefined) extra.resume = config.resumeSessionId;
  const native = config.taskProfile?.nativeReasoning;
  const effort = native?.effort;
  if (
    effort === 'low'
    || effort === 'medium'
    || effort === 'high'
    || effort === 'xhigh'
    || effort === 'max'
  ) {
    extra.effort = effort;
  }
  const thinking = native?.thinking;
  if (
    thinking
    && typeof thinking === 'object'
    && !Array.isArray(thinking)
    && (thinking as Record<string, unknown>).type === 'adaptive'
  ) {
    extra.thinking = { type: 'adaptive' };
  }
  return extra;
}

// ── Backend implementation ─────────────────────────────────────────────────────

const CLAUDE_CODE_CAPABILITIES: BackendCapabilities = {
  coordinate: true,
  executeTasks: true,
  displayName: 'Claude Code',
  iconId: 'claude',
  mcp: true,
  permissions: true,
  systemPrompt: true,
  skills: true,
  interrupt: true,
  // No pinned defaultModel: an unset model means the CLI uses the account's
  // own default, so a retired model id can never block session startup.
  // The list below only feeds UI suggestions; aliases track the latest
  // releases instead of expiring like dated model ids. The concrete list is
  // replaced with the account's actual models after the first session init.
  models: [
    'sonnet',
    'opus',
    'haiku',
    'glm-5.2',
  ],
  npmPackage: '@anthropic-ai/claude-code',
  installHint: 'npm install -g @anthropic-ai/claude-code（使用本机 claude CLI 及其登录态）',
};

export class ClaudeCodeBackend implements CliBackend {
  readonly id = 'claude-code';
  readonly capabilities: BackendCapabilities = { ...CLAUDE_CODE_CAPABILITIES };
  private confirmDestructive?: ConfirmDestructive;
  private readonly deps: {
    resolveBinary?: () => string | null;
    execFile?: (binary: string, args: string[], options?: Record<string, unknown>) => string;
    queryFactory?: ClaudeCliQueryFactory;
  };

  constructor(opts: {
    confirmDestructive?: ConfirmDestructive;
    resolveBinary?: () => string | null;
    execFile?: (binary: string, args: string[], options?: Record<string, unknown>) => string;
    queryFactory?: ClaudeCliQueryFactory;
  } = {}) {
    this.confirmDestructive = opts?.confirmDestructive;
    this.deps = opts;
  }

  compileTaskProfile(
    requested: TaskExecutionProfile,
    runtime: BackendRuntime,
  ): BackendEffectiveProfile {
    return compileClaudeTaskProfile(
      requested,
      runtime,
      'auto',
      // The account's model catalog is discovered at session init, so a
      // static list must not veto an explicit modelPreference here.
    );
  }

  normalizePermissionRequest(
    native: NativePermissionRequest,
  ): PermissionNormalizationResult {
    return normalizeBackendPermissionRequest(this.id, native);
  }

  createSession(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ): BackendSession {
    return new ClaudeCodeSession(
      config,
      emit,
      this.confirmDestructive,
      this.deps.queryFactory,
      (models) => {
        if (models.length > 0) this.capabilities.models = models;
      },
    );
  }

  resolveBinary(): string | null {
    return this.deps.resolveBinary?.() ?? resolveClaudeBinaryForSource();
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const base = mergedSubprocessEnv();
    const env: NodeJS.ProcessEnv = { ...base, ...isolatedSubprocessEnv(extra) };
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (
        typeof value === 'string'
        && (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_') || key.startsWith('XDG_'))
      ) env[key] = value;
    }

    if (auth.apiKey) {
      env.ANTHROPIC_API_KEY = auth.apiKey;
    }
    if (auth.baseUrl) {
      env.ANTHROPIC_BASE_URL = auth.baseUrl;
    }
    if (auth.model) {
      env.ANTHROPIC_MODEL = auth.model;
    }

    return env;
  }

  async validateAuth(config: BackendAuthConfig): Promise<{ ok: boolean; error?: string }> {
    if (config.authMode === 'apikey' && !config.apiKey) {
      return { ok: false, error: 'API key is required for apikey auth mode' };
    }
    return { ok: true };
  }

  async loginOAuth(): Promise<{ ok: boolean; error?: string }> {
    const binary = this.resolveBinary();
    if (!binary) return { ok: false, error: 'Claude CLI runtime is unavailable.' };
    return runTerminalLogin(
      binary, ['auth', 'login'], () => this.checkAuthStatus(), isolatedSubprocessEnv(),
    );
  }

  async checkAuthStatus(): Promise<{ loggedIn: boolean }> {
    const binary = this.resolveBinary();
    if (!binary) return { loggedIn: false };
    try {
      const run = this.deps.execFile ?? ((file: string, args: string[]) =>
        execFileSync(file, args, {
          env: mergedSubprocessEnv(), encoding: 'utf8', timeout: 10_000,
        }));
      const output = run(binary, ['auth', 'status', '--json'], {
        encoding: 'utf8', timeout: 10_000,
      });
      const parsed = JSON.parse(output.trim()) as { loggedIn?: unknown };
      return { loggedIn: parsed.loggedIn === true };
    } catch {
      return { loggedIn: false };
    }
  }
}
