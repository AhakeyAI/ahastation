import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { authorizeMeetingCommand } from '../dist-electron/meeting-command.js';
import { Orchestrator } from '../dist-electron/orchestrator.js';
import { PORTABLE_MEETING_COMMAND_PROMPT } from '../dist-electron/orchestrator-prompts.js';
import { getBackendRegistry, resetBackendRegistry } from '../dist-electron/backends/registry.js';

// N5095 D1 (2026-11-03): a Codex Host guessed the request-decision fields
// (title / deadline / calendarReminder). The command was rejected, the
// rejection never reached the Host, and no decision doc or .ics was written.

const CODEX_GUESS = {
  kind: 'request-decision',
  title: '发布时间决策',
  question: '请选择发布方案：',
  options: [{ id: 'A', label: '现在发布' }, { id: 'B', label: '修复后发布' }],
  deadline: '2026-11-05T17:00:00+08:00',
  calendarReminder: { title: '决定发布方案', time: '2026-11-05T17:00:00+08:00' },
};

const coordinator = { hostId: 'default', role: 'coordinator' };

test('the portable protocol example for request-decision passes validation', () => {
  const frames = [...PORTABLE_MEETING_COMMAND_PROMPT.matchAll(/```meeting-command\n([\s\S]*?)```/g)]
    .map((match) => JSON.parse(match[1]));
  const decision = frames.find((frame) => frame.kind === 'request-decision');
  assert.ok(decision, 'the prompt teaches request-decision with an example');
  const result = authorizeMeetingCommand(decision, coordinator);
  assert.equal(result.ok, true, result.error);
  for (const frame of frames) {
    assert.equal(authorizeMeetingCommand(frame, coordinator).ok, true, `${frame.kind} example is valid`);
  }
});

test('a rejected command names the fields to fix', () => {
  const result = authorizeMeetingCommand(CODEX_GUESS, coordinator);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-command');
  assert.match(result.error, /^Unrecognized keys: "title", "deadline", "calendarReminder"/);
  assert.match(result.error, /deadlineMs: /);
  assert.match(result.error, /options\.0\.title: /);
});

function fakeRuntimeBinary() {
  const dir = mkdtempSync(join(tmpdir(), 'ahastation-text-command-runtime-'));
  const binary = join(dir, 'runtime.cjs');
  writeFileSync(binary, `'use strict';\nconsole.log('2.1.150');\n`);
  return { dir, binary };
}

function makeBackend(binaryPath, id = 'claude-code') {
  return {
    id,
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
      inputs: [],
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

test('a text-protocol Host hears why its command was rejected, a bounded number of times', async () => {
  const runtime = fakeRuntimeBinary();
  const sessions = [];
  const cwd = mkdtempSync(join(tmpdir(), 'text-command-feedback-'));
  resetBackendRegistry();
  getBackendRegistry().register(makeBackend(runtime.binary));
  const orch = new Orchestrator({
    emit() {},
    cwd,
    meetingId: `text-command-${randomUUID()}`,
    sessionFactory: makeSessionFactory(sessions),
  });
  try {
    await orch.start();
    const host = sessions[0];
    assert.ok(host, 'coordinator host session was not created');

    const result = await orch.executeTextMeetingCommand('default', CODEX_GUESS);
    assert.equal(result.ok, false);
    const notes = () => host.inputs.filter((text) => text.startsWith('(meeting-command result)'));
    assert.equal(notes().length, 1);
    assert.match(notes()[0], /request-decision 被拒绝（invalid-command）/);
    assert.ok(notes()[0].includes(result.error));

    for (let i = 0; i < 5; i += 1) await orch.executeTextMeetingCommand('default', CODEX_GUESS);
    assert.equal(notes().length, 3, 'a looping Host is not fed rejections forever');

    // A valid command resets the budget.
    assert.equal((await orch.executeTextMeetingCommand('default', { kind: 'speak', text: '好的' })).ok, true);
    await orch.executeTextMeetingCommand('default', CODEX_GUESS);
    assert.equal(notes().length, 4);
  } finally {
    await orch.end();
    resetBackendRegistry();
    rmSync(runtime.dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a Codex Host that claims a Worker it never sent is told to correct itself', async () => {
  const runtime = fakeRuntimeBinary();
  const sessions = [];
  const cwd = mkdtempSync(join(tmpdir(), 'text-command-claim-'));
  resetBackendRegistry();
  getBackendRegistry().register(makeBackend(runtime.binary, 'codex'));
  const orch = new Orchestrator({
    emit() {},
    cwd,
    meetingId: `text-command-claim-${randomUUID()}`,
    defaultBackendId: 'codex',
    sessionFactory: makeSessionFactory(sessions),
  });
  try {
    await orch.start();
    const host = sessions[0];
    assert.ok(host, 'coordinator host session was not created');
    const reply = (text) => {
      host.options.emit({ kind: 'message', message: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } } });
      host.options.emit({ kind: 'turn-status', status: 'completed' });
    };
    const notes = () => host.inputs.filter((text) => text.startsWith('(meeting-command result)'));

    // N5095 (2026-11-04): no command, no Worker, yet the user heard both.
    reply('我已经派出 Worker 去实际操作记事本，等它回报结果。');
    assert.equal(notes().length, 1);
    assert.match(notes()[0], /没有派工/);
    assert.ok(notes()[0].includes('「我已经派出 Worker 去实际操作记事本，等它回报结果」'));

    // Its correction repeats the claim; that turn is not flagged again.
    reply('更正：我刚才说已经派出 Worker，这不成立。');
    reply('好的，我们先讨论方案。');
    assert.equal(notes().length, 1);

    // A claim backed by real Worker activity is left alone.
    orch['onHostGroupEvent']('default', {
      source: 'talker',
      event: { kind: 'worker-ended', workerId: 'w1', status: 'completed', summary: '记事本已打开' },
    });
    reply('Worker 已确认记事本打开了。');
    assert.equal(notes().length, 1);
  } finally {
    // The replies above make a transcript; stop the end-of-meeting recap
    // before the folder it writes minutes into is removed.
    const ended = orch.end();
    await orch.interrupt();
    await ended;
    await orch.recapDonePromise();
    resetBackendRegistry();
    rmSync(runtime.dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
