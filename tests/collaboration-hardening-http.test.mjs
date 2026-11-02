import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {StationService} from '../dist-electron/collaboration/station-service.js';
import {CollaborationConnection,STATION_FEATURES} from '../dist-electron/collaboration/connection.js';
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const until=async(fn)=>{for(let n=0;n<800;n++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('production synchronization timed out');};
test('H04-H07 production HTTP/WSS and real disk reconcile races, existing broken receipts and restarts',{timeout:90000},async()=>{
 assert.ok(process.env.COLLABORATION_PYTHON);const root=await mkdtemp(join(tmpdir(),'station-hardening-http-'));
 const child=spawn(process.env.COLLABORATION_PYTHON,['services/remote/tests/station_collaboration_fixture.py'],{windowsHide:true,stdio:['pipe','pipe','pipe']});const lines=createInterface({input:child.stdout});let err='';child.stderr.on('data',v=>err+=v);let connection;
 const savedLoopback=process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK;process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK='1';
 try{
  const info=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(err)),20000);lines.on('line',line=>{try{const r=JSON.parse(line);if(r.ready){clearTimeout(timer);resolve(r);}}catch{}});});
  const post=async(token,command)=>{const response=await fetch(info.url+'/api/collaboration/v2/commands',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Station-Features':STATION_FEATURES},body:JSON.stringify(command)});const reply=await response.json();assert.equal(response.status,200,JSON.stringify(reply));return reply;};
  const deviceId=randomUUID(),config={name:'owned hardening sender',platform:'windows',acceptingTasks:false,maxConcurrency:1,agents:[]};
  const reg=await post(info.token,{protocol:2,requestId:randomUUID(),action:'device.register',payload:{deviceId,config}}),token=reg.value.deviceToken;
  const meeting=(await post(token,{protocol:2,requestId:randomUUID(),action:'meeting.create',payload:{title:'hardening HTTP',members:[],hostAgentId:'codex',autoAssign:false,autoApprovePlan:false}})).value;
  const service=new StationService(root);await service.storage.load();service.localReady=true;service.connected=true;service.pump=async()=>{};await service.storage.update(s=>{s.deviceId=deviceId;s.config=config;s.serviceUrl=info.url;s.ownerId=info.owner;});
  const request=async(route)=>{const response=await fetch(info.url+route,{headers:{Authorization:'Bearer '+token,'X-Station-Features':STATION_FEATURES}});assert.equal(response.status,200);return response.json();};
  for(const order of ['success-then-failure','failure-then-success','double-success-reversed']){
   const command={protocol:2,requestId:randomUUID(),action:'message.send',payload:{meetingId:meeting.id,text:'intentional identical body',attachments:[]}};await service.storage.update(s=>{s.outbox.push(command);(s.messageSubmissions??={})[command.requestId]={requestId:command.requestId,meetingId:meeting.id,text:command.payload.text,status:'pending',command};});
   const barriers=[gate(),gate()],entered=[gate(),gate()];let calls=0;
   service.connection={connected:true,request,command:async c=>{const index=calls++,result=await post(token,c);entered[index].resolve();await barriers[index].promise;return result;}};
   // Directly exercise two already-in-flight transmissions, as can exist in
   // the old build; new public entries additionally coalesce them by identity.
   const a=service.performDeliver(command),b=service.performDeliver(command);const observedA=a.catch(e=>e),observedB=b.catch(e=>e);await Promise.all(entered.map(g=>g.promise));
   if(order==='failure-then-success'){barriers[0].reject(new Error('lost first response'));await observedA;barriers[1].resolve();}
   else {barriers[1].resolve();await observedB;if(order==='double-success-reversed')barriers[0].resolve();else barriers[0].reject(new Error('late old failure'));}
   await Promise.all([observedA,observedB]);assert.equal(service.storage.read().messageSubmissions[command.requestId].status,'accepted');assert.equal(service.storage.read().messageSubmissions[command.requestId].error,undefined);
   assert.equal((await request('/api/collaboration/v2/snapshot')).entities.message.filter(m=>m.submissionId===command.requestId).length,1);
  }
  const id=randomUUID(),payload={meetingId:meeting.id,text:'retained original @ and selected inputs',attachments:[]};const original=(await post(token,{protocol:2,requestId:id,action:'message.send',payload})).value;
  await service.storage.update(s=>{s.messageSubmissions[id]={requestId:id,meetingId:meeting.id,text:'',messageId:original.id,status:'pending',error:'old late failure'};s.outbox=[];s.snapshot={protocol:2,cursor:0,entities:{}};});
  const restarted=new StationService(root);await restarted.storage.load();restarted.localReady=true;let posts=0;restarted.connection={connected:true,request,command:async()=>{posts++;throw new Error('must not reconstruct the body');}};
  await restarted.action('message.reconcile',{requestId:id});assert.equal(restarted.storage.read().messageSubmissions[id].status,'accepted');assert.equal(posts,0);
  const unknown=randomUUID();await restarted.storage.update(s=>{s.messageSubmissions[unknown]={requestId:unknown,meetingId:meeting.id,text:'',messageId:original.id,status:'pending'};});await restarted.action('message.reconcile',{requestId:unknown});assert.equal(restarted.storage.read().messageSubmissions[unknown].status,'pending');assert.match(restarted.storage.read().messageSubmissions[unknown].error,/原命令缺失/);assert.equal(posts,0);
  const wssId=randomUUID(),wssCommand={protocol:2,requestId:wssId,action:'message.send',payload};const responseGate=gate(),hubCommitted=gate();
  connection=new CollaborationConnection({url:info.url,token,deviceId,onSnapshot:async snapshot=>{await restarted.storage.update(s=>{s.snapshot=snapshot;restarted.reconcileSnapshotSubmissions(s);});},onEvent:e=>restarted.event(e),onStatus:ready=>{restarted.connected=ready;}});restarted.connection=connection;connection.start();await until(()=>restarted.connected);
  const direct=connection.command.bind(connection);connection.command=async c=>{const result=await direct(c);if(c.requestId===wssId){hubCommitted.resolve();await responseGate.promise;}return result;};
  const sending=restarted.send('message.send',payload,wssId);const observed=sending.catch(e=>e);await hubCommitted.promise;
  await until(()=>restarted.storage.read().messageSubmissions[wssId].status==='accepted');responseGate.reject(new Error('HTTP lost after WSS confirmed'));await observed;
  assert.equal(restarted.storage.read().messageSubmissions[wssId].status,'accepted');assert.equal(restarted.storage.read().outbox.some(c=>c.requestId===wssId),false);
  const next=await restarted.send('message.send',payload,randomUUID());assert.notEqual(next.id,original.id);
  const disk=JSON.parse(await readFile(join(root,'station-v2.json'),'utf8'));assert.equal(disk.messageSubmissions[wssId].status,'accepted');assert.deepEqual(disk.messageSubmissions[wssId].command.payload,payload);
 }finally{connection?.stop();lines.close();child.stdin.end('\n');if(child.exitCode===null)await new Promise(r=>child.once('exit',r));if(savedLoopback===undefined)delete process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK;else process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK=savedLoopback;await rm(root,{recursive:true,force:true});}
});
