import test from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {app} from 'electron';
import {StationService} from '../dist-electron/collaboration/station-service.js';import {CollaborationConnection,STATION_FEATURES} from '../dist-electron/collaboration/connection.js';
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const until=async(fn)=>{for(let n=0;n<1000;n++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('production behavior did not progress');};
test('H02/H08 production WSS: suspended stop retains its input while real tasks, capacity, approvals, acknowledgments and delivery progress',{timeout:60000},async()=>{
 assert.ok(process.env.COLLABORATION_PYTHON);const root=await mkdtemp(join(tmpdir(),'station-hardening-scheduling-')),oldPath=app.getPath,oldTest=process.env.AHASTATION_ENABLE_TEST_AGENT,oldLoopback=process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK;
 app.getPath=()=>root;process.env.AHASTATION_ENABLE_TEST_AGENT='1';process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK='1';
 const child=spawn(process.env.COLLABORATION_PYTHON,['services/remote/tests/station_collaboration_fixture.py'],{windowsHide:true,stdio:['pipe','pipe','pipe']});const lines=createInterface({input:child.stdout});let errors='';child.stderr.on('data',v=>errors+=v);let b,connection;const stop=gate(),entered=gate();let calls=0;
 try{
  const info=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(errors)),15000);lines.on('line',line=>{try{const r=JSON.parse(line);if(r.ready){clearTimeout(timer);resolve(r);}}catch{}});});
  const post=async(token,action,payload)=>{const r=await fetch(info.url+'/api/collaboration/v2/commands',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Station-Features':STATION_FEATURES},body:JSON.stringify({protocol:2,requestId:randomUUID(),action,payload})});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result.value;};
  const config={name:'owned scheduling receiver',platform:'windows',acceptingTasks:true,maxConcurrency:2,agents:[{agentId:'file-test',backendId:'file-test',available:true,executionModes:['worker']},{agentId:'codex',backendId:'codex',available:true,executionModes:['worker']}]};
  const A=randomUUID(),B=randomUUID(),a=(await post(info.token,'device.register',{deviceId:A,config})).deviceToken,token=(await post(info.token,'device.register',{deviceId:B,config})).deviceToken;
  // The coordinator's genuine WSS presence is required by task receipt rules.
  const aConnection=new CollaborationConnection({url:info.url,token:a,deviceId:A,onSnapshot:async()=>{},onEvent:async()=>{},onStatus:()=>{}});connection=aConnection;aConnection.start();await until(()=>aConnection.connected);
  b=new StationService(join(root,'B'));await b.storage.load();b.localReady=true;const pump=b.pump.bind(b);b.pump=async()=>{};
  await b.storage.update(s=>{s.deviceId=B;s.serviceUrl=info.url;s.config={...config,maxConcurrency:1};s.allowedAgents=['codex','file-test'];});
  const wire=new CollaborationConnection({url:info.url,token,deviceId:B,onSnapshot:async(snapshot,valid=()=>true)=>{await b.storage.update(s=>{if(valid())s.snapshot=snapshot;});},onEvent:e=>b.event(e),onStatus:c=>{b.connected=c;}});b.connection=wire;wire.start();await until(()=>b.connected);
  const meeting=await post(a,'meeting.create',{title:'suspended stop',members:[B],participants:[{deviceId:B,agentId:'codex'},{deviceId:B,agentId:'file-test'}],autoApprovePlan:false,autoAssign:false});
  const expert=await post(a,'message.send',{meetingId:meeting.id,text:'owned control fault fixture; no model launched',targetDeviceId:B,targetAgentId:'codex'});await until(()=>b.rows('message').some(m=>m.id===expert.id));
  await b.storage.update(s=>{s.hostMessages={[expert.id]:'reconcile'};});b.discussions.set(expert.id,{stop:()=>{calls++;entered.resolve();return stop.promise;},close(){}});await post(a,'message.stop',{messageId:expert.id});await until(()=>b.rows('message').find(m=>m.id===expert.id)?.stopRequested);b.pump=pump;await b.doPump();await entered.promise;
  async function taskIn(m,objective){const payload={meetingId:m.id,title:objective,objective,targetDeviceId:B,agentId:'file-test',resource:'text',permission:'read-only',dependencies:[],inputs:[]};const plan=await post(a,'plan.propose',{meetingId:m.id,tasks:[payload]});await post(a,'plan.decide',{meetingId:m.id,expectedRevision:plan.revision,approved:true});return post(a,'task.create',payload);}
  const first=await taskIn(meeting,'[approval] real task waits for a tool decision');await until(()=>b.rows('approval').some(p=>p.taskId===first.id));assert.equal(b.storage.read().receipts[first.id].executionInvoked,true);
  const otherMeeting=await post(a,'meeting.create',{title:'independent meeting',members:[B],autoApprovePlan:false,autoAssign:false});const other=await taskIn(otherMeeting,'independent actual result');
  await until(()=>b.storage.read().receipts[other.id]?.status==='received');assert.notEqual(b.storage.read().receipts[other.id].executionInvoked,true,'capacity=1 retains the genuine wait');
  await b.storage.update(s=>{s.config.maxConcurrency=2;});await b.doPump();await until(()=>b.rows('task').find(t=>t.id===other.id)?.status==='delivered');assert.equal(b.storage.read().receipts[other.id].turnOutcome,'completed');assert.equal(calls,1,'same unresolved stop is never repeated');
  const approval=b.rows('approval').find(p=>p.taskId===first.id);await post(a,'approval.decide',{approvalId:approval.id,decision:'allow'});await until(()=>b.rows('task').find(t=>t.id===first.id)?.status==='delivered');
  const disk=JSON.parse(await readFile(join(root,'B/station-v2.json'),'utf8'));for(const t of [first,other]){assert.equal(disk.receipts[t.id].status,'delivered');assert.equal(disk.receipts[t.id].exitConfirmed,true);assert.match(disk.receipts[t.id].delivery.summary,/非模型双文件交付/);}
  assert.equal(disk.hostMessages[expert.id],'reconcile');assert.notEqual(b.rows('message').find(m=>m.id===expert.id)?.exitConfirmed,true);assert.equal(calls,1);stop.resolve(false);await Promise.allSettled([...b.objectJobs.values()]);
 }finally{
  stop.resolve(false);if(b){await Promise.allSettled([...b.objectJobs.values()]);b.connection?.stop();}connection?.stop();lines.close();child.stdin.end('\n');if(child.exitCode===null)await new Promise(r=>child.once('exit',r));app.getPath=oldPath;for(const [key,v] of [['AHASTATION_ENABLE_TEST_AGENT',oldTest],['AHASTATION_REMOTE_ALLOW_LOOPBACK',oldLoopback]])if(v===undefined)delete process.env[key];else process.env[key]=v;await rm(root,{recursive:true,force:true});
 }
});
