import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Orchestrator } from '../dist-electron/orchestrator.js';
import { getBackendRegistry, resetBackendRegistry } from '../dist-electron/backends/registry.js';

// ask_host is fire-and-forget: the Coordinator has no way to know whether the
// expert ever replied. These tests pin the watchdog that nudges the
// Coordinator after a timeout, and clears when the expert answers.

function fakeRuntimeBinary() {
  const dir = mkdtempSync(join(tmpdir(), 'ahastation-host-ask-runtime-'));
  const binary = join(dir, 'runtime.cjs');
  writeFileSync(binary, `'use strict';\nconsole.log('2.1.150');\n`);
  return { dir, binary };
}

/** Minimal backend: resolveBinary so addHost's gate passes. The sessionFactory
 *  opt overrides createSession, so no real subprocess is spawned. */
function makeBackend(binaryPath) {
  return {
    id: 'claude-code',
    capabilities: { coordinate: true, executeTasks: true, defaultModel: 'claude-haiku-4-5' },
    resolveBinary: () => binaryPath,
    buildEnv: (_auth, extra) => extra,
    async validateAuth() { return { ok: true }; },
    async checkAuthStatus() { return { loggedIn: true }; },
  };
}

function makeSessionFactory(sessions) {
  return (options) => {
    const session = {
      options,
      // options.emit is the HostGroup onHostEvent callback; keep a handle so a
      // test can inject a talker message (simulating an expert reply).
      emit: options.emit,
      inputs: [],
      resourceWaits: [],
      beginResourceWait() { this.resourceWaits.push({ start: Date.now(), end: null }); },
      endResourceWait() { this.resourceWaits.at(-1).end = Date.now(); },
      isWaitingForResources() { return this.resourceWaits.at(-1)?.end === null; },
      resourceWaitTimeSince(timestamp) {
        return this.resourceWaits.reduce((total, wait) => (
          total + Math.max(0, (wait.end ?? Date.now()) - Math.max(timestamp, wait.start))
        ), 0);
      },
      async start() {},
      end() {},
      sendUserText(text) { this.inputs.push(text); },
      sendUserContent() {},
      resolvePermission() {},
      async interrupt() {},
      snapshot() {
        return { protocol: 'claude-cli', sessionId: `s-${sessions.length + 1}`, backendVersion: '2.1.150' };
      },
    };
    sessions.push(session);
    return session;
  };
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function findStalledBriefing(events) {
  return events.find((e) => (
    e.event?.kind === 'coordinator-briefing'
    && e.event.briefing?.kind === 'stalled'
    && Array.isArray(e.event.briefing.blockers)
    && e.event.briefing.blockers.includes('host-ask-timeout')
  ));
}

test('an unanswered ask_host times out and nudges the Coordinator', async () => {
  const runtime = fakeRuntimeBinary();
  const sessions = [];
  const events = [];
  const cwd = mkdtempSync(join(tmpdir(), 'host-ask-timeout-'));
  const meetingId = `host-ask-${randomUUID()}`;
  resetBackendRegistry();
  getBackendRegistry().register(makeBackend(runtime.binary));
  const orch = new Orchestrator({
    emit(event) { events.push(event); },
    cwd,
    meetingId,
    sessionFactory: makeSessionFactory(sessions),
    hostAskTimeoutMs: 40,
  });
  try {
    await orch.start();
    const coordinator = sessions[0];
    assert.ok(coordinator, 'coordinator host session was not created');
    assert.equal(orch.addHost('claude-code', 'expert').ok, true);
    await waitFor(
      () => events.some((e) => e.event?.kind === 'session-ready' && e.hostId === 'expert'),
      'expert host did not become ready',
    );

    assert.equal((await orch.executeMeetingCommand('default', {
      kind: 'ask-host',
      hostId: 'expert',
      question: 'should we ship?',
    })).ok, true);

    await waitFor(
      () => findStalledBriefing(events),
      'Coordinator was not nudged about the unanswered ask_host',
    );
    assert.ok(
      coordinator.inputs.some((text) => text.includes('长时间未回复')),
      'the Coordinator talker received the stall nudge',
    );
  } finally {
    await orch.end();
    resetBackendRegistry();
    rmSync(runtime.dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('an expert reply before the timeout clears the ask_host watchdog', async () => {
  const runtime = fakeRuntimeBinary();
  const sessions = [];
  const events = [];
  const cwd = mkdtempSync(join(tmpdir(), 'host-ask-reply-'));
  const meetingId = `host-ask-reply-${randomUUID()}`;
  resetBackendRegistry();
  getBackendRegistry().register(makeBackend(runtime.binary));
  const orch = new Orchestrator({
    emit(event) { events.push(event); },
    cwd,
    meetingId,
    sessionFactory: makeSessionFactory(sessions),
    hostAskTimeoutMs: 40,
  });
  try {
    await orch.start();
    assert.equal(orch.addHost('claude-code', 'expert').ok, true);
    await waitFor(
      () => events.some((e) => e.event?.kind === 'session-ready' && e.hostId === 'expert'),
      'expert host did not become ready',
    );
    const expert = sessions[1];
    assert.ok(expert, 'expert host session was not created');

    assert.equal((await orch.executeMeetingCommand('default', {
      kind: 'ask-host',
      hostId: 'expert',
      question: 'should we ship?',
    })).ok, true);

    // Expert replies before the 40ms timer fires.
    expert.emit({
      kind: 'message',
      message: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'yes, ship it' }] },
        parent_tool_use_id: null,
        session_id: 'expert-1',
      },
    });

    // Wait past the timeout window.
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(
      findStalledBriefing(events),
      undefined,
      'a replied ask must not raise a host-ask-timeout briefing',
    );
  } finally {
    await orch.end();
    resetBackendRegistry();
    rmSync(runtime.dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

function admissionClock() {
  const waits = [];
  return {
    begin() { waits.push({ start: Date.now(), end: null }); },
    end() { waits.at(-1).end = Date.now(); },
    isWaitingForResources() { return waits.at(-1)?.end === null; },
    resourceWaitTimeSince(since) {
      return waits.reduce((total, wait) => total
        + Math.max(0, (wait.end ?? Date.now()) - Math.max(since, wait.start)), 0);
    },
  };
}

test('ask watchdog preserves the active timeout budget across an admission wait', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const host = admissionClock();
  const stalled = [];
  const orch = Object.assign(Object.create(Orchestrator.prototype), {
    closed: false,
    hostAskTimeoutMs: 100,
    pendingHostAsks: new Map(),
    hostGroups: new Map([['expert', { getHost: () => host }]]),
    notifyHostAskStalled: (...args) => stalled.push(args),
  });
  orch.trackHostAsk('expert', 'question');
  t.mock.timers.tick(20);
  host.begin();
  t.mock.timers.tick(200);
  assert.equal(stalled.length, 0);
  host.end();
  t.mock.timers.tick(79);
  assert.equal(stalled.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(stalled, [['expert', 'question']]);
  assert.equal(orch.pendingHostAsks.size, 0);
});

test('ask reply and replacement cancel a watchdog that re-armed during admission', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const host = admissionClock();
  const stalled = [];
  const orch = Object.assign(Object.create(Orchestrator.prototype), {
    closed: false,
    hostAskTimeoutMs: 100,
    pendingHostAsks: new Map(),
    hostGroups: new Map([['expert', { getHost: () => host }]]),
    notifyHostAskStalled: (...args) => stalled.push(args),
  });
  host.begin();
  orch.trackHostAsk('expert', 'old');
  t.mock.timers.tick(200);
  orch.trackHostAsk('expert', 'new');
  host.end();
  t.mock.timers.tick(99);
  assert.equal(stalled.length, 0);
  orch.clearHostAsk('expert');
  t.mock.timers.tick(1000);
  assert.equal(stalled.length, 0);
});

test('Coordinator review stall budget excludes both current and completed admission waits', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const host = admissionClock();
  const charged = [];
  const orch = Object.assign(Object.create(Orchestrator.prototype), {
    closed: false,
    coordinatorHostId: 'default',
    reviewStallTimeoutMs: 100,
    hostGroups: new Map([['default', { getHost: () => host }]]),
    coordinatorReviewDriver: {
      activeSessions: () => [{ id: 'review', updatedAt: 1000 }],
      onCoordinatorTurnEnded: async (id) => charged.push(id),
    },
    reviewsAwaitingFirstTurn: new Set(['review']),
  });
  now += 40;
  host.begin();
  now += 500;
  await orch.sweepStalledReviews();
  assert.equal(charged.length, 0);
  assert.equal(orch.reviewsAwaitingFirstTurn.has('review'), true);
  host.end();
  now += 59;
  await orch.sweepStalledReviews();
  assert.equal(charged.length, 0);
  now++;
  await orch.sweepStalledReviews();
  assert.deepEqual(charged, ['review']);
  assert.equal(orch.reviewsAwaitingFirstTurn.has('review'), false);
});
