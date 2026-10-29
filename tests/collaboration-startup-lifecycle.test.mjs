import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StationService } from '../dist-electron/collaboration/station-service.js';
import { FileTestExecution } from '../dist-electron/collaboration/execution.js';
import { NativeExecution } from '../dist-electron/collaboration/native-helper.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function drain(service) {
  while (service.pendingJobs.size) await Promise.all([...service.pendingJobs]);
}

async function fixture(native = false) {
  const root = await mkdtemp(join(tmpdir(), 'station-startup-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const service = new StationService(join(root, 'profile'));
  await service.storage.load();
  service.localReady = true;
  service.connected = true;
  service.send = async () => ({});
  service.deliverTask = async () => {};
  service.pump = async () => {};
  const task = {
    id: 'owned-task', attemptId: 'owned-attempt', revision: 1,
    projectId: 'owned-project', targetDeviceId: 'owned-device',
    agentId: native ? 'codex' : 'file-test', resource: native ? 'native' : 'directory',
    permission: 'workspace-write', objective: 'isolated lifecycle fixture',
    ...(native ? { nativeSessionId: 'owned-session' } : {}),
  };
  await service.storage.update(state => {
    state.deviceId = task.targetDeviceId;
    state.allowedAgents = [task.agentId];
    state.config.agents = [{ agentId: task.agentId, available: true,
      executionModes: [native ? 'native-session' : 'worker'] }];
    state.directories[task.projectId] = {
      root: workspace, workspaceRoot: workspace, confirmed: true, revision: 1,
      allowedAgentIds: [task.agentId], permission: 'workspace-write',
    };
    state.snapshot.entities = { task: [task] };
    state.receipts[task.id] = {
      taskId: task.id, attemptId: task.attemptId, status: 'received',
      bindingRevision: 1, cwd: workspace, output: [], taskSnapshot: task,
      ...(native ? { nativeBaseline: {} } : {}),
    };
  });
  if (native) service.nativeRows.set(task.nativeSessionId, {
    projectId: task.projectId, cwd: workspace, available: true,
  });
  return { root, workspace, service, task };
}

async function cleanup({ root, service }) {
  await drain(service);
  assert.equal(await service.shutdown(), true);
  await rm(root, { recursive: true, force: true });
}

test('a delayed running event keeps the starting handle visible to a real local stop', async () => {
  const previous = process.env.AHASTATION_ENABLE_TEST_AGENT;
  process.env.AHASTATION_ENABLE_TEST_AGENT = '1';
  const context = await fixture();
  const { service, task, workspace } = context;
  const entered = deferred(), release = deferred();
  const originalRun = FileTestExecution.prototype.run;
  const originalStop = FileTestExecution.prototype.stop;
  let runs = 0, stops = 0, started;
  FileTestExecution.prototype.run = function (...args) { runs++; return originalRun.apply(this, args); };
  FileTestExecution.prototype.stop = function (...args) { stops++; return originalStop.apply(this, args); };
  const taskEvent = service.taskEvent.bind(service);
  service.taskEvent = async (...args) => {
    if (args[1] === 'running') { entered.resolve(); await release.promise; }
    return taskEvent(...args);
  };
  try {
    started = service.startTask(task, service.storage.read().receipts[task.id]);
    await entered.promise;
    assert.ok(service.active.has(task.id + ':' + task.attemptId));
    await service.stopLocal(task);
    assert.equal(stops, 1, 'stop must reach the already owned handle before run starts');
    assert.equal(runs, 0);
    release.resolve();
    await started;
    await drain(service);
    assert.equal(runs, 0);
    assert.equal(service.active.size, 0);
    assert.equal(service.slots.size, 0);
    const receipt = service.storage.read().receipts[task.id];
    assert.equal(receipt.executionInvoked, false);
    assert.equal(receipt.exitConfirmed, true);
    assert.equal(receipt.turnOutcome, 'interrupted');
    await assert.rejects(stat(join(workspace, 'delivery.txt')), { code: 'ENOENT' });
  } finally {
    release.resolve();
    await started;
    await drain(service);
    FileTestExecution.prototype.run = originalRun;
    FileTestExecution.prototype.stop = originalStop;
    if (previous === undefined) delete process.env.AHASTATION_ENABLE_TEST_AGENT;
    else process.env.AHASTATION_ENABLE_TEST_AGENT = previous;
    await cleanup(context);
  }
});

for (const caller of ['recovery', 'free conversation']) {
  test(`a completed native handle is not registered again by ${caller}`, async () => {
    const context = await fixture(true);
    const { service, task } = context;
    const originalRun = NativeExecution.prototype.run;
    const originalClose = NativeExecution.prototype.close;
    let runs = 0, closes = 0;
    NativeExecution.prototype.run = async function () {
      runs++;
      assert.equal(service.active.size, 1, 'ownership precedes execution');
      return { summary: 'local fixture completed', stopped: false,
        exitConfirmed: true, turnOutcome: 'completed', contentComplete: true };
    };
    NativeExecution.prototype.close = function () { closes++; originalClose.call(this); };
    const start = service.startTask.bind(service);
    service.startTask = async (...args) => {
      const result = await start(...args);
      // Exercise the caller boundary after the genuine execution has finished.
      // This deliberate scheduling seam does not claim normal scheduling is slow.
      await drain(service);
      assert.equal(service.active.size, 0);
      return result;
    };
    try {
      if (caller === 'recovery') {
        service.helper = async request => {
          assert.equal(request.operation, 'reconcile');
          return { known: true, turnId: 'owned-turn' };
        };
        await service.recoverReceipt(service.storage.read().receipts[task.id]);
      } else {
        await service.freeNative({ id: task.id, nativeSessionId: task.nativeSessionId,
          text: task.objective, meetingId: 'owned-meeting' });
      }
      assert.equal(runs, 1);
      assert.equal(closes, 1);
      assert.equal(service.active.size, 0);
      assert.equal(service.slots.size, 0);
      assert.equal(service.storage.read().receipts[task.id].turnOutcome, 'completed');
    } finally {
      await drain(service);
      NativeExecution.prototype.run = originalRun;
      NativeExecution.prototype.close = originalClose;
      await cleanup(context);
    }
  });
}
