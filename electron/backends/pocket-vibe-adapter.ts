// pocket-vibe-adapter.ts — pocket-vibe hub backend adapter.
//
// pocket-vibe is a REMOTE backend: there is no local CLI subprocess. A hub
// process (HTTP, default http://127.0.0.1:8787) fans turns out to agents
// registered on remote machines (Codex/Claude CLI on Windows/Mac/Linux).
// The hub exposes a polling-only API — no streaming events, no cancel:
//
//   GET  /health                 (unauthenticated)
//   GET  /v1/agents              (X-Pocket-Token)
//   POST /v1/turns               (X-Pocket-Token) → { ok, turn_id, task }
//   GET  /v1/turns/{turn_id}     (X-Pocket-Token) → { ok, task }
//
// task.status: queued | waiting_for_agent | sent | acked | done | failed.
// On done, task.result is the remote adapter's JSON (shape varies:
// json.last_message / stdout / note / objective / ... — extracted
// best-effort). On failed, task.error carries the summary.
//
// Worker contract: the remote agent has no AhaStation MCP, so the only
// completion channel is the fenced ```work-report JSON frame (the worker
// system prompt already instructs every backend to emit it — see
// WORKER_PROMPT in orchestrator-prompts.ts). This adapter mirrors the
// OpenCode worker pattern: status transitions → progress signals, turn end
// → exactly one strict WorkReport parse → delivery/failed + ended.

import type {
  BackendAuthConfig,
  BackendCapabilities,
  BackendSession,
  BackendSessionConfig,
  BackendSessionEvent,
  CliBackend,
  InputPriority,
  UserContentBlock,
} from './cli-backend.js';
import {
  extractWorkReportFrame,
  type WorkerAdapterSignal,
} from '../worker-protocol.js';
import { randomUUID } from 'node:crypto';
import { getSettings } from '../store.js';
import type { RemoteControlSettings } from '../remote-control-types.js';
import { getPocketVibeConnection, getRemoteControlSettings, validateRemoteServiceUrl, remotePendingKey, getRemotePending, setRemotePending } from '../remote-control.js';
import type { PocketVibeRemoteDirectory } from './pocket-vibe-target.js';
import { resolveRemoteTarget, REMOTE_ATTACHMENT_ERROR } from './pocket-vibe-target.js';
import {
  compilePocketVibeTaskProfile,
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

const DEFAULT_HUB_URL = 'http://127.0.0.1:8787';
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_TURN_TIMEOUT_MS = 600_000;
const HEALTH_TIMEOUT_MS = 5_000;

// ── Capabilities ────────────────────────────────────────────────────────────

const POCKET_VIBE_CAPABILITIES: BackendCapabilities = {
  // Host-capable via the portable meeting-command channel: like Codex, the
  // remote model emits fenced ```meeting-command JSON frames in its reply
  // text (taught by PORTABLE_MEETING_COMMAND_PROMPT, appended by
  // Orchestrator.buildSessionFactory) and this adapter routes them to
  // extra.meetingCommandHandler → Orchestrator.executeMeetingCommand.
  coordinate: true,
  executeTasks: true,
  displayName: 'Pocket Vibe (远程)',
  iconId: 'pocket-vibe',
  mcp: false,
  permissions: false,
  systemPrompt: true,
  skills: false,
  // Local interrupt stops polling; the hub has no cancel endpoint, so the
  // remote task may keep running (surfaced to the user on interrupt).
  interrupt: true,
  // The "model" slot doubles as the hub's target_agent_id fallback.
  defaultModel: 'linux-worker',
  models: ['linux-worker'],
  installHint: '启动 pocket-vibe hub（默认 http://127.0.0.1:8787）',
};

// ── Hub wire types (loose — the hub is an external process) ─────────────────

type HubTask = {
  status?: string;
  result?: unknown;
  error?: string;
  agent_id?: string;
};

type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: 'error' | 'follow' | 'manual';
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}>;

async function hubJson(response: Awaited<ReturnType<FetchLike>>, bounded: boolean): Promise<unknown> {
  if (!bounded || !response.body) return response.json(); // Legacy and injected protocol fixtures.
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let content = ''; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 512 * 1024) { await reader.cancel(); throw new Error('远端响应超过大小限制'); }
      content += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(content + decoder.decode());
  } finally { reader.releaseLock(); }
}

export interface PocketVibeDeps {
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  pollIntervalMs?: number;
  turnTimeoutMs?: number;
  healthTimeoutMs?: number;
  /** Explicit test seam; production always uses main-process identity/storage. */
  liveAuth?: boolean | (() => RemoteControlSettings);
  /** expected makes deletion conditional on the original submission, atomically in production. */
  pendingStore?: { get: (key: string) => string | undefined; set: (key: string, value?: string, expected?: string) => Promise<void> | void };
}

/** Read the native session directory using the existing saved Hub URL/token. */
export async function fetchPocketVibeRemoteSessions(
  auth: BackendAuthConfig & { publicMode?: boolean; remoteOwnerId?: string },
  refresh = false,
  deps: PocketVibeDeps = {},
): Promise<{ ok: true; directory: PocketVibeRemoteDirectory } | { ok: false; error: string }> {
  if (!auth.apiKey?.trim()) return { ok: false, error: auth.publicMode ? '请启用远端控制并登录远端身份。' : '请先在 Pocket Vibe 设置中保存 Hub 地址和 Tool Token。' };
  if (auth.publicMode && !auth.baseUrl) return { ok: false, error: '远端服务尚未配置。' };
  const baseUrl = (auth.baseUrl?.trim() || DEFAULT_HUB_URL).replace(/\/+$/, '');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  try {
    const response = await (deps.fetchImpl ?? fetch)(`${baseUrl}/v1/remote-sessions?refresh=${refresh}`, {
      headers: auth.publicMode ? { Authorization: `Bearer ${auth.apiKey}` } : { 'X-Pocket-Token': auth.apiKey }, signal: abort.signal,
      ...(auth.publicMode ? { redirect: 'error' as const } : {}),
    });
    if (!response.ok) return { ok: false, error: `会话目录查询失败（HTTP ${response.status}）${response.status === 404 ? '：请更新并重启 Hub。' : ''}` };
    const data = await hubJson(response, auth.publicMode === true) as PocketVibeRemoteDirectory & { ok?: boolean };
    if (!data.ok || !Array.isArray(data.sessions) || !Array.isArray(data.agents) || !['connected', 'disconnected'].includes(data.status)) {
      return { ok: false, error: 'Hub 返回的会话目录格式无效。' };
    }
    const sessions = data.sessions.filter((item) => item
      && typeof item.agent_id === 'string' && typeof item.session_id === 'string'
      && ['codex', 'claude'].includes(item.provider)).map((item) => ({
        agent_id: item.agent_id.slice(0, 256), provider: item.provider, session_id: item.session_id.slice(0, 256),
        ...(auth.publicMode ? { service_url: baseUrl, owner_id: auth.remoteOwnerId } : {}),
        title: typeof item.title === 'string' && item.title ? item.title.slice(0, 160) : item.session_id.slice(0, 160),
        cwd: typeof item.cwd === 'string' ? item.cwd.slice(0, 4096) : '',
        computer_name: typeof item.computer_name === 'string' ? item.computer_name.slice(0, 160) : item.agent_id,
        device_id: typeof item.device_id === 'string' ? item.device_id.slice(0, 256) : undefined,
        execution_status: item.execution_status,
        available: item.available,
        error: item.error,
        native_client_status: 'unknown' as const,
      }));
    const agents = data.agents.filter((item) => item && typeof item.agent_id === 'string').map((item) => ({
      agent_id: item.agent_id.slice(0, 256),
      device_id: typeof item.device_id === 'string' ? item.device_id.slice(0, 256) : undefined,
      computer_name: typeof item.computer_name === 'string' ? item.computer_name.slice(0, 160) : item.agent_id,
      display_name: typeof item.display_name === 'string' ? item.display_name.slice(0, 160) : item.agent_id,
      provider: typeof item.provider === 'string' ? item.provider : '',
      status: item.status, error: typeof item.error === 'string' ? item.error.slice(0, 500) : undefined,
    }));
    return { ok: true, directory: { status: data.status, sessions, agents, ...(auth.publicMode ? { controlMode: 'public' as const } : {}) } };
  } catch (err) {
    return { ok: false, error: `Hub 未连接或会话目录查询超时：${String(err)}` };
  } finally { clearTimeout(timer); }
}

/** Best-effort text extraction from a remote adapter's result JSON. */
export function extractPocketVibeResultText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result !== 'object') return String(result);
  const r = result as Record<string, unknown>;
  const json = (r.json ?? undefined) as Record<string, unknown> | undefined;
  const nativeJson = json?.json as Record<string, unknown> | undefined;
  const candidates: unknown[] = [
    json?.last_message,
    nativeJson?.result,
    json?.result,
    r.last_message,
    r.stdout,
    r.note,
    r.text,
    r.output,
    r.message,
    r.objective,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  if (typeof r.error === 'string' && r.error.trim()) return r.error;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

class TurnInterrupted extends Error {
  constructor() {
    super('pocket-vibe turn interrupted');
    this.name = 'TurnInterrupted';
  }
}

/** Shown when a host turn contained only non-speak meeting commands, so the
 *  chat never goes silently blank (mirrors codex-adapter.ts). */
const COMMAND_ONLY_ACK = '我正在处理，有结果会马上告诉你。';

// ── Session implementation ──────────────────────────────────────────────────

class PocketVibeSession implements BackendSession {
  private readonly publicMode: boolean;
  private readonly boundOwnerId: string;
  private readonly liveAuth: boolean | (() => RemoteControlSettings);
  private readonly pendingStore: NonNullable<PocketVibeDeps['pendingStore']>;
  private readonly pendingIdentity: string | null;
  private activeSubmission: string | null = null;
  private cancellations = new Map<string, Promise<void>>();
  private cancelBeforeSubmit = false;
  private recovery: Promise<void> | null = null;
  private closed = false;
  private ready = false;
  private firstTurn = true;
  private lastTurnId: string | null = null;
  private readonly sessionId: string | null;
  private readonly hubUrl: string;
  private readonly token: string;
  private readonly targetAgentId: string | undefined;
  private readonly provider: string | undefined;
  private readonly turnOptions: Record<string, unknown> | undefined;
  private readonly pollIntervalMs: number;
  private readonly turnTimeoutMs: number;
  private readonly fetchImpl: FetchLike;

  // Serial turn queue — one hub turn in flight at a time.
  private queue: string[] = [];
  private pumping = false;
  private turnAbort: AbortController | null = null;
  private lastEmittedStatus: string | null = null;
  private meetingCommandHandler?: (command: unknown) => Promise<unknown> | unknown;

  private get isWorker(): boolean {
    return this.config.executionRole === 'worker';
  }

  constructor(
    private readonly config: BackendSessionConfig,
    private emit: (event: BackendSessionEvent) => void,
    deps: PocketVibeDeps = {},
  ) {
    const env = config.env ?? {};
    this.publicMode = env.POCKET_VIBE_AUTH_MODE === 'public';
    this.boundOwnerId = config.remoteTarget?.owner_id ?? env.POCKET_VIBE_OWNER_ID ?? '';
    this.liveAuth = deps.liveAuth ?? !deps.fetchImpl;
    this.pendingStore = deps.pendingStore ?? { get: getRemotePending, set: setRemotePending };
    this.hubUrl = (env.POCKET_VIBE_HUB_URL ?? '').trim() || (this.publicMode ? '' : DEFAULT_HUB_URL);
    this.pendingIdentity = this.publicMode && config.remoteTarget ? remotePendingKey({ ...config.remoteTarget,
      service_url: this.hubUrl, owner_id: this.boundOwnerId }) : null;
    this.token = (env.POCKET_VIBE_TOOL_TOKEN ?? '').trim();
    const remoteTarget = config.remoteTarget;
    this.targetAgentId = remoteTarget?.agent_id || (env.POCKET_VIBE_AGENT_ID ?? '').trim()
      || config.model
      || undefined;
    this.provider = remoteTarget?.provider || (env.POCKET_VIBE_PROVIDER ?? '').trim() || undefined;
    // Session continuity: when POCKET_VIBE_SESSION_ID (or a journal-provided
    // resumeSessionId) is set, the hub RESUMES the remote agent session so
    // conversational context survives across turns. Without it every turn is
    // a fresh remote exec with no memory — see the system-prompt replay rule
    // in runTurn().
    this.sessionId = remoteTarget?.session_id || (env.POCKET_VIBE_SESSION_ID ?? '').trim()
      || config.resumeSessionId
      || null;
    const turnOptions = parseJsonObject(env.POCKET_VIBE_TURN_OPTIONS);
    this.turnOptions = remoteTarget
      ? { ...turnOptions, mode: 'resume', session_id: remoteTarget.session_id, cwd: remoteTarget.cwd }
      : turnOptions;
    this.pollIntervalMs = deps.pollIntervalMs
      ?? parsePositiveInt(env.POCKET_VIBE_POLL_INTERVAL_MS)
      ?? DEFAULT_POLL_INTERVAL_MS;
    this.turnTimeoutMs = deps.turnTimeoutMs
      ?? parsePositiveInt(env.POCKET_VIBE_TURN_TIMEOUT_MS)
      ?? DEFAULT_TURN_TIMEOUT_MS;
    const wireFetch = deps.fetchImpl ?? (fetch as unknown as FetchLike);
    this.fetchImpl = this.publicMode ? (url, init = {}) => wireFetch(url, { ...init, redirect: 'error',
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    }) : wireFetch;
    this.healthTimeoutMs = deps.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
    const handler = config.extra?.meetingCommandHandler;
    if (typeof handler === 'function') {
      this.meetingCommandHandler = handler as (command: unknown) => Promise<unknown> | unknown;
    }
  }

  private readonly healthTimeoutMs: number;

  async start(): Promise<void> {
    if (this.publicMode) {
      if (!this.hubUrl || !this.config.remoteTarget) throw new Error('请先配置远端服务、登录身份，并从参与者入口选择已有远端会话');
      validateRemoteServiceUrl(this.hubUrl);
      if ((this.config.remoteTarget.service_url && this.config.remoteTarget.service_url !== this.hubUrl)
        || (this.config.remoteTarget.owner_id && this.config.remoteTarget.owner_id !== this.boundOwnerId)) {
        throw new Error('该远端成员属于其他服务或身份，请重新选择');
      }
    }
    // 1. Hub reachability. Host mode fails FAST with a legible reason —
    //    otherwise HostGroup only sees the session go dark and reports the
    //    cryptic "ended before readiness".
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.healthTimeoutMs);
      let res;
      try {
        res = await this.fetchImpl(`${this.hubUrl}/health`, {
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        throw new Error(`hub /health HTTP ${res.status}`);
      }
      if (this.publicMode && (await hubJson(res, true) as { protocol?: number }).protocol !== 2) throw new Error('Hub 协议不匹配，请更新服务或客户端');
    } catch (err) {
      const message = `Pocket Vibe hub 不可达（${this.hubUrl}）：${String(err)}`;
      if (this.isWorker) {
        this.emitFailure('pocket-vibe-hub-unreachable', message, true);
        return;
      }
      this.emit({ kind: 'error', error: message });
      throw new Error(message);
    }

    // 2. Token must exist and be accepted. A missing token would 401 every
    //    /v1/* call later, so fail at startup instead of turn-by-turn.
    if (!this.token) {
      const message = this.publicMode ? '请在远端控制设置中登录身份' : 'Pocket Vibe 未配置 tool token：请在高级 LAN 兼容设置中保存 hub 的 tool token。';
      if (this.isWorker) {
        this.emit({
          kind: 'worker-signal',
          signal: { kind: 'failed', code: 'pocket-vibe-auth', message, retryable: false },
        });
        return;
      }
      this.emit({ kind: 'auth-required', error: message });
      throw new Error(message);
    }
    const agents = await this.fetchImpl(`${this.hubUrl}/v1/agents`, {
      headers: this.authHeaders(),
    }).catch(() => null);
    if (agents && (agents.status === 401 || agents.status === 403)) {
      const message = 'Pocket Vibe tool token 被 hub 拒绝（401/403），请在设置中检查 token。';
      if (this.isWorker) {
        this.emit({
          kind: 'worker-signal',
          signal: { kind: 'failed', code: 'pocket-vibe-auth', message, retryable: false },
        });
        return;
      }
      this.emit({ kind: 'auth-required', error: message });
      throw new Error(message);
    }

    await this.validateRemoteTarget();
    this.ready = true;
    this.emitInformational(`Pocket Vibe 已连接 hub ${this.hubUrl}`);
    const pending = this.pendingIdentity && this.pendingStore.get(this.pendingIdentity);
    if (pending) {
      this.recovery = this.resumePublicSubmission(pending).catch((error) => {
        this.emitFailure('pocket-vibe-recovery', `远端任务恢复待核对：${String(error)}`, false);
      }).finally(() => { this.recovery = null; });
    }
  }

  // ── Turn pipeline ─────────────────────────────────────────────────────────

  sendUserText(text: string, _priority?: InputPriority): void {
    if (this.closed || !this.ready) return;
    this.queue.push(text);
    void this.pump();
  }

  sendUserContent(content: string | UserContentBlock[], priority?: InputPriority): void {
    if (typeof content === 'string') {
      this.sendUserText(content, priority);
      return;
    }
    if (this.config.remoteTarget && content.some((block) => block.type !== 'text')) {
      this.emitFailure('pocket-vibe-attachments-unsupported', REMOTE_ATTACHMENT_ERROR, false);
      return;
    }
    const text = content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (text) this.sendUserText(text, priority);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const text = this.queue.shift()!;
        try {
          await this.runTurn(text);
        } catch (err) {
          // TurnInterrupted (sleep) and AbortError (in-flight fetch) both
          // mean interrupt() fired — interrupt() already emitted the
          // terminal signal, so just move on to the next queued turn.
          if (err instanceof TurnInterrupted || isAbortError(err)) continue;
          if (this.closed) return;
          this.emitFailure(
            'pocket-vibe-turn-error',
            `Pocket Vibe turn 失败：${String(err)}`,
            true,
          );
          if (this.isWorker) {
            this.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'completed' } });
          }
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runTurn(text: string): Promise<void> {
    this.cancelBeforeSubmit = false;
    if (this.recovery) await this.recovery;
    if (this.publicMode && this.pendingIdentity) {
      const pending = this.pendingStore.get(this.pendingIdentity);
      if (pending) await this.resumePublicSubmission(pending);
    }
    await this.validateRemoteTarget();
    if (this.publicMode && this.cancelBeforeSubmit) return;
    // The hub has no system-prompt field, so the contract (work-report frame
    // for workers, meeting-command protocol for hosts) travels inside the
    // prompt text. With session continuity configured (POCKET_VIBE_SESSION_ID
    // / resumeSessionId) the hub resumes the remote session and prior
    // context survives — prepend once. Without it EVERY turn is a fresh
    // remote exec with no memory, so the full system prompt must be replayed
    // on every turn or the remote agent loses the protocol instructions.
    const needsSystemPrompt = this.config.systemPrompt
      && (this.firstTurn || !this.sessionId);
    const prompt = needsSystemPrompt
      ? `${this.config.systemPrompt}\n\n${text}`
      : text;

    const body: Record<string, unknown> = {
      prompt,
      cwd: this.config.remoteTarget?.cwd ?? this.config.cwd,
      metadata: { source: 'ahastation' },
    };
    if (this.targetAgentId) body.target_agent_id = this.targetAgentId;
    if (this.provider) body.provider = this.provider;
    if (this.sessionId) body.session_id = this.sessionId;
    if (this.turnOptions) body.turn_options = this.turnOptions;
    if (this.config.remoteTarget) {
      body.require_online = true;
      body.remote_target = this.config.remoteTarget;
    }
    let submission: string | null = null;
    if (this.publicMode && this.pendingIdentity) {
      submission = randomUUID();
      this.activeSubmission = submission;
      body.idempotency_key = submission;
      await this.pendingStore.set(this.pendingIdentity, submission);
      if (this.cancelBeforeSubmit) return;
    }

    const created = await this.fetchImpl(`${this.hubUrl}/v1/turns`, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!created.ok) {
      throw new Error(`POST /v1/turns HTTP ${created.status}${this.publicMode ? '；保留提交引用供核对，不自动重跑' : ': ' + await created.text().catch(() => '')}`);
    }
    const payload = (await hubJson(created, this.publicMode)) as { ok?: boolean; turn_id?: string; task?: HubTask };
    if (!payload.ok || typeof payload.turn_id !== 'string' || !payload.turn_id) {
      throw new Error('POST /v1/turns 返回缺少 turn_id');
    }
    const turnId = payload.turn_id;
    this.firstTurn = false;
    this.lastTurnId = turnId;
    this.lastEmittedStatus = null;

    const agentLabel = this.targetAgentId ?? '（自动分配）';
    this.emitProgress(`任务已发送到远程 agent ${agentLabel}（turn ${turnId.slice(0, 8)}…）`);
    this.noteStatus(payload.task?.status);
    await this.pollTurn(turnId, submission);
  }

  private async resumePublicSubmission(key: string): Promise<void> {
    this.activeSubmission = key;
    const response = await this.fetchImpl(`${this.hubUrl}/v2/submissions/${encodeURIComponent(key)}`, { headers: this.authHeaders() });
    if (!response.ok) throw new Error('提交结果未确认；本次不会重新执行。请核对原任务，或使用停止创建持久化取消记录');
    const data = await hubJson(response, true) as { turn_id?: string };
    if (!data.turn_id) throw new Error('Hub 未返回原任务 ID');
    this.lastTurnId = data.turn_id; this.firstTurn = false;
    this.emitProgress('正在恢复原远端任务的反馈，不会重新执行');
    await this.pollTurn(data.turn_id, key);
  }

  private async clearPublicSubmission(key: string | null): Promise<boolean> {
    if (!key || this.activeSubmission !== key) return false;
    if (this.pendingIdentity) {
      if (this.pendingStore.get(this.pendingIdentity) !== key) return false;
      await this.pendingStore.set(this.pendingIdentity, undefined, key);
      if (this.pendingStore.get(this.pendingIdentity) !== undefined) return false;
    }
    if (this.activeSubmission !== key) return false;
    this.activeSubmission = null;
    return true;
  }

  private async pollTurn(turnId: string, submission: string | null = null): Promise<void> {

    const abort = new AbortController();
    this.turnAbort = abort;
    const deadline = Date.now() + this.turnTimeoutMs;
    try {
      for (;;) {
        await sleep(this.pollIntervalMs, abort.signal);
        const res = await this.fetchImpl(
          `${this.hubUrl}/v1/turns/${encodeURIComponent(turnId)}`,
          { headers: this.authHeaders(), signal: abort.signal },
        );
        if (!res.ok) {
          if (this.publicMode && (res.status === 401 || res.status === 403)) throw new Error('远端凭证已失效，请重新登录；原任务可能仍在运行');
          // Transient hub hiccup — keep polling until the deadline.
          if (Date.now() >= deadline) break;
          continue;
        }
        const task = ((await hubJson(res, this.publicMode)) as { task?: HubTask }).task ?? {};
        if (abort.signal.aborted || this.closed) throw new TurnInterrupted();
        if (this.publicMode && this.activeSubmission !== submission) return;
        this.noteStatus(task.status);
        if (this.publicMode && task.status === 'cleanup-unconfirmed') throw new Error('远端任务退出未确认；保留引用并阻止新指令，请核对或停止原任务');
        if (this.publicMode && ['done', 'failed', 'cancelled'].includes(task.status ?? '')) {
          if ((task.result as { cleanup_confirmed?: boolean } | undefined)?.cleanup_confirmed !== true) throw new Error('远端未提供任务退出确认');
          await this.clearPublicSubmission(submission);
        }
        if (task.status === 'cancelled') {
          this.emitProgress('远端任务已停止，任务进程退出已确认');
          this.emit({ kind: 'message', message: { type: 'result', raw: task } });
          if (this.isWorker) this.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'interrupted' } });
          return;
        }
        if (task.status === 'done') {
          this.finishDoneTurn(task);
          return;
        }
        if (task.status === 'failed') {
          this.finishFailedTurn(task);
          return;
        }
        if (Date.now() >= deadline) break;
      }
      // Poll deadline exhausted.
      const message = `Pocket Vibe turn ${turnId.slice(0, 8)}… 超过 ${Math.round(this.turnTimeoutMs / 1000)}s 未完成`;
      if (this.isWorker) {
        this.emit({
          kind: 'worker-signal',
          signal: { kind: 'failed', code: 'pocket-vibe-turn-timeout', message, retryable: true },
        });
        this.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'completed' } });
      } else {
        this.emit({ kind: 'error', error: message });
      }
    } finally {
      if (this.turnAbort === abort) this.turnAbort = null;
    }
  }

  /** Emit a progress note only when the hub status actually changes. */
  private noteStatus(status: string | undefined): void {
    if (!status || status === this.lastEmittedStatus) return;
    this.lastEmittedStatus = status;
    const label: Record<string, string> = {
      queued: '排队中',
      waiting_for_agent: '等待远程 agent 接收',
      sent: '已发送到远程 agent',
      acked: '远程 agent 已确认，执行中',
      dispatching: '正在交付', delivered: '已交付，等待电脑确认', received: '电脑已持久化接收',
      waiting: '等待执行', running: '远端执行中', cancelling: '正在取消，等待进程退出确认',
      'cleanup-unconfirmed': '进程退出未确认，后续指令已阻断',
      'delivery-uncertain': '交付未确认，不会自动重新执行',
    };
    if (this.config.remoteTarget?.title.includes('Codex 桌面联动')) {
      label.waiting = '等待同一会话当前任务结束后执行';
      label.running = 'Station 执行中（桌面共享会话）';
      label.cancelling = '正在停止 Station 任务，等待原生任务和命令退出确认';
      label['cleanup-unconfirmed'] = '停止未确认，原会话后续指令已阻断';
    }
    const text = label[status];
    if (text) this.emitProgress(`Pocket Vibe：${text}`);
  }

  private finishDoneTurn(task: HubTask): void {
    const text = extractPocketVibeResultText(task.result);
    if (this.isWorker) {
      const extracted = extractWorkReportFrame(text);
      if (extracted.visibleText) {
        this.emit({ kind: 'worker-signal', signal: { kind: 'progress', message: extracted.visibleText } });
      }
      const signals: WorkerAdapterSignal[] = extracted.report
        ? [
            { kind: 'delivery', report: extracted.report },
            { kind: 'ended', reason: 'completed' },
          ]
        : [
            {
              kind: 'failed',
              code: extracted.error ? 'invalid-work-report' : 'missing-work-report',
              message: extracted.error
                ? `Pocket Vibe 返回了非法 WorkReport：${extracted.error}`
                : 'Pocket Vibe turn 结束但没有 WorkReport',
              retryable: true,
            },
            { kind: 'ended', reason: 'completed' },
          ];
      for (const signal of signals) {
        this.emit({ kind: 'worker-signal', signal });
      }
      return;
    }
    const visible = extractWorkReportFrame(text).visibleText;
    // Host path: dispatch fenced ```meeting-command frames to the
    // orchestrator exactly like the Codex host path (PORTABLE_MEETING_COMMAND_PROMPT
    // teaches the remote model the protocol), then emit whatever text
    // remains as the assistant message.
    const { visibleText, hasSpeakCommand, hasNonSpeakCommand } =
      this.config.remoteTarget
        ? { visibleText: visible, hasSpeakCommand: false, hasNonSpeakCommand: false }
        : this.dispatchMeetingCommands(visible);
    // `speak` is rendered by Orchestrator.narrateAssistantLine() — emitting
    // the agent message too would double the sentence in the transcript.
    if (!hasSpeakCommand) {
      const chatText = visibleText || (hasNonSpeakCommand ? COMMAND_ONLY_ACK : '');
      if (chatText) {
        this.emit({
          kind: 'message',
          message: {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: chatText }] },
          },
        });
      }
    }
    this.emit({ kind: 'message', message: { type: 'result', raw: task } });
  }

  /** Extract fenced ```meeting-command frames, hand each parsed command to
   *  the orchestrator's handler (fire-and-forget; handler errors surface as
   *  session error events) and return the remaining user-visible text.
   *  Mirrors dispatchAppServerCommands in codex-adapter.ts. */
  private dispatchMeetingCommands(text: string): {
    visibleText: string; hasSpeakCommand: boolean; hasNonSpeakCommand: boolean;
  } {
    const fenced = /```meeting-command\s*([\s\S]*?)```/gi;
    let hasSpeakCommand = false;
    let hasNonSpeakCommand = false;
    for (const match of text.matchAll(fenced)) {
      try {
        const command = JSON.parse(match[1]);
        if (
          command?.kind === 'speak'
          && typeof command.text === 'string'
          && command.text.trim().length > 0
        ) hasSpeakCommand = true;
        else hasNonSpeakCommand = true;
        if (this.meetingCommandHandler) {
          void Promise.resolve(this.meetingCommandHandler(command)).catch((err) => {
            this.emit({ kind: 'error', error: `Meeting command failed: ${String(err)}` });
          });
        }
      } catch (err) {
        this.emit({ kind: 'error', error: `Invalid meeting-command JSON: ${String(err)}` });
      }
    }
    return {
      visibleText: text.replace(fenced, '').trim(),
      hasSpeakCommand,
      hasNonSpeakCommand,
    };
  }

  private finishFailedTurn(task: HubTask): void {
    const detail = (typeof task.error === 'string' && task.error.trim())
      ? task.error
      : extractPocketVibeResultText(task.result) || '远程任务失败（无错误详情）';
    if (this.isWorker) {
      this.emit({
        kind: 'worker-signal',
        signal: {
          kind: 'failed',
          code: 'pocket-vibe-turn-failed',
          message: `Pocket Vibe 远程任务失败：${detail}`,
          retryable: true,
        },
      });
      this.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'completed' } });
      return;
    }
    this.emit({
      kind: 'message',
      message: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `Pocket Vibe 远程任务失败：${detail}` }],
        },
      },
    });
    this.emit({ kind: 'message', message: { type: 'result', raw: task } });
  }

  // ── Emit helpers (mirror the OpenCode worker/host split) ─────────────────

  private emitProgress(text: string): void {
    if (this.closed) return;
    if (this.isWorker) {
      this.emit({ kind: 'worker-signal', signal: { kind: 'progress', message: text } });
      return;
    }
    this.emit({
      kind: 'message',
      message: {
        type: 'system',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      },
    });
  }

  private emitInformational(text: string): void {
    this.emitProgress(text);
  }

  private emitFailure(code: string, message: string, retryable: boolean): void {
    if (this.closed) return;
    if (this.isWorker) {
      this.emit({ kind: 'worker-signal', signal: { kind: 'failed', code, message, retryable } });
      return;
    }
    this.emit({ kind: 'error', error: message });
  }

  private authHeaders(): Record<string, string> {
    if (this.publicMode) {
      let token = this.token;
      if (this.liveAuth) {
        const state = typeof this.liveAuth === 'function' ? this.liveAuth() : getRemoteControlSettings();
        if (!state.enabled || state.mode !== 'public' || state.ownerId !== this.boundOwnerId || state.serviceUrl !== this.hubUrl || state.credentialInvalid) {
          throw new Error('远端身份、服务或启用状态已改变；请登录原身份核对任务');
        }
        token = state.controlToken ?? '';
      }
      if (!token) throw new Error('请登录远端身份');
      return { Authorization: `Bearer ${token}` };
    }
    return this.token ? { 'X-Pocket-Token': this.token } : {};
  }

  private async validateRemoteTarget(): Promise<void> {
    if (!this.config.remoteTarget) return;
    const headers = this.authHeaders();
    const token = this.publicMode ? headers.Authorization.slice(7) : this.token;
    const result = await fetchPocketVibeRemoteSessions({ authMode: 'apikey', baseUrl: this.hubUrl, apiKey: token,
      publicMode: this.publicMode, remoteOwnerId: this.boundOwnerId }, true, { fetchImpl: this.fetchImpl });
    if (!result.ok) throw new Error(result.error);
    const target = resolveRemoteTarget(this.config.remoteTarget, result.directory);
    const onResolved = this.config.extra?.onRemoteTargetResolved;
    if (typeof onResolved === 'function') onResolved(target);
    Object.assign(this.config.remoteTarget, target);
  }

  // ── BackendSession contract ───────────────────────────────────────────────

  resolvePermission(_id: string, _decision: 'allow' | 'deny', _message?: string): void {
    // permissions: false — the hub runs the remote CLI under its own policy.
  }

  async interrupt(reason: 'steer' | 'user' | 'shutdown' = 'user'): Promise<void> {
    if (this.closed) return;
    if (this.publicMode && reason !== 'shutdown') {
      this.cancelBeforeSubmit = true;
      if (reason === 'user') this.queue = [];
      const key = this.activeSubmission ?? (this.pendingIdentity ? this.pendingStore.get(this.pendingIdentity) : undefined);
      if (!key) { if (this.pumping) this.emitProgress('已停止待提交指令，未启动远端任务'); return; }
      const existing = this.cancellations.get(key);
      if (existing) return existing;
      const abort = this.turnAbort;  // This controller belongs to the captured submission only.
      const cancellation = this.cancelPublicSubmission(key, abort);
      this.cancellations.set(key, cancellation);
      try { await cancellation; }
      finally { if (this.cancellations.get(key) === cancellation) this.cancellations.delete(key); }
      return;
    }
    const hadTurn = this.turnAbort !== null;
    this.turnAbort?.abort();
    this.turnAbort = null;
    if (!hadTurn) return;
    if (this.isWorker) {
      if (reason !== 'steer') {
        this.emit({
          kind: 'worker-signal',
          signal: {
            kind: 'progress',
            message: '已停止等待远程结果（hub 无取消接口，远程任务可能仍在运行）',
          },
        });
        this.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'interrupted' } });
      }
      return;
    }
    if (reason !== 'steer') {
      this.emitInformational('已中断等待（hub 无取消接口，远程任务可能仍在运行）。');
    }
  }

  private async cancelPublicSubmission(key: string, abort: AbortController | null): Promise<void> {
    this.emitProgress('取消请求正在提交；进程退出确认之前仍显示取消中');
    try {
      const response = await this.fetchImpl(`${this.hubUrl}/v2/submissions/${encodeURIComponent(key)}/cancel`, { method: 'POST', headers: this.authHeaders() });
      if (!response.ok) throw new Error(`取消请求 HTTP ${response.status}，未确认`);
      const deadline = Date.now() + 30_000;
      for (;;) {
        const read = await this.fetchImpl(`${this.hubUrl}/v2/submissions/${encodeURIComponent(key)}`, { headers: this.authHeaders() });
        if (!read.ok) throw new Error('取消状态暂时无法核对，原任务可能继续运行');
        const task = (await hubJson(read, true) as { task?: HubTask }).task;
        if (this.activeSubmission === key) this.noteStatus(task?.status);
        if (task && ['done', 'failed', 'cancelled'].includes(task.status ?? '') && (task.result as { cleanup_confirmed?: boolean })?.cleanup_confirmed === true) {
          if (await this.clearPublicSubmission(key)) {
            abort?.abort();
            if (!this.activeSubmission) this.emitProgress(task.status === 'cancelled' ? '远端任务已停止，进程退出已确认' : '原任务已结束，进程退出已确认');
          }
          return;
        }
        if (task?.status === 'cleanup-unconfirmed' || Date.now() >= deadline) throw new Error('取消已请求，但进程退出尚未确认；引用已保留，请继续核对');
        await sleep(this.pollIntervalMs);
      }
    } catch (error) {
      if (this.activeSubmission === key) this.emitFailure('pocket-vibe-cancel-unconfirmed', String(error), false);
      throw error;
    }
  }

  snapshot(): { protocol: string; sessionId: string } | null {
    const id = this.sessionId ?? this.lastTurnId;
    return id ? { protocol: 'pocket-vibe', sessionId: id } : null;
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.turnAbort?.abort();
    this.turnAbort = null;
    this.emit({ kind: 'ended' });
    this.emit = () => {};
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TurnInterrupted());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// ── Backend factory ─────────────────────────────────────────────────────────

export class PocketVibeBackend implements CliBackend {
  readonly id = 'pocket-vibe';
  readonly capabilities = POCKET_VIBE_CAPABILITIES;

  constructor(private readonly deps: PocketVibeDeps = {}) {}

  compileTaskProfile(
    requested: TaskExecutionProfile,
    runtime: BackendRuntime,
  ): BackendEffectiveProfile {
    return compilePocketVibeTaskProfile(
      requested,
      runtime,
      this.capabilities.defaultModel!,
    );
  }

  normalizePermissionRequest(
    native: NativePermissionRequest,
  ): PermissionNormalizationResult {
    // capabilities.permissions is false so no native request ever arrives;
    // the orchestrator's plan gate still requires this method to exist.
    return normalizeBackendPermissionRequest(this.id, native);
  }

  createSession(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ): BackendSession {
    return new PocketVibeSession(config, emit, this.deps);
  }

  resolveBinary(): string | null {
    // Remote backend — no local binary exists. The registry treats a null
    // return as "not installed" and hides the backend from the UI, so a
    // non-null sentinel marks this always-available HTTP backend.
    return 'pocket-vibe-remote';
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...extra };
    if (getSettings().remoteControl?.mode === 'public') {
      const connection = getPocketVibeConnection();
      env.POCKET_VIBE_AUTH_MODE = 'public';
      env.POCKET_VIBE_HUB_URL = connection.baseUrl ?? '';
      env.POCKET_VIBE_TOOL_TOKEN = connection.apiKey ?? '';
      env.POCKET_VIBE_OWNER_ID = connection.remoteOwnerId ?? '';
      delete env.POCKET_VIBE_AGENT_ID;
      delete env.POCKET_VIBE_SESSION_ID;
      delete env.POCKET_VIBE_TURN_OPTIONS;
      return env;
    }
    if (auth.baseUrl) env.POCKET_VIBE_HUB_URL = auth.baseUrl;
    if (auth.authMode === 'apikey' && auth.apiKey) {
      env.POCKET_VIBE_TOOL_TOKEN = auth.apiKey;
    }
    return env;
  }

  async validateAuth(config: BackendAuthConfig): Promise<{ ok: boolean; error?: string }> {
    if (getSettings().remoteControl?.mode === 'public') {
      const connection = getPocketVibeConnection();
      return connection.apiKey && connection.baseUrl ? { ok: true } : { ok: false, error: '请启用远端控制、配置服务并登录远端身份' };
    }
    if (config.authMode === 'apikey' && !config.apiKey) {
      return { ok: false, error: 'Tool token required' };
    }
    return { ok: true };
  }

  async checkAuthStatus(): Promise<{ loggedIn: boolean }> {
    // The SideDrawer "邀请" gate (isConfigured = loggedIn) only trusts
    // checkAuthStatus — without it a saved tool token still showed "未配置".
    // A stored tool token is sufficient: the hub is a LAN service, and the
    // token is validated for real when a session starts (401 → auth-required).
    const auth = getPocketVibeConnection();
    return { loggedIn: Boolean(auth?.apiKey?.trim()) };
  }
}
