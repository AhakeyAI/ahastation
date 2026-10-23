import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {app} from 'electron';
import {Orchestrator} from '../dist-electron/orchestrator.js';
import {getBackendRegistry} from '../dist-electron/backends/registry.js';
import {boundedMeetingContext,approvedTargetAvailable} from '../dist-electron/collaboration/unified-policy.js';
import {parseSharedCommand,validateSharedWire} from '../dist-electron/collaboration/production-validation.js';
import {reviewSharedReport,sharedWorkReport} from '../dist-electron/collaboration/delivery-report.js';
import {StationService} from '../dist-electron/collaboration/station-service.js';
import {prepareMeetingInput} from '../dist-electron/collaboration/meeting-input.js';

test('unified Host plans use original Orchestrator once and never populate local WorkerScheduler',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'unified-orchestrator-'));const original=app.getPath;app.getPath=()=>folder;
  const registry=getBackendRegistry();if(!registry.get('unified-fixture'))registry.register({id:'unified-fixture',displayName:'fixture',capabilities:{coordinate:true,executeTasks:true},resolveBinary:()=>null});
  const plans=[];const events=[];let interrupted=0;
  const orch=new Orchestrator({cwd:folder,defaultBackendId:'unified-fixture',emit:e=>events.push(e),reviewStallTimeoutMs:0,hostAskTimeoutMs:0,
    sessionFactory:opts=>({start:async()=>{},sendUserText(){},sendUserContent(){},end(){},interrupt:async()=>{interrupted++;},resolvePermission(){}}),
    sharedExecution:{propose:async(tasks,brief)=>plans.push({tasks,brief}),consult:async()=>{},control:async()=>{}},
  });
  try{await orch.start();const target={deviceId:'B',agentId:'codex',resource:'text',permission:'read-only'};
    const result=await orch.executeMeetingCommand('default',{kind:'propose-plan',goal:'明确目标',approach:'按独立成果拆分',tasks:[{id:'whole',title:'完整交付',prompt:'包含修改、测试、修正和说明',deps:[],sharedTarget:target}]});
    assert.equal(result.ok,true);assert.equal(plans.length,1);assert.equal(plans[0].brief.approach,'按独立成果拆分');assert.deepEqual(plans[0].tasks[0].sharedTarget,target);
    assert.equal(events.filter(e=>e.event.kind==='worker-spawned').length,0);
    await orch.interruptHostReply();assert.equal(interrupted,1);
  }finally{await orch.end();app.getPath=original;await rm(folder,{recursive:true,force:true});}
});

test('explicit attachment references cannot read an unbound local project during discussion',async()=>{
  const state={snapshot:{entities:{project:[{id:'p',repository:{canonicalUrl:'https://github.com/user/materials'}}]}},bindings:{}};
  await assert.rejects(prepareMeetingInput({text:'read selected document',attachments:[{repository:'https://github.com/user/materials',commit:'a'.repeat(40),paths:['selected.md']}]},state,join(tmpdir(),'unbound-'+randomUUID())),/绑定并授权/);
  state.bindings.p={confirmed:true,allowedAgentIds:['other-agent']};
  await assert.rejects(prepareMeetingInput({text:'read selected document',attachments:[{repository:'https://github.com/user/materials',commit:'a'.repeat(40),paths:['selected.md']}]},state,join(tmpdir(),'wrong-agent-'+randomUUID())),/授权此 Agent/);
});

test('ordinary discussion with no attachments does not request GitHub or project authorization',async()=>{
  assert.deepEqual(await prepareMeetingInput({text:'discuss only'},{snapshot:{entities:{}},bindings:{}},join(tmpdir(),'unused-discussion')),{text:'discuss only',images:[]});
});

test('meeting context excludes native histories and private agent discussions but preserves current actual delivery evidence',()=>{
  const snap={protocol:2,cursor:3,entities:{meeting:[{id:'m',revision:1,title:'goal',members:['B']}],device:[{id:'B',revision:1}],history:[{id:'secret',text:'NATIVE_PRIVATE_HISTORY'}],native:[{id:'native',text:'FULL_NATIVE_CONTEXT'}],message:[{id:'private',revision:1,meetingId:'m',route:'agent',text:'EXPERT_PRIVATE'},{id:'input',revision:1,meetingId:'m',route:'host',text:'user goal'}],task:[{id:'task',revision:2,meetingId:'m',attemptId:'new',delivery:{summary:'actual result',report:{attemptId:'new',tests:[{exitCode:0}]}}}]}};
  snap.entities.meeting[0].coordinatorDeviceId='A';snap.entities.message.push({id:'host-decision',meetingId:'m',route:'host',replyTo:'input',sourceDeviceId:'A',text:'CONFIRMED-APPROACH-DECISION'});
  const ctx=boundedMeetingContext(snap,'m');const json=JSON.stringify(ctx);assert.ok(json.includes('CONFIRMED-APPROACH-DECISION'));
  assert.ok(!json.includes('NATIVE_PRIVATE_HISTORY'));assert.ok(!json.includes('FULL_NATIVE_CONTEXT'));assert.ok(!json.includes('EXPERT_PRIVATE'));assert.ok(json.includes('actual result'));assert.ok(json.includes('exitCode'));
});

test('approved target availability never picks a lower-load device',()=>{
  const snapshot={entities:{device:[{id:'B',online:false,acceptingTasks:true,agents:[{agentId:'codex',available:true}]},{id:'A',online:true,acceptingTasks:true,activeTasks:0,agents:[{agentId:'codex',available:true}]}]}};
  assert.equal(approvedTargetAvailable(snapshot,{targetDeviceId:'B',agentId:'codex'}),false);
});

test('new account credential alone has no background close responsibility',()=>{
  const service=new StationService(join(tmpdir(),'not-initialized-'+randomUUID()));assert.equal(service.hasBackgroundResponsibility(),false);
});

test('concurrent delivery uses the durable final body once instead of inserting separators between streaming fragments',async()=>{
  const service=new StationService(join(tmpdir(),'delivery-race-'+randomUUID()));
  const task={id:'text-task',revision:1,attemptId:'attempt',targetDeviceId:'A',resource:'text',agentId:'codex'};
  const receipt={taskId:task.id,attemptId:task.attemptId,status:'executed',turnOutcome:'completed',exitConfirmed:true,output:['STATION','-REAL-END'],finalSummary:'STATION-REAL-END'};
  const state={deviceId:'A',receipts:{[task.id]:receipt},allowedAgents:[],snapshot:{entities:{task:[task]}}};service.storage.read=()=>state;service.issue=async()=>{};
  await assert.rejects(service.authorizeDelivery(task,receipt),/授权/);state.allowedAgents=['codex'];
  let release;const gate=new Promise(done=>{release=done;});let verified=0;const events=[];
  service.verifyDelivery=async()=>{verified++;await gate;return {tests:[],unresolved:[]};};
  service.taskReceipt=async(_task,patch)=>{Object.assign(receipt,patch);};service.taskEvent=async(_task,status,_exit,extra)=>{events.push({status,...extra});};
  const one=service.deliverTask(task,receipt),two=service.deliverTask(task,receipt);assert.equal(one,two);release();await Promise.all([one,two]);
  assert.equal(verified,1);assert.equal(events.length,1);assert.equal(events[0].delivery.summary,'STATION-REAL-END');
  await service.deliverTask(task,receipt);assert.equal(verified,1);
});

test('discussion, exact task supplement and native continuation are explicit strict wire fields',()=>{
  for(const payload of [{meetingId:'m',text:'discuss',targetDeviceId:'B',targetAgentId:'codex'},{meetingId:'m',text:'supplement',taskId:'t'},{meetingId:'m',text:'continue',targetDeviceId:'B',nativeSessionId:'native'}])assert.equal(parseSharedCommand({protocol:2,requestId:randomUUID(),action:'message.send',payload}).action,'message.send');
  assert.throws(()=>parseSharedCommand({protocol:2,requestId:'x',action:'message.send',payload:{meetingId:'m',text:'bad',cwd:'C:/secret'}}));
});

test('natural language tests cannot replace actual test results and obsolete attempts cannot be reviewed',async()=>{
  const task={id:'task',revision:1,attemptId:'new',exitConfirmed:true,delivery:{summary:'测试全部通过',files:[],report:{taskId:'task',attemptId:'new',exitConfirmed:true,tests:[{argv:['node','test.mjs'],exitCode:1,output:'assertion failed',source:'station-verifier'}],unresolved:[]}}};
  assert.equal((await reviewSharedReport(task,true)).passed,false);task.delivery.report.attemptId='old';assert.throws(()=>sharedWorkReport(task),/当前任务/);
});
