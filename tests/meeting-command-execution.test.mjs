import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ipcMain } from 'electron';

import { MeetingRepository } from '../dist-electron/meeting-repository.js';
import { Orchestrator } from '../dist-electron/orchestrator.js';
import { registerSessionIpc } from '../dist-electron/ipc/session.js';
import { planMeetingArgsSchema } from '../dist-electron/meeting-tools.js';
import { testMeetingsPath } from './electron-stub-impl.mjs';

function fakeSessionFactory(opts) {
  return {
    opts,
    async start() {},
    end() {},
    sendUserText() {},
    sendUserContent() {},
    resolvePermission() {},
    async interrupt() {},
  };
}

test('approval IPC accepts every supported proposal size and rejects plans above the limit', async () => {
  const originalHandle = ipcMain.handle;
  const handlers = new Map();
  ipcMain.handle = (name, handler) => handlers.set(name, handler);
  try {
    for (const count of [21, 100]) {
      const meetingId = randomUUID();
      const cwd = await mkdtemp(join(tmpdir(), 'plan-approval-size-'));
      const events = [];
      const orchestrator = new Orchestrator({
        emit: (event) => events.push(event.event), cwd, meetingId, sessionFactory: fakeSessionFactory,
      });
      try {
        const tasks = Array.from({ length: count }, (_, index) => ({
          id: `task-${index}`, title: `Task ${index}`, prompt: 'write the assigned note',
          deps: index ? ['task-0'] : [], workspaceMode: 'shared-locked', writePaths: [`notes/${index}.txt`],
        }));
        const proposed = await orchestrator.executeMeetingCommand('default', { kind: 'propose-plan', tasks });
        assert.equal(proposed.ok, true, proposed.error);
        await orchestrator.replayMeetingJournal();
        const proposal = events.find((event) => event.kind === 'plan-proposed');
        assert.equal(proposal.tasks.length, count);
        registerSessionIpc({ registry: { resolve: (id) => id === meetingId ? { orchestrator } : undefined } });
        const approve = handlers.get('session:approve-plan');
        const payload = {
          sessionId: meetingId, approved: true, tasks: proposal.tasks, brief: proposal.brief,
          identity: { proposalId: proposal.proposalId, proposalVersion: proposal.proposalVersion, approvalCommandId: randomUUID() },
        };
        assert.deepEqual(await approve({}, payload), { ok: true });
        await orchestrator.replayMeetingJournal();
        assert.equal(events.filter((event) => event.kind === 'plan-updated').at(-1).plan.nodes.length, count);
        if (count === 100) {
          const oversized = [...tasks, { ...tasks[0], id: 'extra' }];
          assert.equal(planMeetingArgsSchema.tasks.safeParse(oversized).success, false);
          assert.equal((await orchestrator.executeMeetingCommand('default', { kind: 'propose-plan', tasks: oversized })).ok, false);
          assert.deepEqual(await approve({}, { ...payload, tasks: [...proposal.tasks, proposal.tasks[0]] }),
            { ok: false, error: 'invalid revised plan' });
          assert.deepEqual(await approve({}, { ...payload, tasks: [] }),
            { ok: false, error: 'invalid revised plan' });
        }
        const journal = await orchestrator.replayMeetingJournal();
        assert.equal(journal.filter((entry) => entry.type === 'plan-authority-approved').length, 1);
      } finally {
        await orchestrator.end();
        await rm(testMeetingsPath(meetingId), { recursive: true, force: true });
        await rm(cwd, { recursive: true, force: true });
      }
    }
  } finally {
    ipcMain.handle = originalHandle;
  }
});

test('Coordinator applies a versioned running-plan revision and journals it', async () => {
  const meetingId = `plan-revision-${randomUUID()}`;
  const cwd = await mkdtemp(join(tmpdir(), 'native-plan-revision-'));
  const orchestrator = new Orchestrator({
    emit() {},
    cwd,
    meetingId,
    sessionFactory: fakeSessionFactory,
  });
  try {
    assert.deepEqual(await orchestrator.installPlan([
      { id: 'active', title: 'Active', prompt: 'write a note', deps: [], workspaceMode: 'shared-locked', writePaths: ['active'] },
      { id: 'obsolete', title: 'Obsolete', prompt: 'write a note', deps: ['active'], workspaceMode: 'shared-locked', writePaths: ['obsolete'] },
      { id: 'replacement', title: 'Replacement', prompt: 'write a note', deps: ['obsolete'], workspaceMode: 'shared-locked', writePaths: ['replacement'] },
    ]), { ok: true });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(await orchestrator.executeMeetingCommand('default', {
      kind: 'revise-plan',
      expectedPlanVersion: 1,
      reason: 'replace the pending follow-up',
      operations: [
        { kind: 'cancel-pending-task', taskId: 'obsolete' },
        {
          kind: 'update-task',
          taskId: 'replacement',
          deps: ['active'],
        },
      ],
    }), { ok: true, value: { planVersion: 2 } });

    const stale = await orchestrator.executeMeetingCommand('default', {
      kind: 'revise-plan',
      expectedPlanVersion: 1,
      reason: 'stale retry',
      operations: [{
        kind: 'cancel-pending-task', taskId: 'replacement',
      }],
    });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /stale plan version/);

    const journal = await MeetingRepository.replay(meetingId);
    const revisions = journal.filter((entry) => entry.type === 'plan-revised-by-coordinator');
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].payload.planVersion, 2);
  } finally {
    await orchestrator.end();
    await rm(`${testMeetingsPath(meetingId)}`, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
