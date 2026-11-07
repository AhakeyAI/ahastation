import { asRecord } from './util.js';
import type { ObservedSession } from './types.js';

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const optionalId = (value: unknown) => value === undefined || nonempty(value);

/** IF-1 snapshot consumer. The trusted local host supplies this, never renderer IPC. */
export function projectObservation(session: ObservedSession, raw: unknown): ObservedSession {
  if (raw === null || raw === undefined) return session;
  const unknown: ObservedSession = { ...session, state: 'unknown', activity: 'unknown', phase: 'unknown' };
  const snapshot = asRecord(raw);
  if (!snapshot || snapshot.protocol !== 'aha.if1' || snapshot.schemaVersion !== 1
    || typeof snapshot.deviceId !== 'string' || !snapshot.deviceId
    || typeof snapshot.publisherEpoch !== 'string' || !snapshot.publisherEpoch
    || !Number.isSafeInteger(snapshot.watermark) || Number(snapshot.watermark) < 0
    || !Array.isArray(snapshot.sessions) || snapshot.sessions.length > 1000) return unknown;
  const agent = session.clientKind === 'claude-code' ? 'claude' : session.clientKind;
  const matches = snapshot.sessions.filter((v) => {
    const subject = asRecord(asRecord(v)?.subject);
    return subject?.deviceId === snapshot.deviceId && subject?.agent === agent && subject.sessionId === session.nativeSessionId;
  });
  if (matches.length === 0) return session;
  if (matches.length !== 1) return unknown;
  const row = asRecord(matches[0]);
  const subject = asRecord(row?.subject);
  const state = asRecord(row?.state);
  if (!subject || !state
    || !(subject.runtimeId === null || nonempty(subject.runtimeId))
    || !['worker', 'station', 'user', 'user-adopted', 'unknown'].includes(String(subject.origin))
    || !['owned', 'unowned', 'unresolved'].includes(String(subject.ownership))
    || !['automatic', 'human', 'none', 'unknown'].includes(String(subject.controlMode))
    || ![subject.workerId, subject.taskId, subject.attemptId].every(optionalId)
    || (subject.taskId === undefined) !== (subject.attemptId === undefined)
    || !['starting', 'running', 'waiting-permission', 'idle', 'stopping', 'ended', 'unknown'].includes(String(state.phase))
    || !['running', 'exited', 'unknown'].includes(String(state.process))
    || !['connected', 'stale', 'disconnected'].includes(String(state.connection))
    || !nonempty(state.reason) || !Number.isSafeInteger(state.pendingApprovalCount) || Number(state.pendingApprovalCount) < 0
    || (state.lastActiveAt !== undefined && (!nonempty(state.lastActiveAt) || !Number.isFinite(Date.parse(state.lastActiveAt))))) return unknown;
  if (['worker', 'station', 'user-adopted'].includes(String(subject.origin)) && subject.ownership !== 'owned') return unknown;
  if (subject.origin === 'worker' && ![subject.runtimeId, subject.workerId, subject.taskId, subject.attemptId].every(nonempty)) return unknown;
  if (subject.origin === 'user' && subject.ownership !== 'unowned') return unknown;
  const next: ObservedSession = { ...session, inferred: false,
    phase: typeof state.phase === 'string' ? state.phase : 'unknown',
    connection: typeof state.connection === 'string' ? state.connection : 'stale',
    state: 'unknown', activity: 'unknown' };
  if (subject.origin === 'worker' || subject.origin === 'station') return { ...next, origin: subject.origin, ownership: 'owned' };
  if (subject.origin !== session.origin || subject.ownership !== session.ownership
    || session.ownership === 'unresolved' || state.connection !== 'connected') return next;
  const running = state.process === 'running' || (state.process === 'unknown' && session.pid !== undefined);
  if (state.phase === 'running' && running) next.state = 'active';
  // Native user permission prompts do not create host approval requests (count=0).
  if (state.phase === 'waiting-permission' && running) {
    next.state = 'waiting'; next.activity = 'waiting';
  }
  if (state.phase === 'idle' && running) next.state = 'idle';
  if (state.phase === 'ended' && state.process === 'exited' && session.pid === undefined) next.state = 'done';
  if (typeof state.lastActiveAt === 'string' && Number.isFinite(Date.parse(state.lastActiveAt))) next.lastActiveAt = Date.parse(state.lastActiveAt);
  return next;
}
