import assert from 'node:assert/strict';
import test from 'node:test';

import { authorizeMeetingCommand } from '../dist-electron/meeting-command.js';
import { kickoffTaskPrompt, terminalWorkerBackendFor } from '../dist-electron/orchestrator.js';
import { addBacklog, listBacklog, removeBacklog } from '../dist-electron/backlog.js';

const expert = (owned) => ({ hostId: 'expert-1', role: 'expert', ownsTask: (id) => owned.includes(id) });

test('an expert may message only the sub-agent tasks it owns (AME-D14), nothing else', () => {
  for (const kind of ['send-task-message', 'follow-up-task', 'steer-task']) {
    const own = authorizeMeetingCommand({ kind, taskId: 'kickoff-1', message: '继续' }, expert(['kickoff-1']));
    assert.equal(own.ok, true, kind);
    const other = authorizeMeetingCommand({ kind, taskId: 'task-9', message: '继续' }, expert(['kickoff-1']));
    assert.equal(other.ok, false, kind);
    assert.equal(other.code, 'forbidden');
  }
  // Plans, interrupts and speaking stay with the coordinator (one plan, AME-D17).
  const interrupt = authorizeMeetingCommand({ kind: 'interrupt-task', taskId: 'kickoff-1' }, expert(['kickoff-1']));
  assert.equal(interrupt.ok, false);
  const speak = authorizeMeetingCommand({ kind: 'speak', text: 'hi' }, expert(['kickoff-1']));
  assert.equal(speak.ok, false);
  // An expert with no ownership callback behaves exactly as before.
  const legacy = authorizeMeetingCommand({ kind: 'send-task-message', taskId: 'kickoff-1', message: 'x' }, { hostId: 'e', role: 'expert' });
  assert.equal(legacy.ok, false);
});

test('sub-agents run on the native-CLI twin of the expert backend', () => {
  assert.equal(terminalWorkerBackendFor('claude-code'), 'claude-code-terminal');
  assert.equal(terminalWorkerBackendFor('codex'), 'codex-terminal');
  assert.equal(terminalWorkerBackendFor('kimi'), 'kimi-code-terminal');
  assert.equal(terminalWorkerBackendFor('unknown-backend'), 'unknown-backend');
  const profile = { title: '产品专家', name: '小禾' };
  assert.match(kickoffTaskPrompt('brainstorm', profile), /不要修改任何文件/);
  assert.match(kickoffTaskPrompt('develop', profile), /只改工作树/);
});

test('backlog cards persist, never create Issues unless asked, and can be removed', async () => {
  const before = (await listBacklog()).length;
  const created = await addBacklog({
    cwd: '/tmp/demo-project',
    items: [{ title: '整理首页信息架构', kind: 'work-item', source: '第 3 轮，用户' }, { title: '补 README', kind: 'todo' }],
    createIssues: false,
  });
  assert.equal(created.length, 2);
  assert.equal(created[0].projectName, 'demo-project');
  assert.equal(created.some((c) => c.issueUrl || c.issueError), false);
  assert.equal((await listBacklog()).length, before + 2);
  await removeBacklog(created[0].id);
  assert.equal((await listBacklog()).some((c) => c.id === created[0].id), false);
});

test('a stopped expert sub-agent restarts as a new attempt owned by the same expert', async () => {
  const { Orchestrator } = await import('../dist-electron/orchestrator.js');
  const { randomUUID } = await import('node:crypto');
  const events = [];
  const fake = (opts) => ({ opts, async start() {}, end() {}, sendUserText() {}, sendUserContent() {}, resolvePermission() {}, async interrupt() {} });
  const orchestrator = new Orchestrator({ emit: (e) => events.push(e), cwd: '/tmp', meetingId: `restart-${randomUUID()}`, sessionFactory: fake });
  try {
    const task = { id: 'kickoff-brainstorm-abc', title: '调研项目现状与方向', prompt: '只读调研', deps: [], workspaceMode: 'read-only' };
    assert.deepEqual(await orchestrator.installPlan([task]), { ok: true });
    // startKickoff records these after a real expert host starts; seed them directly.
    orchestrator.taskOwners.set(task.id, 'default');
    orchestrator.ownedTaskInputs.set(task.id, task);

    const first = await orchestrator.restartOwnedTask(task.id);
    assert.deepEqual(first, { ok: true, taskId: 'kickoff-brainstorm-abc-r2' });
    assert.equal(orchestrator.isTaskOwnedBy('kickoff-brainstorm-abc-r2', 'default'), true);
    const second = await orchestrator.restartOwnedTask('kickoff-brainstorm-abc-r2');
    assert.deepEqual(second, { ok: true, taskId: 'kickoff-brainstorm-abc-r3' });

    await new Promise((r) => setTimeout(r, 50));
    const assigned = events.filter((e) => e.event?.kind === 'task-owner-assigned').map((e) => e.event.taskId);
    assert.deepEqual(assigned, ['kickoff-brainstorm-abc-r2', 'kickoff-brainstorm-abc-r3']);
    assert.deepEqual(await orchestrator.restartOwnedTask('not-owned'), { ok: false, error: 'task has no owning expert' });
  } finally {
    await orchestrator.close?.();
  }
});
