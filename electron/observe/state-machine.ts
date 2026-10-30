// Read-only fallback inference. A live process with no work evidence is idle.
// File recency and turn completion cannot prove process exit or task acceptance.
// Confirmed waiting/ended states come from the local IF-1 host projection.

import type {
  ClaudeTailSignals,
  CodexTailSignals,
  KimiTailSignals,
  ObservedActivity,
  ObservedState,
} from './types.js';

export const CPU_EXECUTING_THRESHOLD = 5;
/** @deprecated Recency no longer determines process completion. */
export const CODEX_DONE_WINDOW_MS = 5 * 60 * 1000;

export type PidState = 'live' | 'dead' | 'none';

export interface InferredState {
  state: ObservedState;
  activity: ObservedActivity;
}

export interface ClaudeStateInput {
  tail: ClaudeTailSignals;
  descendantCpuMax: number;
  pidState: PidState;
}

/** A known exited process is historical, never an active/approval card. */
export function inferClaudeState(input: ClaudeStateInput): InferredState | null {
  if (input.pidState === 'dead') return { state: 'done', activity: 'unknown' };
  if (input.pidState === 'none') {
    // File-only evidence: no live process claims the transcript, so tail
    // signals are stale history, not current activity.
    return { state: 'unknown', activity: 'unknown' };
  }
  if (input.descendantCpuMax > CPU_EXECUTING_THRESHOLD || input.tail.unclosedToolUse) {
    return { state: 'active', activity: 'executing' };
  }
  if (input.tail.trailingRealUser) {
    return { state: 'active', activity: 'thinking' };
  }
  return { state: 'idle', activity: 'unknown' };
}

export interface CodexStateInput {
  tail: CodexTailSignals;
  descendantCpuMax: number;
  pidState: PidState;
  mtimeMs: number;
  now: number;
  /** @deprecated Kept for callers; no recency-based completion inference. */
  doneWindowMs?: number;
}

export function inferCodexState(input: CodexStateInput): InferredState {
  // Even one-shot task_complete is turn evidence, not OS exit evidence.
  if (input.pidState === 'dead') return { state: 'done', activity: 'unknown' };
  if (input.pidState !== 'live') {
    return { state: 'unknown', activity: 'unknown' };
  }
  if (input.descendantCpuMax > CPU_EXECUTING_THRESHOLD || input.tail.pendingFunctionCalls > 0) {
    return { state: 'active', activity: 'executing' };
  }
  if (input.tail.generating) {
    return { state: 'active', activity: 'thinking' };
  }
  return { state: 'idle', activity: 'unknown' };
}

export interface KimiStateInput {
  tail: KimiTailSignals;
  descendantCpuMax: number;
  pidState: PidState;
}

/** null = drop the session (legacy Kimi observer).
 * Executing signals (hot child process) win over the in-flight request,
 * mirroring the Claude ordering. */
export function inferKimiState(input: KimiStateInput): InferredState | null {
  if (input.pidState === 'dead') return null;
  if (input.pidState === 'none') {
    // File-only evidence: the log tail is stale history, not live activity.
    return { state: 'unknown', activity: 'unknown' };
  }
  if (input.descendantCpuMax > CPU_EXECUTING_THRESHOLD) {
    return { state: 'active', activity: 'executing' };
  }
  if (input.tail.inFlightRequest) {
    return { state: 'active', activity: 'thinking' };
  }
  return { state: 'waiting', activity: 'waiting' };
}

// ---------------------------------------------------------------------------
// Codex Desktop (ChatGPT.app code mode)
// ---------------------------------------------------------------------------

export interface CodexDesktopStateInput {
  /** Chat-spawned osPids alive in the current process snapshot. */
  liveChatPids: number[];
  /** Desktop host (`codex app-server`) alive and not self-excluded. */
  hostAlive: boolean;
}

/** Desktop threads have no rollout tail, so state is pure liveness:
 * a live chat-spawned process means a turn is running; otherwise a live
 * host means "window open, nothing running" (host-backed idle); a dead
 * host makes the thread unknowable (the board hides unknown rows). */
export function inferCodexDesktopState(input: CodexDesktopStateInput): InferredState {
  if (input.liveChatPids.length > 0) {
    return { state: 'active', activity: 'executing' };
  }
  if (input.hostAlive) {
    return { state: 'idle', activity: 'unknown' };
  }
  return { state: 'unknown', activity: 'unknown' };
}
