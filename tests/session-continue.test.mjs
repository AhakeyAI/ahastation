// session-continue.test.mjs — 看板「查看/继续」 maps an observed session to a
// fork or resume launch per CLI, and only ends terminal-owned originals.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  endObservedSession,
  initialPromptArgs,
  parseKimiForkOutput,
  resolveContinueLaunch,
} from '../dist-electron/session-continue.js';

const session = (over) => ({
  id: 'obs-1', clientKind: 'claude-code', nativeSessionId: 'abc-123', cwd: '/repo/wt', pid: 4242, tty: 'ttys003',
  state: 'active', isNoise: false, ...over,
});
const snap = (...sessions) => ({ sessions, scannedAt: 0 });

test('claude forks under a fresh session id so the original stays attributed', async () => {
  const res = await resolveContinueLaunch('obs-1', 'fork', snap(session()), { newUuid: () => 'new-uuid' });
  assert.deepEqual(res, { ok: true, launch: { cliId: 'claude', cwd: '/repo/wt',
    args: ['--resume', 'abc-123', '--fork-session', '--session-id', 'new-uuid'] } });
  const resume = await resolveContinueLaunch('obs-1', 'resume', snap(session()));
  assert.deepEqual(resume.ok && resume.launch.args, ['--resume', 'abc-123']);
});

test('codex uses fork / resume subcommands', async () => {
  const s = session({ clientKind: 'codex' });
  assert.deepEqual((await resolveContinueLaunch('obs-1', 'fork', snap(s))).launch.args, ['fork', 'abc-123']);
  assert.deepEqual((await resolveContinueLaunch('obs-1', 'resume', snap(s))).launch.args, ['resume', 'abc-123']);
});

test('kimi forks first, then opens the new session interactively', async () => {
  const s = session({ clientKind: 'kimi', nativeSessionId: 'session_old' });
  const calls = [];
  const res = await resolveContinueLaunch('obs-1', 'fork', snap(s), {
    kimiFork: async (cwd, id) => { calls.push([cwd, id]); return 'session_new'; },
  });
  assert.deepEqual(calls, [['/repo/wt', 'session_old']]);
  assert.deepEqual(res.launch.args, ['--session', 'session_new']);
  const failed = await resolveContinueLaunch('obs-1', 'fork', snap(s), { kimiFork: async () => { throw new Error('boom'); } });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /boom/);
});

test('kimi fork output is parsed for the new id', () => {
  assert.equal(parseKimiForkOutput('Forked to session_e1f5713d-b4ae-4405 ("Fork: x") in 653ms'), 'session_e1f5713d-b4ae-4405');
  assert.equal(parseKimiForkOutput('error: not found'), null);
});

test('unknown or id-less sessions are refused', async () => {
  assert.equal((await resolveContinueLaunch('missing', 'fork', snap(session()))).ok, false);
  assert.equal((await resolveContinueLaunch('obs-1', 'fork', snap(session({ nativeSessionId: '' })))).ok, false);
});

test('only terminal-owned originals are ended; a gone process counts as ended', () => {
  const killed = [];
  assert.deepEqual(endObservedSession('obs-1', snap(session()), { kill: (pid) => killed.push(pid) }), { ok: true });
  assert.deepEqual(killed, [4242]);
  const desktop = endObservedSession('obs-1', snap(session({ tty: '??' })), { kill: () => assert.fail('must not kill') });
  assert.equal(desktop.ok, false);
  const gone = endObservedSession('obs-1', snap(session()), {
    kill: () => { const err = new Error('gone'); err.code = 'ESRCH'; throw err; },
  });
  assert.deepEqual(gone, { ok: true });
});

test('first prompt goes only to CLIs that accept it, never as a flag', () => {
  assert.deepEqual(initialPromptArgs('claude', '  修复登录  '), ['修复登录']);
  assert.deepEqual(initialPromptArgs('codex', '--help me'), ['任务：--help me']);
  assert.deepEqual(initialPromptArgs('kimi', '修复登录'), []);
  assert.deepEqual(initialPromptArgs('claude', '   '), []);
  assert.deepEqual(initialPromptArgs(undefined, 'x'), []);
});
