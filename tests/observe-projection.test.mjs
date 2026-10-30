import assert from 'node:assert/strict';
import test from 'node:test';
import { projectObservation } from '../dist-electron/observe/observation-projection.js';

const session = { clientKind: 'claude-code', nativeSessionId: 's-user', origin: 'user', ownership: 'unowned',
  state: 'active', activity: 'thinking', inferred: true, lastActiveAt: 1 };
const subject = { deviceId: 'd-1', agent: 'claude', sessionId: 's-user', runtimeId: null,
  origin: 'user', ownership: 'unowned', controlMode: 'none' };
const state = { phase: 'running', process: 'running', connection: 'connected', reason: 'fixture', pendingApprovalCount: 0 };
const snapshot = (changes = {}, subjectChanges = {}) => ({ protocol: 'aha.if1', schemaVersion: 1,
  deviceId: 'd-1', publisherEpoch: 'e-1', watermark: 1,
  sessions: [{ subject: { ...subject, ...subjectChanges }, state: { ...state, ...changes } }] });

test('IF-1 maps native permission waiting even without a host approval request', () => {
  const next = projectObservation(session, snapshot({ phase: 'waiting-permission' }));
  assert.equal(next.state, 'waiting'); assert.equal(next.inferred, false);
  assert.equal(projectObservation({ ...session, pid: 22 }, snapshot({ phase: 'waiting-permission', process: 'unknown' })).state, 'waiting');
  assert.equal(projectObservation(session, snapshot({ phase: 'waiting-permission', process: 'unknown' })).state, 'unknown');
});
test('IF-1 turn end is idle; stopping, stale and uncertain process exit remain unknown', () => {
  assert.equal(projectObservation(session, snapshot({ phase: 'idle' })).state, 'idle');
  for (const changes of [{ phase: 'stopping' }, { connection: 'stale' }, { connection: 'disconnected' }, { phase: 'ended' }]) {
    assert.equal(projectObservation(session, snapshot(changes)).state, 'unknown');
  }
  assert.equal(projectObservation(session, snapshot({ phase: 'stopping' })).phase, 'stopping');
  assert.equal(projectObservation(session, snapshot({ phase: 'ended', process: 'exited' })).state, 'done');
  assert.equal(projectObservation({ ...session, pid: 22 }, snapshot({ phase: 'ended', process: 'exited' })).state, 'unknown');
});
test('IF-1 malformed contract, duplicate matches and unknown enums cannot restore inferred activity', () => {
  for (const raw of [{}, { ...snapshot(), schemaVersion: 2 }, snapshot({ pendingApprovalCount: -1 }),
    snapshot({}, { origin: 'new-origin' }), snapshot({}, { taskId: 'task-without-attempt' }),
    snapshot({}, { runtimeId: '' }), snapshot({ phase: 'new-phase' })]) {
    assert.equal(projectObservation(session, raw).state, 'unknown');
  }
  const duplicate = snapshot(); duplicate.sessions.push(duplicate.sessions[0]);
  assert.equal(projectObservation(session, duplicate).state, 'unknown');
});
test('IF-1 preserves stable agent/session identity and ownership boundary', () => {
  assert.equal(projectObservation(session, snapshot({}, { agent: 'codex' })), session);
  assert.equal(projectObservation(session, snapshot({}, { sessionId: 'other' })), session);
  assert.equal(projectObservation(session, snapshot({}, { origin: 'user-adopted', ownership: 'owned' })).state, 'unknown');
  assert.equal(projectObservation(session, null), session, 'no producer means explicitly inferred fallback');
  assert.equal(projectObservation({ ...session, origin: 'unknown', ownership: 'unresolved' }, snapshot()).state, 'unknown');
  assert.equal(projectObservation(session, snapshot({}, { origin: 'station', ownership: 'owned', runtimeId: 'r-1' })).origin, 'station');
});
