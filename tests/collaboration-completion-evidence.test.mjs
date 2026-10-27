import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {dialog} from 'electron';
import {StationService} from '../dist-electron/collaboration/station-service.js';
import {git, prepareRepository, deliverRepository} from '../dist-electron/collaboration/workspaces.js';
import {ensurePullRequest} from '../dist-electron/collaboration/github.js';

test('P1: cross-attempt completion cannot authorize publication through actions or stale callers', {timeout:120000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'station-cross-attempt-'));
  const repo = join(root, 'repo'), bare = join(root, 'remote.git'), work = join(root, 'work');
  const transfers = join(root, 'transfers.jsonl');
  const previous = {GIT_SSH_COMMAND:process.env.GIT_SSH_COMMAND, GIT_SSH_VARIANT:process.env.GIT_SSH_VARIANT,
    GIT_CONFIG_GLOBAL:process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM:process.env.GIT_CONFIG_NOSYSTEM};
  const dialogs = {open:dialog.showOpenDialog, confirm:dialog.showMessageBox};
  const evidence = [];
  try {
    const config = join(root, 'empty.gitconfig');
    await writeFile(config, '');
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    for (const folder of [repo, bare, work]) await mkdir(folder);
    await git(bare, ['init', '--bare']);
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['config', 'user.name', 'Cross Attempt Fixture']);
    await git(repo, ['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(repo, 'base.txt'), 'baseline\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'baseline']);
    const base = await git(repo, ['rev-parse', 'HEAD']);
    const transport = join(root, 'transport.mjs');
    // GitHub-shaped origins are forcibly served by this owned bare repository.
    // The PR callback below is the only PR API; no credentials or network are used.
    await writeFile(transport, `import {spawn} from 'node:child_process';
import {appendFileSync} from 'node:fs';
const mode=process.argv.some(a=>a.includes('git-receive-pack'))?'receive-pack':'upload-pack';
appendFileSync(${JSON.stringify(transfers)},JSON.stringify(mode)+'\\n');
const child=spawn('git',[mode,${JSON.stringify(bare)}],{stdio:'inherit'});
child.on('exit',code=>process.exit(code??1));`);
    process.env.GIT_SSH_COMMAND = '"' + process.execPath.replaceAll('\\', '/') + '" "' + transport.replaceAll('\\', '/') + '"';
    process.env.GIT_SSH_VARIANT = 'ssh';
    await git(repo, ['remote', 'add', 'origin', 'git@github.com:cross-attempt-fixture/materials.git']);
    await git(repo, ['push', 'origin', 'HEAD:refs/heads/codex/station-meeting-m']);
    const inventory = async () => ({
      commits:(await git(repo, ['rev-list', '--all'])).split('\n').filter(Boolean),
      branches:(await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).split('\n').filter(Boolean),
      worktrees:(await git(repo, ['worktree', 'list', '--porcelain'])).split('\n').filter(line => line.startsWith('worktree ')),
      pushes:(await readFile(transfers, 'utf8')).split('\n').filter(line => line.includes('receive-pack')).length,
    });
    const scenarios = [
      'action/new-task-old-local',
      'caller/old-task-and-receipt',
      'caller/replaced-local-receipt',
      'caller/different-task-same-attempt',
      'caller/stale-receipt-snapshot',
      'caller/stale-local-snapshot',
      'dialog/file-selection',
      'dialog/confirmation',
      'prepared/receipt-write-ignored',
      'positive/current-completed',
    ];
    let serial = 0;
    for (const scenario of scenarios) {
      await t.test(scenario, async () => {
        const id = 'cross-' + serial++, profile = join(root, id);
        const cwd = await prepareRepository(repo, work, id, base);
        const selected = join(cwd, 'original-result.txt');
        const content = 'original completed output for ' + id + '; user file must remain\n';
        await writeFile(selected, content);
        const task = {id, revision:1, meetingId:'m', attemptId:'previous-attempt', targetDeviceId:'A', agentId:'codex',
          projectId:'p', resource:'repository', permission:'workspace-write', baseCommit:base, status:'executed',
          scopeVersion:0, stopRequested:false, inputs:[], dependencies:[],
          acceptanceCriteria:[{verification:{kind:'command', argv:['must-not-run']}}]};
        const service = new StationService(profile);
        await service.storage.load();
        await service.storage.update(state => {
          state.deviceId = 'A'; state.allowedAgents = ['codex'];
          state.bindings.p = {projectId:'p', deviceId:'A', confirmed:true, revision:1,
            allowedAgentIds:['codex'], localRepoRoot:repo, taskWorkspaceRoot:work};
          state.snapshot = {protocol:2, cursor:0, entities:{
            project:[{id:'p', revision:1, repository:{canonicalUrl:'https://github.com/cross-attempt-fixture/materials'}}],
            task:[task], device:[],
          }};
          state.receipts[id] = {taskId:id, attemptId:task.attemptId, status:'executed', cwd, bindingRevision:1,
            output:['original output'], finalSummary:'original summary', exitConfirmed:true, turnOutcome:'completed',
            executionInvoked:true, taskSnapshot:task};
          state.gitHistory = {'historical-attempt':{}};
        });
        service.localReady = true; service.connected = true; service.pump = async () => {};
        let prs = 0, models = 0, checks = 0;
        const sent = [];
        service.send = async (action, payload) => {sent.push({action, payload}); return {};};
        service.startTask = async () => {models++; throw new Error('model must not run');};
        service.verifyDelivery = async () => {checks++; return {tests:[], unresolved:[]};};
        service.runDeliveryGit = async (task, receipt, dir, args) => {
          await service.authorizeDelivery(task, receipt);
          return git(dir, args);
        };
        service.repositoryDelivery = (task, receipt, summary) => deliverRepository(
          receipt.cwd, task.id, task.meetingId, summary, task.baseCommit,
          async () => {prs++; return 'https://example.invalid/fixture-pr';}, () => service.authorizeDelivery(task, receipt),
          args => service.runDeliveryGit(task, receipt, receipt.cwd, args));
        const receipt = service.storage.read().receipts[id];
        const advance = async (replaceReceipt = false) => service.storage.update(state => {
          state.snapshot.entities.task[0] = {...task, attemptId:'new-attempt', status:'offered'};
          if (replaceReceipt) state.receipts[id] = {taskId:id, attemptId:'new-attempt', status:'received', cwd, bindingRevision:1,
            exitConfirmed:false, executionInvoked:false, output:[],
            taskSnapshot:state.snapshot.entities.task[0]};
        });
        if (scenario === 'action/new-task-old-local' || scenario === 'caller/old-task-and-receipt') await advance();
        if (scenario === 'caller/replaced-local-receipt') await service.storage.update(state => {
          state.receipts[id] = {...receipt, attemptId:'new-attempt', taskSnapshot:{...task, attemptId:'new-attempt'}};
        });
        if (scenario === 'caller/different-task-same-attempt') {
          receipt.taskId = 'other-task';
          await service.storage.update(state => {state.receipts[id].taskId = 'other-task';});
        }
        if (scenario === 'caller/stale-receipt-snapshot') receipt.taskSnapshot = {...task, attemptId:'another-attempt'};
        if (scenario === 'caller/stale-local-snapshot') await service.storage.update(state => {
          state.receipts[id].taskSnapshot = {...task, id:'other-task'};
        });
        dialog.showOpenDialog = async () => {
          if (scenario === 'dialog/file-selection') await advance(true);
          return {canceled:false, filePaths:[selected]};
        };
        dialog.showMessageBox = async () => {
          if (scenario === 'dialog/confirmation') await advance(true);
          return {response:0};
        };
        if (scenario === 'prepared/receipt-write-ignored') {
          const taskReceipt = service.taskReceipt.bind(service);
          service.taskReceipt = async (task, patch) => {
            if (patch.publication) await advance(true);
            return taskReceipt(task, patch);
          };
        }
        const before = await inventory();
        const storedBefore = service.storage.read();
        let rejection;
        try {
          if (scenario.startsWith('caller/')) await service.deliverTask(task, receipt);
          else await service.action('delivery.select', {taskId:id, projectId:'p', baseCommit:base, targetBranch:'main'});
        } catch (error) {rejection = error.message;}
        const after = await inventory();
        const state = service.storage.read();
        const errors = Object.values(state.businessErrors ?? {}).map(row => row.reason).join(';');
        const result = {scenario, newCommits:after.commits.filter(value => !before.commits.includes(value)).length,
          newBranches:after.branches.filter(value => !before.branches.includes(value)).length,
          newWorktrees:after.worktrees.filter(value => !before.worktrees.includes(value)).length,
          pushes:after.pushes - before.pushes, prs, models, checks,
          events:sent.filter(row => row.action === 'task.event').map(row => row.payload),
          rejection:rejection ?? (errors || state.receipts[id].deliveryError),
          currentReceiptAttempt:state.receipts[id].attemptId, currentOutcome:state.receipts[id].turnOutcome,
          publication:state.receipts[id].publication?.commit};
        evidence.push(result);
        assert.equal(await readFile(selected, 'utf8'), content);
        assert.deepEqual(state.gitHistory, storedBefore.gitHistory);
        assert.equal(models, 0);
        if (scenario === 'positive/current-completed') {
          assert.equal(rejection, undefined);
          assert.equal(state.receipts[id].status, 'delivered');
          assert.equal(result.newCommits, 2);
          assert.equal(result.pushes, 2);
          assert.equal(prs, 1);
          assert.equal(checks, 1);
          // The durable successful receipt remains readable and does not republish.
          const reopened = new StationService(profile); await reopened.storage.load();
          await service.deliverTask(task, reopened.storage.read().receipts[id]);
          assert.deepEqual(await inventory(), after);
          assert.equal(prs, 1);
          assert.deepEqual(reopened.storage.read().receipts[id].output, receipt.output);
        } else {
          const prepared = scenario === 'prepared/receipt-write-ignored';
          assert.equal(result.newCommits, prepared ? 1 : 0, JSON.stringify(result));
          assert.equal(result.newBranches, prepared ? 1 : 0);
          assert.equal(result.newWorktrees, prepared ? 1 : 0);
          assert.equal(result.pushes, 0);
          assert.equal(prs, 0);
          assert.equal(checks, 0);
          assert.deepEqual(result.events, [], 'stale evidence must not be reported under either attempt');
          assert.match(result.rejection, /任务.*尝试|task.*attempt/i);
          if (scenario.startsWith('dialog/') || prepared) {
            assert.equal(state.receipts[id].attemptId, 'new-attempt');
            assert.equal(state.receipts[id].status, 'received');
            assert.equal(state.receipts[id].turnOutcome, undefined);
            assert.equal(state.receipts[id].publication, undefined);
            assert.equal(state.receipts[id].delivery, undefined);
          } else assert.deepEqual(state.receipts, storedBefore.receipts);
          const reopened = new StationService(profile); await reopened.storage.load();
          assert.deepEqual(reopened.storage.read().receipts, state.receipts);
        }
      });
    }
  } finally {
    console.log('CROSS_ATTEMPT_SIDE_EFFECTS ' + JSON.stringify(evidence));
    if (process.env.STATION_EVIDENCE_DIR) {
      await mkdir(process.env.STATION_EVIDENCE_DIR, {recursive:true});
      await writeFile(join(process.env.STATION_EVIDENCE_DIR, 'cross-attempt-RESULT.json'), JSON.stringify(evidence, null, 2));
    }
    dialog.showOpenDialog = dialogs.open; dialog.showMessageBox = dialogs.confirm;
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(root, {recursive:true, force:true});
  }
});

test('P1: PR creation rechecks the original attempt after awaiting existing PRs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'station-pr-attempt-'));
  const service = new StationService(root);
  let result;
  try {
    await service.storage.load();
    const task = {id:'task', revision:1, meetingId:'m', attemptId:'original', agentId:'codex', resource:'text', scopeVersion:0};
    const receipt = {taskId:'task', attemptId:'original', status:'executed', output:['original output'],
      bindingRevision:0, exitConfirmed:true, turnOutcome:'completed', taskSnapshot:task};
    await service.storage.update(state => {
      state.allowedAgents = ['codex']; state.snapshot.entities.task = [task]; state.receipts.task = receipt;
    });
    let queries = 0, posts = 0, rejection;
    const api = async (_route, body) => {
      if (body) {posts++; return {html_url:'https://example.invalid/unexpected-pr'};}
      queries++;
      await service.storage.update(state => {
        state.snapshot.entities.task = [{...task, attemptId:'successor', status:'offered'}];
      });
      return [];
    };
    try {
      await ensurePullRequest('https://github.com/owned/fixture', 'task', 'main', 'Fixture', 'Output',
        'a'.repeat(40), api, () => service.authorizeDelivery(task, receipt));
    } catch (error) {rejection = error.message;}
    result = {queries, posts, rejection, receiptPreserved:JSON.stringify(service.storage.read().receipts.task) === JSON.stringify(receipt)};
    assert.equal(queries, 1);
    assert.equal(posts, 0, JSON.stringify(result));
    assert.match(rejection, /任务.*尝试/);
    assert.deepEqual(service.storage.read().receipts.task, receipt);
    // Reading the original PR remains legal; it creates no new publication.
    const historical = await ensurePullRequest('https://github.com/owned/fixture', 'task', 'main', 'Fixture', 'Output',
      'a'.repeat(40), async () => [{html_url:'https://example.invalid/original-pr', state:'open',
        base:{ref:'main'}, head:{sha:'a'.repeat(40)}}], () => service.authorizeDelivery(task, receipt));
    assert.equal(historical, 'https://example.invalid/original-pr');
  } finally {
    if (process.env.STATION_EVIDENCE_DIR) {
      await mkdir(process.env.STATION_EVIDENCE_DIR, {recursive:true});
      await writeFile(join(process.env.STATION_EVIDENCE_DIR, 'pr-attempt-RESULT.json'), JSON.stringify(result, null, 2));
    }
    await rm(root, {recursive:true, force:true});
  }
});

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
