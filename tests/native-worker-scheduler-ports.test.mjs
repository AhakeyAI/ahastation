// Scheduler seam regression; OS enforcement is exercised by accept-native-worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerScheduler } from '../dist-electron/worker-scheduler.js';
import { compileTaskAuthority } from '../dist-electron/task-authority.js';

test('native approvals use current captured attempt, one UI resolution and existing journal', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'aha-native-ports-')), events = [], decisions = [];
  let closed = false;
  const scheduler = new WorkerScheduler({ cwd, emit: e => events.push(e), autoApproveScope: 'off',
    sessionFactory: () => ({ async start() {}, end() {}, sendUserText() {}, sendUserContent() {}, resolvePermission() {}, async interrupt() {} }),
    buildWorkerMcp: () => ({}), getTalker: () => null, isClosed: () => closed, getSpeechFilterMode: () => 'off',
    persistPermissionDecision: async input => { decisions.push(input); }, flushEvents: async () => {},
  });
  t.after(() => { closed = true; scheduler.endAll(); rmSync(cwd, { recursive: true, force: true }); });
  const { workerId } = scheduler.delegateSingleTask('inspect isolated fixture');
  await new Promise(resolve => setTimeout(resolve, 30));
  const handle = scheduler.workers.get(workerId); assert.equal(handle.status, 'running');
  handle.authorityGrant = compileTaskAuthority(workerId, handle.attempt, 1, 'local-approved-plan', cwd,
    { writePaths: [], toolKinds: ['write'], commands: [], workingDirectories: ['.'], environmentKeys: [], networkHosts: [], maxCommandTimeoutMs: 1000 }, Date.now());
  const ports = scheduler.nativeAuthorityPorts(handle, handle.attempt);
  const controller = new AbortController();
  const request = { id: 'native-once', call: { invocationId: 'call', toolName: 'Write', input: { file_path: 'file.txt', content: 'data' } }, basis: {}, digest: 'digest' };
  const answer = ports.askUser(request, controller.signal);
  assert.equal(events.at(-1).event.input.approvalScope, 'once');
  scheduler.resolvePermissionInAny(request.id, 'allow', undefined, 'task-wide');
  assert.equal(await answer, 'allow'); assert.equal(handle.authorityAddendum, undefined);
  await ports.persistPermissionDecision({ taskId: workerId, attempt: handle.attempt, nativeRequestId: request.id, decision: 'allow', reason: 'once', safeInput: {} });
  assert.equal(decisions.length, 1);
  const cancelled = ports.askUser({ ...request, id: 'cancelled' }, controller.signal); controller.abort(); assert.equal(await cancelled, 'deny');
  await assert.rejects(ports.onReport({ status: 'partial', summary: 'candidate', files: [], tests: [], unresolved: [] }, 'receipt'), /unavailable/);
  handle.attempt++;
  assert.equal(ports.isCurrentAttempt(), false);
  await assert.rejects(ports.onReport({ status: 'completed' }, 'receipt'), /unavailable/);
  await assert.rejects(ports.persistPermissionDecision({}), /unavailable/);
});
