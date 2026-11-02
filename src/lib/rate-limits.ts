// Renderer side of the per-agent quota strip: wire types, a shared store fed
// by 'rate-limits:update', and the formatting rules. Display logic (tightest
// window, worst-first order, 60/80 % tones, boundary-scheduled countdown) is
// adapted from Orca's status-bar usage (https://github.com/stablyai/orca),
// MIT License, Copyright (c) 2026 Lovecast Inc.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

export type UsageProviderId = 'claude' | 'codex' | 'kimi';

export interface RateLimitWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number | null;
}

export interface ProviderUsage {
  provider: UsageProviderId;
  session: RateLimitWindow | null;
  weekly: RateLimitWindow | null;
  planType?: string | null;
  status: 'idle' | 'fetching' | 'ok' | 'error' | 'unavailable';
  error: string | null;
  updatedAt: number;
}

export interface UsageState {
  providers: ProviderUsage[];
  refreshing: boolean;
}

export interface RateLimitsApi {
  get: () => Promise<{ ok: true; state: UsageState } | { ok: false; error: string }>;
  refresh: () => Promise<{ ok: true; state: UsageState } | { ok: false; error: string }>;
  onUpdate: (cb: (state: UsageState) => void) => () => void;
}

export const PROVIDER_LABEL: Record<UsageProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
};

export const USAGE_WARNING_PERCENT = 60;
export const USAGE_URGENT_PERCENT = 80;

export type UsageDisplay = 'remaining' | 'used';
export type UsageDensity = 'verbose' | 'compact';
export type UsageTone = 'normal' | 'warning' | 'urgent';

export interface UsageSection {
  key: 'session' | 'weekly';
  label: string;
  window: RateLimitWindow;
}

export function clampUsed(usedPercent: number): number {
  return Number.isFinite(usedPercent) ? Math.max(0, Math.min(100, Math.round(usedPercent))) : 0;
}

/** Round the used value before taking the complement so bar and label agree. */
export function displayedPercent(usedPercent: number, display: UsageDisplay): number {
  if (!Number.isFinite(usedPercent)) return 0;
  const used = clampUsed(usedPercent);
  return display === 'used' ? used : 100 - used;
}

export function usageTone(usedPercent: number): UsageTone {
  const used = clampUsed(usedPercent);
  return used >= USAGE_URGENT_PERCENT ? 'urgent' : used >= USAGE_WARNING_PERCENT ? 'warning' : 'normal';
}

export function usageSections(p: ProviderUsage): UsageSection[] {
  const out: UsageSection[] = [];
  if (p.session) out.push({ key: 'session', label: '5 小时', window: p.session });
  if (p.weekly) out.push({ key: 'weekly', label: '本周', window: p.weekly });
  return out;
}

/** Urgency is by consumption, whichever percentage the user chose to display. */
export function tightestSection(p: ProviderUsage): UsageSection | null {
  const sections = usageSections(p);
  if (!sections.length) return null;
  return sections.reduce((a, b) => (clampUsed(b.window.usedPercent) > clampUsed(a.window.usedPercent) ? b : a));
}

export function providerMaxUsed(p: ProviderUsage): number {
  const t = tightestSection(p);
  return t ? clampUsed(t.window.usedPercent) : -1;
}

/** Worst-first so the agent nearest a limit sits on top; no-data rows last. */
export function sortWorstFirst(providers: ProviderUsage[]): ProviderUsage[] {
  return [...providers].sort((a, b) => providerMaxUsed(b) - providerMaxUsed(a));
}

/** "47 分钟" / "3 小时 54 分" / "6 天 7 小时"; floors to whole units. */
export function formatResetDuration(ms: number): string {
  if (ms <= 0) return '现在';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const rem = hours % 24;
    return rem ? `${days} 天 ${rem} 小时` : `${days} 天`;
  }
  const rem = mins % 60;
  return rem ? `${hours} 小时 ${rem} 分` : `${hours} 小时`;
}

export function formatResetIn(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  const d = formatResetDuration(resetsAt - now);
  return d === '现在' ? '即将重置' : `${d}后重置`;
}

export function formatPercent(usedPercent: number, display: UsageDisplay): string {
  return `${display === 'used' ? '已用' : '剩余'} ${displayedPercent(usedPercent, display)}%`;
}

const PLAN_LABELS: Record<string, string> = {
  free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', team: 'Team',
  business: 'Business', enterprise: 'Enterprise', edu: 'Edu',
};

export function formatPlan(planType: string | null | undefined): string | null {
  if (!planType) return null;
  return PLAN_LABELS[planType.toLowerCase()] ?? planType.charAt(0).toUpperCase() + planType.slice(1);
}

export function formatUpdatedAgo(updatedAt: number, now: number): string {
  if (!updatedAt) return '尚未获取';
  const mins = Math.floor((now - updatedAt) / 60_000);
  if (mins < 1) return '刚刚更新';
  if (mins < 60) return `${mins} 分钟前更新`;
  return `${Math.floor(mins / 60)} 小时前更新`;
}

/** Status line for a provider with no windows to show. */
export function emptyStatusLabel(p: ProviderUsage): string {
  if (p.status === 'idle' || p.status === 'fetching') return '获取中…';
  return p.error ?? (p.status === 'unavailable' ? '不可用' : '获取失败');
}

/**
 * Delay until the soonest countdown label changes: labels floor to minutes
 * (hours past a day), so one timeout just past the next boundary is enough.
 */
export function nextTickDelay(now: number, resetTimes: readonly number[]): number | null {
  let next: number | null = null;
  for (const resetAt of resetTimes) {
    if (!Number.isFinite(resetAt) || resetAt <= now) continue;
    const remaining = resetAt - now;
    const unit = remaining >= 86_400_000 ? 3_600_000 : 60_000;
    const delay = (remaining % unit) + 1;
    next = next === null ? delay : Math.min(next, delay);
  }
  return next;
}

/** A `now` that advances only when some countdown label is due to change. */
export function useCountdownClock(resetTimes: readonly (number | null | undefined)[]): number {
  const [now, setNow] = useState(() => Date.now());
  const key = resetTimes.filter((t): t is number => t != null && Number.isFinite(t)).sort((a, b) => a - b).join('|');
  const times = useMemo(() => (key ? key.split('|').map(Number) : []), [key]);
  const prevKey = useRef(key);
  useLayoutEffect(() => {
    if (prevKey.current === key) return;
    prevKey.current = key;
    setNow(Date.now());
  }, [key]);
  useEffect(() => {
    const delay = nextTickDelay(now, times);
    if (delay === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [now, times]);
  return now;
}

// ---- store -----------------------------------------------------------------

const EMPTY: UsageState = { providers: [], refreshing: false };

class UsageStore {
  private state: UsageState = EMPTY;
  private listeners = new Set<() => void>();
  private started = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.start();
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): UsageState => this.state;

  refresh = (): void => {
    const api = window.vibeMeet?.rateLimits;
    if (!api) return;
    this.set({ ...this.state, refreshing: true });
    void api.refresh().then((res) => { if (res.ok) this.set(res.state); }).catch(() => this.set({ ...this.state, refreshing: false }));
  };

  private start(): void {
    const api = window.vibeMeet?.rateLimits;
    if (this.started || !api) return;
    this.started = true;
    api.onUpdate((state) => this.set(state));
    void api.get().then((res) => { if (res.ok) this.set(res.state); }).catch(() => { /* strip stays empty */ });
  }

  private set(state: UsageState): void {
    this.state = state;
    for (const fn of this.listeners) fn();
  }
}

export const usageStore = new UsageStore();

export function useUsageState(): UsageState {
  return useSyncExternalStore(usageStore.subscribe, usageStore.getSnapshot, usageStore.getSnapshot);
}

/** Per-viewer display preference, persisted best-effort. */
export function usePersistedChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key) as T | null;
      return stored && allowed.includes(stored) ? stored : fallback;
    } catch {
      return fallback;
    }
  });
  const update = (v: T) => {
    setValue(v);
    try { window.localStorage.setItem(key, v); } catch { /* private mode */ }
  };
  return [value, update];
}
