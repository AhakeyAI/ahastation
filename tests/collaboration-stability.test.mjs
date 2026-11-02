import {preserveText} from '../dist-electron/collaboration/text-artifacts.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {StationService} from '../dist-electron/collaboration/station-service.js';
import {CollaborationHttpError,CollaborationConnection} from '../dist-electron/collaboration/connection.js';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const tick=()=>new Promise(r=>setImmediate(r));
export const meeting={id:'m',revision:1,coordinatorDeviceId:'A',hostAgentId:'codex',members:['A'],planApproved:false};
export const expert={id:'expert',revision:1,meetingId:'m',route:'agent',targetDeviceId:'A',targetAgentId:'codex',text:'独立讨论',createdAt:1};
export function fixture(messages=[expert]){
  const state={deviceId:'A',config:{maxConcurrency:1,acceptingTasks:false},allowedAgents:[],receipts:{},outbox:[],bindings:{},directories:{},checks:{},hostMessages:{},snapshot:{protocol:2,cursor:0,entities:{meeting:[structuredClone(meeting)],message:structuredClone(messages),task:[],approval:[]}}};
  const service=new StationService('.unused-stability');service.storage.read=()=>structuredClone(state);service.storage.update=async fn=>fn(state);service.connected=true;service.error=async()=>{};service.send=async()=>({});
  return {state,service};
}
test('F1 independent active expert never blocks Host, but the same discussion waits for reconciliation',async()=>{
  const next={id:'host-next',meetingId:'m',route:'host',text:'Host 继续',createdAt:2};
  const {state,service}=fixture([expert,{...expert,id:'expert-next',createdAt:3},next]);state.hostMessages.expert='reconcile';
  let host=0,discussion=0;service.hosts.set('m',{input:async()=>{host++;}});service.discuss=async()=>{discussion++;};
  await service.doPump();await tick();assert.equal(host,1);assert.equal(discussion,0);
});
test('F1 authorization failure is visible on the original expert input and releases the scheduling reservation',async()=>{
  const {state,service}=fixture();service.hostScheduled.add(expert.id);
  await assert.rejects(service.discuss(meeting,expert),/授权/);
  assert.equal(state.hostMessages.expert,'failed');assert.equal(state.hostFailures.expert.notStarted,true);assert.match(state.hostFailures.expert.message,/授权/);assert.equal(service.hostScheduled.has(expert.id),false);
});
test('S01/S13 an unknown expert leaves an independent received task, Host and tool decision progressing',async()=>{
  const input={id:'host-next',meetingId:'m',route:'host',text:'continue',createdAt:2};const {state,service}=fixture([expert,input]);state.hostMessages.expert='reconcile';let host=0,task=0,approval;
  const work={id:'independent',meetingId:'another',targetDeviceId:'A',agentId:'file-test',resource:'text',attemptId:'attempt',status:'received'};state.snapshot.entities.task.push(work);state.receipts.independent={taskId:work.id,attemptId:'attempt',status:'received',bindingRevision:0,output:[]};state.snapshot.entities.approval=[{id:'tool',decision:'allow'}];service.approvals.set('tool',value=>approval=value);
  service.hosts.set('m',{input:async()=>host++});service.startTask=async()=>{task++;return {close(){},stop:async()=>true};};await service.doPump();await tick();assert.equal(host,1);assert.equal(task,1);assert.equal(approval,'allow');assert.equal(state.hostMessages.expert,'reconcile');
});
function discussionFixture(){const f=fixture();f.state.allowedAgents=['codex'];f.service.pump=async()=>{};f.service.prepareDiscussionDirectory=async()=>{};f.service.prepareDiscussionInput=async()=>({text:'prepared',images:[]});f.runs=0;f.service.discussionExecution=()=>({run:async()=>{f.runs++;return {exitConfirmed:true,summary:'actual fixture output'};},close(){},stop:async()=>true});return f;}
for(const boundary of ['adapter','directory','input','publication','launch'])test('F1 expert '+boundary+' failure owns a readable attempt without locking independent work',async()=>{
  const f=discussionFixture();const error=new Error('injected '+boundary);
  if(boundary==='adapter')f.service.discussionExecution=()=>{throw error;};
  if(boundary==='directory')f.service.prepareDiscussionDirectory=async()=>{throw error;};
  if(boundary==='input')f.service.prepareDiscussionInput=async()=>{throw error;};
  if(boundary==='publication')f.service.send=async(a,p)=>{if(a==='message.event'&&p.status==='running')throw error;return {};};
  if(boundary==='launch')f.service.discussionExecution=()=>({run:async()=>{f.runs++;throw error;},close(){}});
  f.service.hostScheduled.add(expert.id);await assert.rejects(f.service.discuss(meeting,expert),new RegExp(boundary));
  assert.equal(f.state.hostMessages.expert,boundary==='launch'?'reconcile':'failed');assert.equal(f.state.hostFailures.expert.notStarted,boundary!=='launch');assert.equal(f.runs,boundary==='launch'?1:0);assert.equal(f.service.hostScheduled.has(expert.id),false);assert.equal(f.service.executingInputs.has(expert.id),false);
});
test('F1 restart inspects an orphan reservation, retains unknown context, then restores the same discussion thread and consultation once',async()=>{
  const {state,service}=fixture([{...expert,consultation:true}]);state.hostMessages.expert='reconcile';service.hostScheduled.add(expert.id);let inspections=0;const sent=[];service.send=async(a,p,id)=>{sent.push({a,p,id});return {};};service.inspectHost=async()=>{inspections++;return {result:null};};
  await service.recoverReceipts();assert.equal(inspections,1);assert.equal(state.hostMessages.expert,'reconcile');assert.equal(service.contextBusy({...expert,id:'next'}),true);
  const generated=await preserveText(await mkdtemp(join(tmpdir(),'expert-full-')),randomUUID(),randomUUID(),'expert result',true);
  service.inspectHost=async()=>({threadId:'original-expert-thread',result:{ok:true,cleanup_confirmed:true,contentComplete:true,fullText:generated.reference,json:{last_message:'expert result'}}});await service.recoverReceipts();await service.recoverReceipts();
  assert.equal(state.discussionThreads['m:codex'],'original-expert-thread');assert.equal(state.hostThreads?.m,undefined);assert.equal(sent.filter(c=>c.id==='discussion:expert').length,1);assert.equal(sent.filter(c=>c.id==='consultation:expert').length,1);assert.equal(state.hostMessages.expert,'completed');
});
for(const stop of [false,true])test('F1 '+(stop?'stop':'authorization withdrawal')+' during preparation prevents a delayed discussion launch',async()=>{
  const f=discussionFixture();let enter,release;const ready=new Promise(r=>enter=r),gate=new Promise(r=>release=r);f.service.prepareDiscussionInput=async()=>{enter();await gate;return {text:'ready',images:[]};};
  const run=f.service.discuss(meeting,expert);await ready;if(stop)f.state.snapshot.entities.message[0].stopRequested=true;else f.state.allowedAgents=[];release();await assert.rejects(run);assert.equal(f.runs,0);assert.equal(f.state.hostFailures.expert.notStarted,true);
});
test('F3 Host writes use the durable original basis, and old recovered output cannot invent a current basis',async()=>{
  const {state,service}=fixture([{id:'host',meetingId:'m',route:'host'}]);Object.assign(state.snapshot.entities.meeting[0],{planVersion:4,planDecisionVersion:8});
  await service.checkpointHost('m','host','preparing');Object.assign(state.snapshot.entities.meeting[0],{planVersion:7,planDecisionVersion:11});const commands=[];
  service.send=async(a,p,id)=>{commands.push({a,p,id});if(a==='plan.propose')throw new CollaborationHttpError('Plan changed',409);return {};};
  await assert.rejects(service.proposeHostPlan(meeting,[],'host'),e=>e instanceof CollaborationHttpError&&e.status===409);assert.equal(commands[0].p.expectedPlanVersion,4);assert.equal(commands[0].p.expectedPlanDecisionVersion,8);assert.equal(commands[1].id,'hp-conflict:host');
  commands.length=0;await assert.rejects(service.proposeHostPlan(meeting,[],'old-without-basis'),/HOST_PLAN_BASIS_MISSING/);assert.equal(commands.some(c=>c.a==='plan.propose'),false);assert.equal(commands.length,0);
});
test('F2 production HTTP/WSS lost response, durable Station and Hub restart reconcile the original submission once',{timeout:60000},async()=>{
  assert.ok(process.env.COLLABORATION_PYTHON,'COLLABORATION_PYTHON is required for this executable integration test');
  const root=await mkdtemp(join(tmpdir(),'station-submission-'));const previous=process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK;process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK='1';
  const child=spawn(process.env.COLLABORATION_PYTHON,['services/remote/tests/station_collaboration_fixture.py'],{windowsHide:true,stdio:['pipe','pipe','pipe']});const lines=createInterface({input:child.stdout});let stderr='';child.stderr.on('data',v=>stderr+=v);const connections=[];
  const line=key=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{lines.off('line',receive);reject(new Error(key+': '+stderr));},20000);function receive(text){try{const value=JSON.parse(text);if(value[key]){clearTimeout(timer);lines.off('line',receive);resolve(value);}}catch{}}lines.on('line',receive);});
  const until=async fn=>{for(let i=0;i<300;i++){if(await fn())return;await new Promise(r=>setTimeout(r,25));}assert.fail('Timed out waiting for durable state');};
  try{
    const info=await line('ready'),deviceId=randomUUID();const config={name:'isolated submission sender',platform:'windows',acceptingTasks:false,maxConcurrency:1,agents:[]};
    const register=await fetch(info.url+'/api/collaboration/v2/commands',{method:'POST',headers:{Authorization:'Bearer '+info.token,'Content-Type':'application/json'},body:JSON.stringify({protocol:2,requestId:randomUUID(),action:'device.register',payload:{deviceId,config}})});assert.equal(register.status,200);const token=(await register.json()).value.deviceToken;
    async function open(){const service=new StationService(root);await service.storage.load();service.localReady=true;await service.storage.update(s=>{s.deviceId=deviceId;s.config=config;});const connection=new CollaborationConnection({url:info.url,token,deviceId,onSnapshot:async snapshot=>{await service.storage.update(s=>{s.snapshot=snapshot;});},onEvent:async e=>{await service.storage.update(s=>{s.snapshot.entities[e.kind]=[...(s.snapshot.entities[e.kind]??[]).filter(r=>r.id!==e.id),e.value];s.snapshot.cursor=e.seq;});},onStatus:connected=>{service.connected=connected;},onReady:async()=>{}});service.connection=connection;connections.push(connection);connection.start();await until(()=>service.connected);return service;}
    let service=await open();const meeting=await service.action('command',{action:'meeting.create',payload:{title:'isolated outbox',members:[],hostAgentId:'codex',autoAssign:false,autoApprovePlan:false}});
    const id=randomUUID(),payload={meetingId:meeting.id,text:'same text is allowed as an explicit next message',attachments:[]};let original;
    const deliver=service.connection.command.bind(service.connection);service.connection.command=async command=>{const result=await deliver(command);if(command.requestId===id){original=result.value;throw new Error('Injected response loss after real Hub commit');}return result;};
    const pending=await service.action('command',{action:'message.send',payload,requestId:id});assert.equal(pending.pending,true);assert.equal(service.view().messageSubmissions.find(s=>s.requestId===id).status,'pending');
    const saved=JSON.parse(await readFile(join(root,'station-v2.json'),'utf8'));assert.equal(saved.outbox.find(c=>c.action==='message.send').requestId,id);
    service.connection.stop();const restarted=line('restarted');child.stdin.write('restart\n');await restarted;
    service=await open();assert.equal(service.view().messageSubmissions.find(s=>s.requestId===id).status,'pending');
    const recovered=await service.action('message.reconcile',{requestId:id});assert.equal(recovered.id,original.id);assert.equal(service.view().messageSubmissions.find(s=>s.requestId===id).status,'accepted');assert.equal(service.storage.read().outbox.length,0);
    await until(()=>service.view().snapshot.entities.message?.some(m=>m.id===original.id));assert.equal(service.view().snapshot.entities.message.filter(m=>m.submissionId===id).length,1);
    let executions=0;service.hosts.set(meeting.id,{input:async message=>{executions++;await service.checkpointHost(meeting.id,message.id,'completed');}});await service.doPump();await until(()=>service.storage.read().hostMessages?.[original.id]==='completed');await service.doPump();assert.equal(executions,1);
    await assert.rejects(service.action('command',{action:'message.send',payload:{...payload,text:'changed'},requestId:id}),/身份/);
    const fresh=await service.action('command',{action:'message.send',payload,requestId:randomUUID()});assert.notEqual(fresh.id,original.id);
    service.connection.stop();const offlineId=randomUUID();const offline=await service.action('command',{action:'message.send',payload:{...payload,text:'saved before transport'},requestId:offlineId});assert.equal(offline.pending,true);
    service=await open();await service.flush();await until(()=>service.view().snapshot.entities.message?.length===3);assert.equal(service.view().snapshot.entities.message.filter(m=>m.submissionId===offlineId).length,1);
  }finally{for(const connection of connections)connection.stop();child.stdin.end('\n');if(child.exitCode===null)await new Promise(r=>child.once('exit',r));if(previous===undefined)delete process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK;else process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK=previous;await rm(root,{recursive:true,force:true});}
});
