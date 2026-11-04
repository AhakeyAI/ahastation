import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultNativeWorkerBackendId, nativeWorkerBackendId } from '../dist-electron/worker-backend-policy.js';
import { normalizePlanMeetingTask } from '../dist-electron/meeting-tools.js';
import { authorizeMeetingCommand } from '../dist-electron/meeting-command.js';
import { Orchestrator } from '../dist-electron/orchestrator.js';

test('local default and legacy preferences always select native Workers independently of the Host', () => {
  assert.equal(defaultNativeWorkerBackendId('codex'), 'codex-terminal');
  assert.equal(defaultNativeWorkerBackendId('claude-code'), 'claude-code-terminal');
  assert.equal(defaultNativeWorkerBackendId('kimi'), 'codex-terminal');
  assert.equal(defaultNativeWorkerBackendId('codex', 'claude-code'), 'claude-code-terminal');
  assert.equal(defaultNativeWorkerBackendId('claude-code', 'codex-terminal'), 'codex-terminal');
  assert.throws(() => nativeWorkerBackendId('opencode'), /unsupported-contract/);
});

const task = { id: 'audit', title: 'Audit', prompt: 'Audit the project without changing files.', workspaceMode: 'read-only' };
const options = { nativeCliWorkers: true };

test('old SDK plans normalize both route and profile without relaxing their read-only scope', () => {
  const result = normalizePlanMeetingTask({ ...task, executorBackendId: 'codex', executionProfile: {
    schemaVersion: 1, backendId: 'codex-terminal', workMode: 'balanced', contextMode: 'minimal',
    timeoutMs: 30_000, maxTokenBudget: 1000,
  } }, 'claude-code-terminal', options).task;
  assert.equal(result.executorBackendId, 'codex-terminal');
  assert.equal(result.executionProfile.backendId, 'codex-terminal');
  assert.equal(result.workspaceMode, 'read-only');
  assert.deepEqual(result.authorityRequest.writePaths, []);
  assert.throws(() => normalizePlanMeetingTask({ ...task, executorBackendId: 'opencode' }, 'codex-terminal', options), /unsupported-contract/);
});

test('portable Host plans use the same native route as MCP plans', () => {
  const result = authorizeMeetingCommand({ kind: 'propose-plan', goal: 'Audit', tasks: [{ ...task, executorBackendId: 'codex' }] },
    { hostId: 'default', role: 'coordinator' }, { ...options, defaultBackendId: 'codex-terminal' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.command.tasks[0].executionProfile.backendId, 'codex-terminal');
});

test('execution gate rejects unnormalized SDK routes and preserves unsupported read-only rejection', async () => {
  const context = { defaultWorkerBackendId: () => 'codex-terminal' };
  const gate = Orchestrator.prototype.validateExecutionBackends;
  assert.match(await gate.call(context, [{ executorBackendId: 'codex', workspaceMode: 'git-worktree' }]), /必须使用本地原生 CLI/);
  assert.match(await gate.call(context, [{ executorBackendId: 'codex-terminal', workspaceMode: 'read-only' }]), /unsupported-contract.*read-only/);
  assert.throws(() => Orchestrator.prototype.buildSessionFactory.call({}, 'codex', 'default', 'worker'), /必须使用本地原生 CLI/);
});

test('follow-ups and rework overrides cannot silently start an SDK Worker', async () => {
  const seen = [];
  const context = { meetingScheduler: {
    sendTaskMessage: async (...args) => { seen.push(args); return { id: 'm1', status: 'queued' }; },
    queueFollowUp: async (...args) => { seen.push(args); return { id: 'm2', status: 'queued' }; },
  } };
  await Orchestrator.prototype.sendTaskMessage.call(context, 'audit', 'more context', 'codex');
  await Orchestrator.prototype.queueTaskFollowUp.call(context, 'audit', 'continue', 'claude-code');
  assert.equal(seen[0][2], 'codex-terminal');
  assert.equal(seen[1][2], 'claude-code-terminal');
  await assert.rejects(() => Orchestrator.prototype.queueTaskFollowUp.call(context, 'audit', 'continue', 'opencode'), /unsupported-contract/);
  assert.equal(seen.length, 2);
});
