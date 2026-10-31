// Per-agent subscription quota (Claude / Codex / Kimi) for the meeting usage
// strip. Read-only: every provider is queried with the credentials its own CLI
// already keeps on this machine, and nothing is refreshed or rewritten — the
// CLI owns the token lifecycle. Tokens stay in the main process; only the
// mapped windows (percent + reset time) cross IPC.
//
// Fetch paths, window mapping and polling cadence are adapted from Orca
// (https://github.com/stablyai/orca, src/main/rate-limits), MIT License,
// Copyright (c) 2026 Lovecast Inc.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { net } from 'electron';
import { augmentedPath, resolveBinaryFromPath } from './backends/subprocess-backend.js';

export type UsageProviderId = 'claude' | 'codex' | 'kimi';

export interface RateLimitWindow {
  /** Percentage of the window consumed (0–100). */
  usedPercent: number;
  /** Window length in minutes: 300 (5h) or 10080 (7d). */
  windowMinutes: number;
  /** Unix ms when the window resets, if known. */
  resetsAt: number | null;
}

/** idle: never fetched · unavailable: CLI or login absent · error: fetch failed. */
export type ProviderUsageStatus = 'idle' | 'fetching' | 'ok' | 'error' | 'unavailable';

export interface ProviderUsage {
  provider: UsageProviderId;
  session: RateLimitWindow | null;
  weekly: RateLimitWindow | null;
  /** Subscription tier when the provider reports one (Codex plan_type). */
  planType?: string | null;
  status: ProviderUsageStatus;
  /** User-facing reason (Chinese) when status is error / unavailable. */
  error: string | null;
  /** Unix ms of the last successful fetch (0 = never). */
  updatedAt: number;
}

export interface UsageState {
  providers: ProviderUsage[];
  refreshing: boolean;
}

const API_TIMEOUT_MS = 10_000;
const SESSION_MINUTES = 300;
const WEEKLY_MINUTES = 10080;

// Orca service-types: poll every 15 min, debounce focus/resume refetches to 5
// min, and drop a cached window after 30 min of failed refreshes.
export const POLL_MS = 15 * 60 * 1000;
export const MIN_REFETCH_MS = 5 * 60 * 1000;
export const MANUAL_REFETCH_MS = 30 * 1000;
export const STALE_MS = 30 * 60 * 1000;

const clamp = (n: number) => Math.min(100, Math.max(0, n));

function blank(provider: UsageProviderId, status: ProviderUsageStatus, error: string | null): ProviderUsage {
  return { provider, session: null, weekly: null, status, error, updatedAt: 0 };
}

// ---- Claude: OAuth usage endpoint ------------------------------------------

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

interface ClaudeWindowInput { utilization?: number; used_percentage?: number; resets_at?: string | number }

/** 1e10 separates a seconds epoch (< year 2286) from a millisecond one. */
export function parseResetTimestamp(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(numeric) && (typeof value === 'number' || value.trim() !== '')) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = new Date(value as string).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function mapClaudeWindow(raw: ClaudeWindowInput | undefined | null, windowMinutes: number): RateLimitWindow | null {
  if (!raw) return null;
  const used = typeof raw.utilization === 'number' ? raw.utilization
    : typeof raw.used_percentage === 'number' ? raw.used_percentage : null;
  if (used === null || !Number.isFinite(used)) return null;
  return { usedPercent: clamp(used), windowMinutes, resetsAt: parseResetTimestamp(raw.resets_at) };
}

function security(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/security', args, { timeout: 3_000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  });
}

function claudeKeychainServices(): string[] {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (!configDir) return [CLAUDE_KEYCHAIN_SERVICE];
  // Claude Code 2.1+ scopes the item by sha256(NFC(CLAUDE_CONFIG_DIR))[:8].
  const suffix = createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8);
  return [`${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`, CLAUDE_KEYCHAIN_SERVICE];
}

function parseClaudeToken(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const token = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } })?.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null;
  }
}

async function readClaudeToken(): Promise<string | null> {
  if (process.platform === 'darwin') {
    let account = process.env.USER ?? '';
    try { account = userInfo().username; } catch { /* keep env */ }
    for (const service of claudeKeychainServices()) {
      const token = parseClaudeToken(await security(['find-generic-password', '-s', service, '-a', account, '-w']));
      if (token) return token;
    }
  }
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  return parseClaudeToken(await readFile(join(dir, '.credentials.json'), 'utf8').catch(() => null));
}

export async function fetchClaudeUsage(): Promise<ProviderUsage> {
  const token = await readClaudeToken();
  if (!token) return blank('claude', 'unavailable', '未用 Claude 订阅登录（API Key 不计额度）');
  const res = await net.fetch(CLAUDE_USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.0' },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) return blank('claude', 'error', '登录已过期，运行一次 claude 后重试');
  if (res.status === 429) return blank('claude', 'error', '查询过于频繁，稍后自动重试');
  if (!res.ok) return blank('claude', 'error', `额度查询失败（HTTP ${res.status}）`);
  const data = await res.json() as { five_hour?: ClaudeWindowInput; seven_day?: ClaudeWindowInput };
  return {
    provider: 'claude',
    session: mapClaudeWindow(data.five_hour, SESSION_MINUTES),
    weekly: mapClaudeWindow(data.seven_day, WEEKLY_MINUTES),
    status: 'ok', error: null, updatedAt: Date.now(),
  };
}

// ---- Codex: app-server `account/rateLimits/read` ---------------------------

interface CodexWindowSnapshot { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown }
interface CodexRateLimits { primary?: CodexWindowSnapshot | null; secondary?: CodexWindowSnapshot | null; planType?: unknown }

function codexKind(w: CodexWindowSnapshot): 'session' | 'weekly' | null {
  const d = w.windowDurationMins;
  if (typeof d !== 'number' || !Number.isFinite(d)) return null;
  // Older app-server builds report bucket lengths one minute off.
  if (Math.abs(d - SESSION_MINUTES) <= 1) return 'session';
  if (Math.abs(d - WEEKLY_MINUTES) <= 1) return 'weekly';
  return null;
}

function mapCodexWindow(w: CodexWindowSnapshot | null, windowMinutes: number): RateLimitWindow | null {
  if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return null;
  // Codex reports resetsAt in Unix seconds.
  const resetsAt = typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) && w.resetsAt > 0 ? w.resetsAt * 1000 : null;
  return { usedPercent: clamp(w.usedPercent), windowMinutes, resetsAt };
}

export function mapCodexRateLimits(raw: CodexRateLimits | null | undefined): Pick<ProviderUsage, 'session' | 'weekly' | 'planType'> {
  const usable = (w: CodexWindowSnapshot | null | undefined) => (typeof w?.usedPercent === 'number' ? w : null);
  const primary = usable(raw?.primary);
  const secondary = usable(raw?.secondary);
  let session: CodexWindowSnapshot | null = null;
  let weekly: CodexWindowSnapshot | null = null;
  for (const w of [primary, secondary]) {
    if (!w) continue;
    const kind = codexKind(w);
    if (kind === 'session' && !session) session = w;
    else if (kind === 'weekly' && !weekly) weekly = w;
  }
  // Unknown durations keep the legacy primary=session / secondary=weekly order.
  if (!session && primary && codexKind(primary) === null) session = primary;
  if (!weekly && secondary && codexKind(secondary) === null) weekly = secondary;
  return {
    session: mapCodexWindow(session, SESSION_MINUTES),
    weekly: mapCodexWindow(weekly, WEEKLY_MINUTES),
    planType: typeof raw?.planType === 'string' ? raw.planType : null,
  };
}

const CODEX_PROBE_ARGS = ['-c', 'approval_policy=never', '-c', 'features.plugins=false', '-s', 'read-only', '-a', 'never', 'app-server'];
const CODEX_INIT_TIMEOUT_MS = 15_000;
const CODEX_RPC_TIMEOUT_MS = 10_000;
/** Codex rotates refresh tokens: ask for shutdown first, hard-kill only after a drain window. */
const CODEX_SHUTDOWN_DRAIN_MS = 5_000;

export function fetchCodexUsage(): Promise<ProviderUsage> {
  const binary = resolveBinaryFromPath('codex');
  if (!binary) return Promise.resolve(blank('codex', 'unavailable', '未安装 Codex CLI'));
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, CODEX_PROBE_ARGS, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  return new Promise((resolve) => {
    let buffer = '';
    let stderr = '';
    let settled = false;
    let initId = 0;
    let readId = 0;
    let timer = setTimeout(() => finish(blank('codex', 'error', 'Codex 响应超时')), CODEX_INIT_TIMEOUT_MS);

    const shutdown = () => {
      try { child.stdin.end(); } catch { /* already closed */ }
      const kill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGTERM'); }, CODEX_SHUTDOWN_DRAIN_MS);
      child.once('close', () => clearTimeout(kill));
    };
    const finish = (result: ProviderUsage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      shutdown();
      resolve(result);
    };
    const send = (id: number, method: string, params: unknown = {}) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(blank('codex', error.code === 'ENOENT' ? 'unavailable' : 'error', error.code === 'ENOENT' ? '未安装 Codex CLI' : 'Codex 启动失败'));
    });
    child.stdin.on('error', () => { /* surfaced through close */ });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on('close', () => {
      const signedOut = /log ?in|sign ?in|auth/i.test(stderr);
      finish(blank('codex', 'error', signedOut ? '未登录 ChatGPT，运行 codex login 后重试' : 'Codex 进程提前退出'));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: { id?: number; result?: unknown; error?: { message?: string } };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === initId) {
          clearTimeout(timer);
          timer = setTimeout(() => finish(blank('codex', 'error', 'Codex 额度查询超时')), CODEX_RPC_TIMEOUT_MS);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
          readId = initId + 1;
          send(readId, 'account/rateLimits/read');
        } else if (readId && message.id === readId) {
          if (message.error) {
            const signedOut = /log ?in|sign ?in|auth|api key/i.test(message.error.message ?? '');
            finish(blank('codex', signedOut ? 'unavailable' : 'error', signedOut ? '未用 ChatGPT 订阅登录' : 'Codex 额度查询失败'));
            return;
          }
          const mapped = mapCodexRateLimits((message.result as { rateLimits?: CodexRateLimits } | undefined)?.rateLimits);
          finish({ provider: 'codex', ...mapped, status: 'ok', error: null, updatedAt: Date.now() });
        }
      }
    });

    initId = 1;
    try {
      send(initId, 'initialize', { clientInfo: { name: 'ahastudio', version: '1.0.0' } });
    } catch {
      finish(blank('codex', 'error', 'Codex 启动失败'));
    }
  });
}

// ---- Kimi Code: `${base}/usages` -------------------------------------------

interface KimiDetail { limit?: string | number; remaining?: string | number; used?: string | number; resetTime?: string; resetAt?: string }
interface KimiUsageResponse { usage?: KimiDetail; limits?: { window?: { duration?: number; timeUnit?: string }; detail?: KimiDetail }[] }

const toNumber = (v: string | number | undefined) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

function mapKimiWindow(detail: KimiDetail | undefined, windowMinutes: number): RateLimitWindow | null {
  if (!detail) return null;
  const limit = toNumber(detail.limit);
  let used = toNumber(detail.used);
  if (used === null) {
    const remaining = toNumber(detail.remaining);
    if (remaining !== null && limit !== null) used = limit - remaining;
  }
  if (limit === null || limit <= 0 || used === null) return null;
  const reset = detail.resetTime ?? detail.resetAt;
  return { usedPercent: clamp((used / limit) * 100), windowMinutes, resetsAt: reset ? new Date(reset).getTime() || null : null };
}

function kimiWindowMinutes(window: { duration?: number; timeUnit?: string } | undefined): number | null {
  const d = toNumber(window?.duration);
  if (d === null) return null;
  const unit = (window?.timeUnit ?? '').toUpperCase();
  if (unit.includes('HOUR')) return d * 60;
  if (unit.includes('DAY')) return d * 1440;
  if (unit.includes('SECOND')) return Math.round(d / 60);
  return d;
}

/** The top-level `usage` block is the weekly quota; the window closest to 5h is the session. */
export function mapKimiUsage(data: KimiUsageResponse): Pick<ProviderUsage, 'session' | 'weekly'> {
  const weekly = mapKimiWindow(data.usage, WEEKLY_MINUTES);
  let session: RateLimitWindow | null = null;
  for (const entry of data.limits ?? []) {
    const minutes = kimiWindowMinutes(entry.window) ?? SESSION_MINUTES;
    const mapped = mapKimiWindow(entry.detail, minutes);
    if (mapped && (!session || Math.abs(minutes - SESSION_MINUTES) < Math.abs(session.windowMinutes - SESSION_MINUTES))) session = mapped;
  }
  return { session, weekly };
}

export async function fetchKimiUsage(): Promise<ProviderUsage> {
  const home = process.env.KIMI_CODE_HOME?.trim() || join(homedir(), '.kimi-code');
  const raw = await readFile(join(home, 'credentials', 'kimi-code.json'), 'utf8').catch(() => null);
  if (!raw) return blank('kimi', 'unavailable', '未登录 Kimi Code');
  let creds: { access_token?: unknown; expires_at?: unknown };
  try { creds = JSON.parse(raw); } catch { return blank('kimi', 'error', 'Kimi 凭据文件无法解析'); }
  if (typeof creds.access_token !== 'string' || !creds.access_token) return blank('kimi', 'unavailable', '未登录 Kimi Code');
  // Never refresh: a rotated refresh token would log out a live kimi session.
  if (typeof creds.expires_at === 'number' && creds.expires_at - Date.now() / 1000 <= 5) {
    return blank('kimi', 'error', '登录已过期，运行一次 kimi 后重试');
  }
  const base = (process.env.KIMI_CODE_BASE_URL ?? 'https://api.kimi.com/coding/v1').replace(/\/$/, '');
  const res = await net.fetch(`${base}/usages`, {
    headers: { Authorization: `Bearer ${creds.access_token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) return blank('kimi', 'error', '登录已过期，运行一次 kimi 后重试');
  if (!res.ok) return blank('kimi', 'error', `额度查询失败（HTTP ${res.status}）`);
  const mapped = mapKimiUsage(await res.json() as KimiUsageResponse);
  return mapped.session || mapped.weekly
    ? { provider: 'kimi', ...mapped, status: 'ok', error: null, updatedAt: Date.now() }
    : blank('kimi', 'error', '返回里没有额度窗口');
}

// ---- Service ---------------------------------------------------------------

type Fetcher = () => Promise<ProviderUsage>;

const DEFAULT_FETCHERS: Record<UsageProviderId, Fetcher> = {
  claude: fetchClaudeUsage,
  codex: fetchCodexUsage,
  kimi: fetchKimiUsage,
};

/**
 * Keeps the last good windows per provider. A failed refresh keeps the cached
 * windows (status 'error', so the UI marks them stale) until they are older
 * than STALE_MS; 'unavailable' clears them.
 */
export class RateLimitService {
  private state = new Map<UsageProviderId, ProviderUsage>();
  private inFlight: Promise<void> | null = null;
  private lastFetchAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly onChange: (state: UsageState) => void,
    private readonly fetchers: Record<UsageProviderId, Fetcher> = DEFAULT_FETCHERS,
    private readonly now: () => number = Date.now,
  ) {
    for (const id of Object.keys(fetchers) as UsageProviderId[]) this.state.set(id, blank(id, 'idle', null));
  }

  snapshot(): UsageState {
    return { providers: [...this.state.values()], refreshing: this.inFlight !== null };
  }

  /** Starts polling on first use, so the lobby never spawns probes. */
  ensureStarted(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh('poll'), POLL_MS);
    this.timer.unref?.();
    void this.refresh('poll');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  refresh(reason: 'poll' | 'focus' | 'manual'): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const floor = reason === 'manual' ? MANUAL_REFETCH_MS : reason === 'focus' ? MIN_REFETCH_MS : 0;
    if (floor && this.now() - this.lastFetchAt < floor) return Promise.resolve();
    this.lastFetchAt = this.now();
    for (const [id, prev] of this.state) this.state.set(id, { ...prev, status: prev.updatedAt ? prev.status : 'fetching' });
    this.inFlight = Promise.all((Object.entries(this.fetchers) as [UsageProviderId, Fetcher][]).map(async ([id, fetch]) => {
      let next: ProviderUsage;
      try {
        next = await fetch();
      } catch {
        next = blank(id, 'error', '网络不可用，稍后自动重试');
      }
      this.state.set(id, this.merge(this.state.get(id)!, next));
      this.emit();
    })).then(() => undefined).finally(() => {
      this.inFlight = null;
      this.emit();
    });
    this.emit();
    return this.inFlight;
  }

  private merge(prev: ProviderUsage, next: ProviderUsage): ProviderUsage {
    if (next.status !== 'error' || !prev.updatedAt || this.now() - prev.updatedAt > STALE_MS) return next;
    return { ...prev, status: 'error', error: next.error };
  }

  private emit(): void {
    this.onChange(this.snapshot());
  }
}
