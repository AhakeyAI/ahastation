import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {StationService} from '../dist-electron/collaboration/station-service.js';
import {UnifiedMeetingHost} from '../dist-electron/collaboration/unified-host.js';
import {CollaborationHttpError,CollaborationConnection} from '../dist-electron/collaboration/connection.js';
import {rejectedHostPlan} from '../dist-electron/collaboration/host-plan-outcome.js';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {preserveText} from '../dist-electron/collaboration/text-artifacts.js';
import {deliveryIdentity,deliveryHash,verifiedDelivery} from '../dist-electron/collaboration/delivery-identity.js';
import {dependencyWait, pendingBaseRevisions} from '../dist-electron/collaboration/plan-revision.js';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'station-p1-'));
  try {
    const service = new StationService(root);
    await service.storage.load();
    service.localReady = true;
    const meeting = {id:randomUUID(), revision:1, coordinatorDeviceId:service.view().deviceId, hostAgentId:'codex', plan:[]};
    const message = {id:randomUUID(), revision:1, meetingId:meeting.id, route:'host', text:'修订完整计划'};
    await service.storage.update(s => {
      s.snapshot.entities = {meeting:[meeting], message:[message], task:[]};
      s.hostPlanBases = {[message.id]:{version:1, decisionVersion:1}};
      s.hostMessages = {[message.id]:'reconcile'};
    });
    const replies = [];
    const host = new UnifiedMeetingHost(meeting, () => service.view().snapshot, root, {
      plan:(tasks,id) => service.proposeHostPlan(meeting,tasks,id),
      checkpoint:(...args) => service.checkpointHost(meeting.id,...args),
      reply:async text => { replies.push(text); }, session:async()=>{}, consult:async()=>{}, control:async()=>{},
    });
    host.start = async()=>{};
    host.dispatchCommands = () => service.proposeHostPlan(meeting,[],message.id);
    service.coordinator = () => host;
    const full = await preserveText(root,randomUUID(),randomUUID(),'原模型完整输出',true);
    service.inspectHost = async() => ({result:{ok:true,cleanup_confirmed:true,contentComplete:true,fullText:full.reference}});
    await run({service,host,meeting,message,replies,root});
  } finally { await rm(root,{recursive:true,force:true}); }
}

for (const code of ['DISPATCHED_TASK_OMITTED','DISPATCHED_TASK_IMMUTABLE','PLAN_VERSION_CONFLICT','PLAN_APPROVAL_CONFLICT']) {
  test('P1 Host restart settles confirmed rejection '+code, async()=>fixture(async({service,meeting,message,replies})=>{
    const requests=[];
    service.send = async(action,payload,id)=>{
      requests.push({action,payload,id});
      if(action==='plan.propose')throw new CollaborationHttpError('exact reason',409,code);
      return {id:randomUUID(),revision:1};
    };
    await assert.rejects(service.recoverInput(message.id,'reconcile'));
    assert.equal(service.storage.read().hostMessages[message.id],'failed');
    assert.equal(service.contextBusy({id:'next',meetingId:meeting.id,route:'host'}),false);
    assert.equal(service.storage.read().hostFailures[message.id].code,code);
    assert.deepEqual(meeting.plan,[]);
    assert.equal(replies.includes('计划已提交审阅。'),false);
    assert.ok(requests.some(r=>r.action==='message.send'&&r.payload.text.includes('提案未应用')));
    const reopened=new StationService(service.storage.file.replace(/[\\/][^\\/]+$/,''));
    await reopened.storage.load();
    assert.equal(reopened.storage.read().hostMessages[message.id],'failed');
  }));
}

test('P1 active native execution and uncertain submissions retain context and exact request',async()=>fixture(async({service,meeting,message,host})=>{
  let calls=0;
  service.send=async(action,payload,id)=>{
    if(action==='plan.propose'){calls++;assert.equal(id,'hp:'+message.id);throw new CollaborationHttpError('uncertain',409,'REQUEST_ID_CONTENT_CONFLICT');}
    return {id:randomUUID(),revision:1};
  };
  service.inspectHost=async()=>({result:{cleanup_confirmed:false}});
  await service.recoverInput(message.id,'reconcile');
  assert.equal(calls,0);
  assert.equal(service.contextBusy({id:'next',meetingId:meeting.id,route:'host'}),true);
  assert.equal(service.contextBusy({id:'other',meetingId:'independent',route:'host'}),false);
  const full=await preserveText(service.storage.file+'.text',randomUUID(),randomUUID(),'complete',true);
  service.inspectHost=async()=>({result:{ok:true,cleanup_confirmed:true,contentComplete:true,fullText:full.reference}});
  for(const error of [new Error('response lost'),new CollaborationHttpError('generation',409,'CONNECTION_GENERATION_CHANGED'),new CollaborationHttpError('protocol',426,'PROTOCOL_INCOMPATIBLE')]){
    service.send=async(action,payload,id)=>{if(action==='plan.propose'){calls++;assert.equal(id,'hp:'+message.id);throw error;}return {id:randomUUID(),revision:1};};
    await assert.rejects(service.recoverInput(message.id,'reconcile'));
    assert.equal(service.storage.read().hostMessages[message.id],'reconcile');
  }
  service.send=async()=>({id:randomUUID(),revision:1});
  await service.recoverInput(message.id,'reconcile');
  assert.equal(service.storage.read().hostMessages[message.id],'completed');
  assert.equal(host.current,undefined);
}));

test('P1 live rejected turn releases only after native completion and next input runs',async()=>fixture(async({service,host,meeting,message})=>{
  let finishNative;
  const gate=new Promise(resolve=>{finishNative=resolve;});
  service.send=async(action)=>{
    if(action==='plan.propose')throw new CollaborationHttpError('keep dispatched work',409,'DISPATCHED_TASK_OMITTED');
    return {id:randomUUID(),revision:1};
  };
  let turns=0;
  host.start=async()=>{
    host.orch={hostSessionSnapshot:()=>null,sendUserText:()=>{
      turns++;
      void (async()=>{
        host.current.invoked=true;
        if(turns===1){
          try{await service.proposeHostPlan(meeting,[],message.id);}
          catch(error){host.rejectedPlans.set(message.id,error);}
          await gate;
        }
        host.current.executionEnded=true;
        host.current.resolve();
      })();
    }};
  };
  const running=host.input(message);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(service.contextBusy({id:'next',meetingId:meeting.id,route:'host'}),true);
  finishNative();
  await assert.rejects(running);
  assert.equal(service.storage.read().hostMessages[message.id],'failed');
  assert.equal(service.contextBusy({id:'next',meetingId:meeting.id,route:'host'}),false);
  await host.input({...message,id:'next'});
  assert.equal(turns,2);
  assert.equal(service.storage.read().hostMessages.next,'completed');
}));

test('P1 persisted rejection waits for real exit then recovers without resubmitting',async()=>fixture(async({service,meeting,message,root})=>{
  const failure={message:'提案未应用：exact original reason',notStarted:false,code:'DISPATCHED_TASK_OMITTED',proposalRejected:true};
  await service.storage.update(s=>{s.hostFailures={[message.id]:failure};});
  const reopened=new StationService(root);
  await reopened.storage.load();
  reopened.localReady=true;
  let proposals=0;
  reopened.send=async(action)=>{if(action==='plan.propose')proposals++;return {id:randomUUID(),revision:1};};
  reopened.inspectHost=async()=>({result:{cleanup_confirmed:false}});
  await reopened.recoverInput(message.id,'reconcile');
  assert.equal(reopened.contextBusy({id:'next',meetingId:meeting.id,route:'host'}),true);
  reopened.inspectHost=async()=>({result:{ok:true,cleanup_confirmed:true,json:{last_message:'Legacy preview remains history'}}});
  await reopened.recoverInput(message.id,'reconcile');
  assert.equal(reopened.storage.read().hostMessages[message.id],'failed');
  assert.equal(proposals,0);
  assert.deepEqual(reopened.storage.read().hostFailures[message.id],failure);
}));

test('P1 delayed recovery checkpoint cannot clear a subsequent Host turn',async()=>fixture(async({service,host,message})=>{
  let checkpointEntered,releaseCheckpoint,nextEntered;
  const entered=new Promise(resolve=>{checkpointEntered=resolve;});
  const release=new Promise(resolve=>{releaseCheckpoint=resolve;});
  const nextStarted=new Promise(resolve=>{nextEntered=resolve;});
  const checkpoint=host.hooks.checkpoint;
  host.hooks.checkpoint=async(id,status,...args)=>{
    await checkpoint(id,status,...args);
    if(id===message.id&&status==='completed'){checkpointEntered();await release;}
  };
  host.start=async()=>{host.orch={sendUserText:()=>nextEntered(),hostSessionSnapshot:()=>null};};
  host.dispatchCommands=async()=>{};
  service.send=async()=>({id:randomUUID(),revision:1});
  const recovering=service.recoverInput(message.id,'reconcile');
  await entered;
  const next=host.input({...message,id:'next'});
  await nextStarted;
  releaseCheckpoint();
  await recovering;
  assert.equal(host.current?.id,'next');
  host.current.executionEnded=true;
  host.current.resolve();
  await next;
  assert.equal(service.storage.read().hostMessages.next,'completed');
}));

test('P1 every local dependency and baseline gate rejects mismatched verification evidence',async()=>{
  const task={id:'task',revision:1,meetingId:'m',attemptId:'a',status:'delivered',integration:'verified',exitConfirmed:true,turnOutcome:'completed',scopeVersion:1,delivery:{scopeVersion:1,summary:'中文🧭',report:{taskId:'task',attemptId:'a',exitConfirmed:true,tests:[]}}};
  task.verificationBinding={attemptId:'a',reviewed:true,deliveryHash:createHash('sha256').update(deliveryIdentity(task)).digest('hex')};
  assert.equal(deliveryHash(task),task.verificationBinding.deliveryHash);
  const plan={planTaskId:'next',resource:'repository',baseCommit:'1'.repeat(40),dependencies:['task']};
  const snapshot={entities:{task:[task]}};
  assert.equal(dependencyWait(snapshot,'m',plan),undefined);
  assert.equal(pendingBaseRevisions(snapshot,{id:'m',verifiedCommit:'2'.repeat(40),plan:[plan]}).length,1);
  for(const patch of [{delivery:{...task.delivery,summary:'different'}},{attemptId:'new'},{scopeVersion:2},{exitConfirmed:false},{turnOutcome:'failed'},{verificationBinding:{...task.verificationBinding,reviewed:false}}]){
    const changed={entities:{task:[{...task,...patch}]}};
    assert.ok(dependencyWait(changed,'m',plan));
    assert.deepEqual(pendingBaseRevisions(changed,{id:'m',verifiedCommit:'2'.repeat(40),plan:[plan]}),[]);
  }
  const following={...task,id:'following',dependencies:['task']};
  following.delivery={...task.delivery,report:{...task.delivery.report,taskId:following.id}};
  following.verificationBinding={attemptId:'a',reviewed:true,deliveryHash:deliveryHash(following)};
  const stale={...task,delivery:{...task.delivery,summary:'late result'}};
  assert.ok(dependencyWait({entities:{task:[stale,following]}},'m',{dependencies:['following']}));
  const legacy={...task};delete legacy.turnOutcome;
  assert.equal(verifiedDelivery(legacy),true);
  delete legacy.verificationBinding;legacy.status='accepted';
  assert.equal(verifiedDelivery(legacy),false);
  assert.equal(legacy.status,'accepted');
  await fixture(async({service,meeting})=>{
    await service.storage.update(s=>{
      s.snapshot.entities.meeting=[{...meeting,id:'m'}];
      s.snapshot.entities.task=[{...stale,resource:'repository',dependencies:[]}];
    });
    await assert.rejects(service.action('delivery.integrate',{taskId:'task'}),/当前成果的核验绑定不匹配/);
  });
});

test('P1 transaction rejection proof must match the exact original request',async()=>{
  let matched=true;
  const server=createServer((_request,response)=>{
    response.writeHead(409,{'Content-Type':'application/json'});
    response.end(JSON.stringify({detail:{code:'BUSINESS_RULE',message:'Not applied',requestId:matched?'original':'another',applied:false}}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const connection=new CollaborationConnection({url:'http://127.0.0.1:'+server.address().port,token:'owned-fixture',onSnapshot:async()=>{},onEvent:async()=>{},onStatus:()=>{}});
  const command={protocol:2,action:'plan.propose',requestId:'original',payload:{}};
  try{
    await assert.rejects(connection.command(command),error=>!!rejectedHostPlan(error));
    matched=false;
    await assert.rejects(connection.command(command),error=>!rejectedHostPlan(error));
    assert.equal(rejectedHostPlan(new CollaborationHttpError('identity',409,'REQUEST_ID_CONTENT_CONFLICT',true)),undefined);
    assert.equal(rejectedHostPlan(new CollaborationHttpError('protocol',426,'PROTOCOL_INCOMPATIBLE',true)),undefined);
  }finally{connection.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('P1 unresolved plan identity does not block another saved operation',async()=>fixture(async({service,meeting})=>{
  const first={protocol:2,requestId:'hp:original',action:'plan.propose',payload:{meetingId:meeting.id,tasks:[]}};
  const second={protocol:2,requestId:'independent',action:'message.event',payload:{messageId:'other',status:'completed',exitConfirmed:true}};
  await service.storage.update(s=>{s.outbox=[first,second];});
  const delivered=[];
  service.deliver=async command=>{
    delivered.push(command.requestId);
    if(command.requestId===first.requestId)throw new CollaborationHttpError('different original content',409,'REQUEST_ID_CONTENT_CONFLICT');
    return {id:'other',revision:1};
  };
  service.error=async()=>{};
  await service.flush();
  assert.deepEqual(delivered,[first.requestId,second.requestId]);
  assert.deepEqual(service.storage.read().outbox[0],first);
}));
