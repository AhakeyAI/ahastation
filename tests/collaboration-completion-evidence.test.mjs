import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {StationService} from '../dist-electron/collaboration/station-service.js';
import {git, prepareRepository, deliverRepository} from '../dist-electron/collaboration/workspaces.js';

test('K01: legacy receipts never publish without exact completion evidence; explicit completion is idempotent', {timeout:120000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'station-completion-'));
  const previous = {GIT_SSH_COMMAND:process.env.GIT_SSH_COMMAND, GIT_SSH_VARIANT:process.env.GIT_SSH_VARIANT};
  const repo = join(root, 'repo'), bare = join(root, 'remote.git'), work = join(root, 'work');
  const evidence = [];
  try {
    for (const path of [repo, bare, work]) await mkdir(path);
    await git(bare, ['init', '--bare']);
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['config', 'user.name', 'Completion Fixture']);
    await git(repo, ['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(repo, 'base.txt'), 'original\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'baseline']);
    const base = await git(repo, ['rev-parse', 'HEAD']);
    const transport = join(root, 'transport.mjs'), transfers = join(root, 'transfers.jsonl');
    // Every transport is redirected to this owned bare repository. No socket,
    // GitHub CLI or actual PR endpoint can be reached by this fixture.
    await writeFile(transport, `import {spawn} from 'node:child_process';import {appendFileSync} from 'node:fs';
const mode=process.argv.some(a=>a.includes('git-receive-pack'))?'receive-pack':'upload-pack';
appendFileSync(${JSON.stringify(transfers)},JSON.stringify(mode)+'\\n');
const child=spawn('git',[mode,${JSON.stringify(bare)}],{stdio:'inherit'});child.on('exit',c=>process.exit(c??1));`);
    process.env.GIT_SSH_COMMAND = '"' + process.execPath.replaceAll('\\', '/') + '" "' + transport.replaceAll('\\', '/') + '"';
    process.env.GIT_SSH_VARIANT = 'ssh';
    await git(repo, ['remote', 'add', 'origin', 'git@github.com:completion-fixture/materials.git']);
    await git(repo, ['push', 'origin', 'HEAD:refs/heads/codex/station-meeting-m']);
    let serial = 0;
    for (const status of ['executed', 'delivery-pending']) {
      for (const outcome of [undefined, 'unknown', 'failed', 'interrupted', 'completed']) {
        await t.test(status + '/' + (outcome ?? 'missing'), async () => {
          const id = 'task-' + serial++, profile = join(root, id);
          const cwd = await prepareRepository(repo, work, id, base);
          await writeFile(join(cwd, 'partial.txt'), 'user partial retained\n');
          let s = new StationService(profile), prs = 0, models = 0, checks = 0;
          const sent = [];
          const task = {id, revision:1, meetingId:'m', attemptId:'attempt-' + id, targetDeviceId:'A', agentId:'codex', projectId:'p', resource:'repository', permission:'workspace-write', baseCommit:base, status, retryDelivery:'retry', stopRequested:false, inputs:[], dependencies:[]};
          await s.storage.load();
          await s.storage.update(state => {
            state.deviceId = 'A'; state.allowedAgents = ['codex'];
            state.bindings.p = {projectId:'p', deviceId:'A', confirmed:true, revision:1, allowedAgentIds:['codex'], localRepoRoot:repo, taskWorkspaceRoot:work};
            state.snapshot = {protocol:2, cursor:0, entities:{project:[{id:'p', revision:1, repository:{canonicalUrl:'https://github.com/completion-fixture/materials'}}], task:[task], device:[]}};
            state.receipts[id] = {taskId:id, attemptId:task.attemptId, status, cwd, bindingRevision:1, output:['old output'], exitConfirmed:true, executionInvoked:true, taskSnapshot:task, ...(outcome ? {turnOutcome:outcome} : {})};
          });
          const wire = () => {
            s.localReady = true; s.connected = true; s.pump = async () => {};
            s.send = async (action, payload) => {sent.push({action, payload}); return {};};
            s.startTask = async () => {models++; throw new Error('must not run a model');};
            s.verifyDelivery = async () => {checks++; return {checks:[]};};
            s.runDeliveryGit = async (task, receipt, dir, args) => {await s.authorizeDelivery(task, receipt); return git(dir, args);};
            s.repositoryDelivery = (task, receipt, summary) => deliverRepository(receipt.cwd, task.id, task.meetingId, summary, task.baseCommit,
              async () => {prs++; return 'https://example.invalid/fixture-pr';}, () => s.authorizeDelivery(task, receipt),
              args => s.runDeliveryGit(task, receipt, receipt.cwd, args));
          };
          wire();
          const beforeTransfers = await readFile(transfers, 'utf8');
          for (let poll = 0; poll < 3; poll++) {
            await s.doPump();
            await Promise.allSettled([...s.objectJobs.values(), ...s.deliveries.values()]);
            await s.synchronizeReceipts();
          }
          // A process restart uses the same durable receipt and attempt.
          s = new StationService(profile); await s.storage.load(); wire();
          await s.doPump();
          await Promise.allSettled([...s.objectJobs.values(), ...s.deliveries.values()]);
          await s.deliverTask(task, s.storage.read().receipts[id]);
          const receipt = s.storage.read().receipts[id];
          const result = {status, outcome:outcome ?? 'missing', commitChanged:(await git(cwd, ['rev-parse', 'HEAD'])) !== base,
            pushes:(await readFile(transfers, 'utf8')).slice(beforeTransfers.length).split('\n').filter(row => row.includes('receive-pack')).length,
            prs, models, checks, completed:sent.filter(row => row.payload.status === 'delivered' && row.payload.turnOutcome === 'completed').length};
          evidence.push(result);
          assert.equal(models, 0);
          assert.equal(await readFile(join(cwd, 'partial.txt'), 'utf8'), 'user partial retained\n');
          if (outcome === 'completed') {
            assert.equal(receipt.status, 'delivered', receipt.deliveryError); assert.equal(result.commitChanged, true);
            assert.equal(prs, 1); assert.equal(result.pushes, 1);
          } else {
            assert.deepEqual({...result, status:undefined, outcome:undefined}, {status:undefined, outcome:undefined, commitChanged:false, pushes:0, prs:0, models:0, checks:0, completed:0});
            assert.match(receipt.deliveryError, /正常结束|完成证据/);
            for (const resource of ['text', 'directory', 'native']) {
              const candidate = {...task, resource};
              await assert.rejects(s.authorizeDelivery(candidate, receipt), /正常结束|完成证据/);
            }
            await assert.rejects(s.action('delivery.select', {taskId:id, projectId:'p', baseCommit:base, targetBranch:'main'}), /正常结束|完成证据/);
          }
          if (outcome === 'completed') {
            await s.storage.update(state => {state.receipts[id].stopRequested = true;});
            await assert.rejects(s.authorizeDelivery(task, receipt), /停止/);
            await assert.rejects(s.runDeliveryGit(task, receipt, cwd, ['commit', '--allow-empty', '-m', 'forbidden']), /停止/);
            assert.equal(prs, 1);
          }
        });
      }
    }
    console.log('K01_SIDE_EFFECTS ' + JSON.stringify(evidence));
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(root, {recursive:true, force:true});
  }
});

test('K01: recovery requires original execution identity and explicit normal outcome', async t => {
  const root = await mkdtemp(join(tmpdir(), 'station-proof-'));
  try {
    for (const status of ['reconcile', 'executed', 'delivery-pending']) {
      for (const proof of [undefined, {ok:true, cleanup_confirmed:true, executionId:'original'}, {turnOutcome:'completed', cleanup_confirmed:true, executionId:'other-attempt'},
        {turnOutcome:'completed', cleanup_confirmed:false, executionId:'original'}, {turnOutcome:'completed', cleanup_confirmed:true, executionId:'original'}]) {
        await t.test(status + '/' + (JSON.stringify(proof) ?? 'missing journal'), async () => {
          const s = new StationService(join(root, String(Math.random()))); await s.storage.load();
          const task = {id:'task', attemptId:'original', agentId:'codex', resource:'repository'};
          await s.storage.update(state => {state.snapshot.entities.task = [task]; state.receipts.task = {taskId:'task', attemptId:'original', status, exitConfirmed:status !== 'reconcile', output:['original history'], taskSnapshot:task};});
          let deliveries = 0;
          s.helper = async () => ({executionId:proof?.executionId, result:proof});
          s.deliverTask = async () => {deliveries++;}; s.connected = true; s.send = async () => ({});
          await s.recoverReceipt(s.storage.read().receipts.task);
          const receipt = s.storage.read().receipts.task;
          const complete = proof?.executionId === 'original' && proof.cleanup_confirmed && proof.turnOutcome === 'completed';
          assert.equal(deliveries, complete ? 1 : 0);
          assert.equal(receipt.turnOutcome === 'completed', !!complete);
          assert.deepEqual(receipt.output, ['original history']);
        });
      }
    }
    const s = new StationService(join(root, 'corrupt')); await s.storage.load();
    const task = {id:'task', attemptId:'original', agentId:'codex', resource:'repository'};
    await s.storage.update(state => {state.snapshot.entities.task = [task]; state.receipts.task = {taskId:'task', attemptId:'original', status:'reconcile', exitConfirmed:false, output:['retained'], taskSnapshot:task};});
    s.helper = async () => {throw new SyntaxError('corrupt journal');};
    await assert.rejects(s.recoverReceipt(s.storage.read().receipts.task), /corrupt journal/);
    assert.deepEqual(s.storage.read().receipts.task.output, ['retained']);
    assert.equal(s.storage.read().receipts.task.exitConfirmed, false);
  } finally {await rm(root, {recursive:true, force:true});}
});

test('K02: task details retain the sanitized RPC diagnostic with original task and attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'station-rpc-detail-'));
  try {
    const s = new StationService(root); await s.storage.load();
    const diagnostic = {method:'thread/resume', code:-32601, message:'paginated_threads denied [redacted]',
      stage:'thread-resume', executionId:'original', threadId:'original-thread', turnId:null};
    await s.storage.update(state => {
      state.snapshot.entities.task = [{id:'task', attemptId:'original'}];
      state.receipts.task = {taskId:'task', attemptId:'original', status:'stopped', output:[], nativeRpcError:diagnostic};
    });
    assert.deepEqual(s.view().snapshot.entities.task[0].nativeRpcError, {...diagnostic, taskId:'task', attemptId:'original'});
    const reopened = new StationService(root); await reopened.storage.load();
    assert.deepEqual(reopened.view().snapshot.entities.task[0].nativeRpcError, {...diagnostic, taskId:'task', attemptId:'original'});
  } finally {await rm(root, {recursive:true, force:true});}
});
