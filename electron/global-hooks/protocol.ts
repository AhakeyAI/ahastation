// IF-1 v0.1.0. Provider output and observation input deliberately have no
// authority to admit a native Worker. #86 must supply an independent gate.
export type HookAgent = 'claude' | 'codex';
export const HOOK_EVENTS = ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop'] as const;
export type HookEvent = typeof HOOK_EVENTS[number];
export const NATIVE_WORKER_ADMISSION = Object.freeze({
  enabled: false as const,
  reason: 'unsupported-contract',
  blockers: ['IF-2-launch-binding', 'independent-execution-guard', 'B04-real-cli-evidence'],
});

/** Call BEFORE reserve/spawn/prompt injection. No opt-in flag can enable it. */
export function requireNativeHookWorkerAdmission(): never {
  throw new Error('unsupported-contract: native hook Workers remain disabled pending #86 / B04');
}

export function denyHook(stage: string, reason = 'unsupported-contract') {
  if (stage === 'PermissionRequest') return {
    hookSpecificOutput: { hookEventName: stage, decision: { behavior: 'deny', message: reason } },
  };
  // Never return an allow verdict (including for invalid/unknown stages).
  return { hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
  } };
}

export interface HookObservationInput {
  protocol: 'aha.if1'; schemaVersion: 1;
  invocationId: string; agent: HookAgent; event: HookEvent;
  sessionId: string;
  toolName?: string; turnId?: string; toolUseId?: string;
}
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v);

/** Allowlist, never spread a vendor payload: no cwd, prompt, input, output,
 * transcript path, provider agent identity or caller-supplied origin. */
export function sanitizeHook(agent: HookAgent, native: unknown, invocationId: string): HookObservationInput | null {
  if (!native || typeof native !== 'object' || Array.isArray(native)) return null;
  const p = native as Record<string, unknown>;
  if (!id(p.session_id) || !HOOK_EVENTS.includes(p.hook_event_name as HookEvent)) return null;
  const event = p.hook_event_name as HookEvent;
  if (event !== 'Stop' && !id(p.tool_name)) return null;
  return {
    protocol: 'aha.if1', schemaVersion: 1, invocationId, agent, event, sessionId: p.session_id,
    ...(event !== 'Stop' ? { toolName: p.tool_name as string } : {}),
    ...(id(p.turn_id) ? { turnId: p.turn_id } : {}),
    ...(event !== 'PermissionRequest' && id(p.tool_use_id) ? { toolUseId: p.tool_use_id } : {}),
  };
}

export function parseObservation(value: unknown): HookObservationInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.protocol !== 'aha.if1' || v.schemaVersion !== 1 || !id(v.invocationId)
    || (v.agent !== 'claude' && v.agent !== 'codex')) return null;
  const clean = sanitizeHook(v.agent, {
    session_id: v.sessionId, hook_event_name: v.event, tool_name: v.toolName,
    turn_id: v.turnId, tool_use_id: v.toolUseId,
  }, v.invocationId);
  // Reject extra fields rather than accepting an attempted identity injection.
  return clean && Object.keys(v).every(k => Object.hasOwn(clean, k)) ? clean : null;
}

/** Suspicion only, NEVER authentication. The controlled executable has a
 * separate fixed entry point; stripping env cannot enable that entry point. */
export function hasControlledHints(env: NodeJS.ProcessEnv): boolean {
  return ['AHA_SESSION_ORIGIN', 'AHA_RUNTIME_ID', 'AHA_WORKER_ID', 'AHA_ATTEMPT_ID',
    'AHA_HOOK_CREDENTIAL', 'AHA_HOOK_CREDENTIAL_FILE', 'AHA_CONTROLLED_LAUNCH']
    .some(key => Object.hasOwn(env, key));
}
