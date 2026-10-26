import {verifiedFixture} from './fixtures/collaboration-delivery.mjs';
import * as deliveryContract from '../dist-electron/collaboration/delivery-identity.js';
import {deliveryIdentity} from '../dist-electron/collaboration/delivery-identity.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {app,safeStorage} from 'electron';
import {updateRemoteControlFields,flushSettingsWrites} from '../dist-electron/store.js';
import {randomUUID,createHash} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {once} from 'node:events';
import vm from 'node:vm';
import ts from 'typescript';
import {StationService} from '../dist-electron/collaboration/station-service.js';
import {UnifiedMeetingHost} from '../dist-electron/collaboration/unified-host.js';
import {CollaborationConnection} from '../dist-electron/collaboration/connection.js';
import {pendingBaseRevisions,dependencyWait} from '../dist-electron/collaboration/plan-revision.js';
import {git} from '../dist-electron/collaboration/workspaces.js';

const snapshot=(meeting,messages=[],tasks=[])=>({protocol:2,cursor:0,entities:{meeting:[meeting],message:messages,task:tasks}});
const initial=snapshot=>({deviceId:'A',config:{maxConcurrency:1,acceptingTasks:false},allowedAgents:[],receipts:{},snapshot,outbox:[],bindings:{},directories:{},checks:{}});
function memory(service,state){service.storage.read=()=>structuredClone(state);service.storage.update=async f=>{f(state);};service.connected=true;}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('R1 confirmed preflight failure is terminal failure and next Host input runs',async()=>{
  const stages={};const m={id:'m',revision:1,coordinatorDeviceId:'A',hostAgentId:'codex',members:[],planApproved:false};
  const bad={id:'bad',revision:1,meetingId:m.id,route:'host',text:'read attachment',createdAt:1};
  const next={...bad,id:'next',text:'plain question',createdAt:2};let launches=0;
  const host=new UnifiedMeetingHost(m,()=>snapshot(m),'.unused-review-folder',{
    checkpoint:async(id,status)=>{stages[id]=status;},reply:async()=>{},session:async()=>{},plan:async()=>{},consult:async()=>{},control:async()=>{},
    prepareInput:async()=>{throw new Error('资料未绑定');},
  });
  host.start=async()=>{host.orch={sendUserText(){launches++;}};};
  await assert.rejects(host.input(bad),/资料未绑定/);assert.equal(launches,0);assert.equal(stages.bad,'failed');
  const state=initial(snapshot(m,[bad,next]));state.hostMessages=stages;
  const service=new StationService('.unused-review-state');memory(service,state);let scheduled=0;
  service.hosts.set(m.id,{input:async()=>{scheduled++;}});await service.doPump();await tick();assert.equal(scheduled,1);
});

test('R2 old dependent baseline waits without aborting independent dispatch or tool decisions',async()=>{
  const first={id:'first',revision:1,planTaskId:'first',meetingId:'m',targetDeviceId:'B',agentId:'codex',resource:'repository',projectId:'p',status:'delivered',integration:'verified',attemptId:'a1',dependencies:[],pendingFollowups:[]};
  const follow={meetingId:'m',planTaskId:'second',title:'dependent',objective:'use first',targetDeviceId:'B',agentId:'codex',resource:'repository',permission:'workspace-write',projectId:'p',baseCommit:'a'.repeat(40),dependencies:['first'],inputs:[]};
  const independent={...follow,planTaskId:'independent',resource:'text',dependencies:[]};
  const m={id:'m',revision:2,coordinatorDeviceId:'A',members:['B'],planApproved:true,plan:[follow,independent],verifiedCommit:'b'.repeat(40)};
  const state=initial(snapshot(m,[],[first]));state.bindings.p={confirmed:true};state.meetingWorkspaces={m:'unused-existing-workspace'};
  state.snapshot.entities.device=[{id:'B',online:true,acceptingTasks:true,agents:[{agentId:'codex',available:true}]}];state.snapshot.entities.binding=[{projectId:'p',deviceId:'B',state:'ready'}];state.snapshot.entities.approval=[{id:'approval',decision:'allow'}];
  const service=new StationService('.unused-review-state');memory(service,state);service.error=async()=>{};let decisions=0;const dispatched=[];
  service.approvals.set('approval',()=>decisions++);service.send=async(action,payload)=>{dispatched.push({action,payload});return {};};
  await service.doPump();assert.equal(decisions,1);assert.deepEqual(dispatched.filter(x=>x.action==='task.create').map(x=>x.payload.planTaskId),['independent']);assert.equal(follow.baseCommit,'a'.repeat(40));
});

test('R3 legacy business 403 preserves valid credential and HTTP connection',async()=>{
  const server=createServer((req,res)=>{res.writeHead(req.url==='/forbidden'?403:200,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url==='/forbidden'?{detail:'Only the original coordinating device may dispatch'}:{protocol:2,cursor:0,entities:{}}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');const status=[];
  const connection=new CollaborationConnection({url:'http://127.0.0.1:'+server.address().port,token:'owned-test-token',onSnapshot:async()=>{},onEvent:async()=>{},onStatus:(...args)=>status.push(args)});connection.connected=true;
  try{await assert.rejects(connection.request('/forbidden'),/Only the original/);assert.equal(connection.connected,true);assert.ok(!status.some(s=>s[2]));assert.equal((await connection.request('/api/collaboration/v2/snapshot')).protocol,2);}
  finally{connection.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

async function renderer(){
  const commands=[];let view;const modules=new Map();const require=createRequire(import.meta.url);
  async function load(path){const exports={};modules.set(path,exports);const source=await readFile(new URL('../'+path,import.meta.url),'utf8');const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;vm.runInNewContext(js,{exports,require:name=>(name==='./delivery-identity.js'||name==='../../electron/collaboration/delivery-identity')?deliveryContract:name==='./shared-mentions'?modules.get('src/lib/shared-mentions.ts'):name==='../../electron/collaboration/plan-revision'?modules.get('electron/collaboration/plan-revision.ts'):require(name),window:{vibeMeet:{collaboration:{request:async(action,payload)=>action==='status'?{ok:true,value:view}:(commands.push(payload),{ok:true,value:{}})}}},console,localStorage:{getItem:()=>null,setItem:()=>{}}});return exports;}
  try{await load('src/lib/shared-mentions.ts');}catch(error){if(error.code!=='ENOENT')throw error;}
  await load('electron/collaboration/plan-revision.ts');
  const store=await load('src/lib/unified-meeting-store.ts');return {store,commands,setView:v=>{view=v;},mentions:modules.get('src/lib/shared-mentions.ts')};
}
test('R4 selected Chinese mention keeps stable identity across rename; copied stale label cannot fall back to Host',async()=>{
  const {store,commands,setView}=await renderer();const m={id:'m',revision:1,coordinatorDeviceId:'A',members:['B'],participants:[{deviceId:'B',agentId:'codex'}]};
  const view={deviceId:'A',config:{},snapshot:snapshot(m)};view.snapshot.entities.device=[{id:'B',name:'办公电脑',online:true}];const before=store.projectShared(view,m.id);const member=before.members[0];const text='@'+member.label+' 讨论方案';
  const binding={start:0,end:member.label.length+1,text:'@'+member.label,memberId:member.id,deviceId:member.deviceId,agentId:member.agentId};
  view.snapshot.entities.device[0].name='改名后的电脑';setView(view);await store.refreshShared();await store.sendShared(before,text,undefined,[],[binding]);
  assert.equal(commands.at(-1).payload.targetDeviceId,'B');assert.equal(commands.at(-1).payload.targetAgentId,'codex');
  await assert.rejects(store.sendShared(before,text),/@/);
});

export {renderer,initial,memory,snapshot};

test('R1 start failure resets Host startup and a separate valid input executes once',async()=>{
  const m={id:'m',hostAgentId:'fixture'};const stages={};let starts=0,turns=0;
  const host=new UnifiedMeetingHost(m,()=>snapshot(m),'.unused-host',{
    checkpoint:async(id,status)=>{stages[id]=status;},reply:async()=>{},session:async()=>{},plan:async()=>{},consult:async()=>{},control:async()=>{},
  });
  host.start=async()=>{if(++starts===1)throw new Error('startup unavailable');host.orch={hostSessionSnapshot:()=>null,sendUserText(){turns++;setImmediate(()=>host.event({source:'talker',event:{kind:'turn-status',status:'completed'}}));}};};
  await assert.rejects(host.input({id:'bad',text:'first'}),/startup/);await host.input({id:'next',text:'next'});assert.equal(stages.bad,'failed');assert.equal(stages.next,'completed');assert.equal(turns,1);assert.equal(starts,2);
});
test('R1 checkpoint failure before invocation never calls backend; uncertain started turn never replays',async()=>{
  let fail=true,turns=0;const stages={};const m={id:'m',hostAgentId:'fixture',coordinatorDeviceId:'A'};
  const host=new UnifiedMeetingHost(m,()=>snapshot(m),'.unused-host',{
    checkpoint:async(id,status)=>{if(fail&&status==='starting'){fail=false;throw new Error('disk write failed');}stages[id]=status;},reply:async()=>{},session:async()=>{},plan:async()=>{},consult:async()=>{},control:async()=>{},
  });
  host.start=async()=>{host.orch={sendUserText(){turns++;setImmediate(()=>host.event({source:'talker',event:{kind:'error',error:'execution outcome unknown'}}));}};};
  await assert.rejects(host.input({id:'before',text:'first'}),/disk write/);assert.equal(turns,0);assert.equal(stages.before,'failed');
  await assert.rejects(host.input({id:'started',text:'second'}),/unknown/);assert.equal(turns,1);assert.equal(stages.started,'reconcile');
  const state=initial(snapshot({...m,hostAgentId:'codex'},[{id:'started',meetingId:'m',route:'host'},{id:'next',meetingId:'m',route:'host'}]));state.hostMessages=stages;
  const service=new StationService('.unused-recovery');memory(service,state);let scheduled=0;service.hosts.set('m',{input:async()=>scheduled++});service.inspectHost=async()=>({result:null});
  await service.recoverReceipts();await service.doPump();assert.equal(scheduled,0);assert.equal(state.hostMessages.started,'reconcile');
});
test('R1 restart closes preparing and sealed unstarted attempts as failure, preserving errors and freeing next input',async()=>{
  const m={id:'m',hostAgentId:'codex',coordinatorDeviceId:'A'};const messages=['preparing','legacy','next'].map(id=>({id,meetingId:'m',route:'host'}));
  const state=initial(snapshot(m,messages));state.hostMessages={preparing:'preparing',legacy:'reconcile'};const service=new StationService('.unused-recovery');memory(service,state);service.send=async()=>({});
  service.inspectHost=async()=>({result:{cleanup_confirmed:true,ok:false,not_started:true,error:'confirmed not started'}});let turns=0;service.hosts.set('m',{input:async()=>turns++});
  await service.recoverReceipts();assert.equal(state.hostMessages.preparing,'failed');assert.equal(state.hostMessages.legacy,'failed');assert.equal(state.hostFailures.legacy.notStarted,true);await service.doPump();await tick();assert.equal(turns,1);
});
test('R1 stopping while input preparation is pending prevents a delayed model launch',async()=>{
  let release,entered;const gate=new Promise(r=>{release=r;}),ready=new Promise(r=>{entered=r;});const stages={};let launches=0;
  const host=new UnifiedMeetingHost({id:'m',hostAgentId:'codex'},()=>snapshot({id:'m'}),'.unused-host',{
    checkpoint:async(id,status)=>{stages[id]=status;},reply:async()=>{},session:async()=>{},plan:async()=>{},consult:async()=>{},control:async()=>{},prepareInput:async()=>{entered();await gate;return {text:'prepared',images:[]};},
  });host.start=async()=>{host.orch={sendUserText(){launches++;}};};const turn=host.input({id:'input',text:'prepare'});await ready;assert.equal(await host.stop(),true);release();await assert.rejects(turn,/启动前停止/);assert.equal(launches,0);assert.equal(stages.input,'failed');
});
test('R2 revision is exact, derived idempotently, restricted to undispatched tasks and all successful dependencies',()=>{
  const a={id:'a-id',planTaskId:'a',meetingId:'m',status:'delivered',integration:'verified'};const b={id:'b-id',planTaskId:'b',meetingId:'m',status:'delivered',integration:'verified'};
  const dependent={planTaskId:'c',resource:'repository',baseCommit:'a'.repeat(40),dependencies:['a','b']};const meeting={id:'m',verifiedCommit:'b'.repeat(40),plan:[dependent]};const snap=snapshot(meeting,[],[a,b]);
  verifiedFixture(a);verifiedFixture(b);
  const expected=pendingBaseRevisions(snap,meeting);assert.equal(expected.length,1);assert.equal(expected[0].toCommit,meeting.verifiedCommit);assert.equal(dependent.baseCommit,'a'.repeat(40));assert.deepEqual(pendingBaseRevisions(structuredClone(snap),structuredClone(meeting)),expected);
  b.stopRequested=true;assert.equal(pendingBaseRevisions(snap,meeting).length,0);assert.match(dependencyWait(snap,'m',dependent),/停止/);delete b.stopRequested;b.integration='revalidation-required';assert.equal(pendingBaseRevisions(snap,meeting).length,0);
  b.integration='verified';snap.entities.task.push({id:'c-id',planTaskId:'c',meetingId:'m'});assert.equal(pendingBaseRevisions(snap,meeting).length,0);
});
test('R2 revised exact commit passes real local Git authorization and receiver executes once in that worktree', {timeout:45000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'station-revised-sha-'));const repo=join(root,'repo'),work=join(root,'work');await mkdir(repo);await mkdir(work);const previous=process.env.AHASTATION_ENABLE_TEST_AGENT;process.env.AHASTATION_ENABLE_TEST_AGENT='1';let receiver;
  try{
    await git(repo,['init','-b','main']);await git(repo,['config','core.autocrlf','false']);await git(repo,['config','user.name','Isolated fixture']);await git(repo,['config','user.email','fixture@example.invalid']);await git(repo,['remote','add','origin','git@github.com:fixture/revised-sha.git']);
    await writeFile(join(repo,'baseline.txt'),'old baseline\n');await git(repo,['add','.']);await git(repo,['commit','-m','initial']);const oldSha=await git(repo,['rev-parse','HEAD']);
    await writeFile(join(repo,'baseline.txt'),'verified predecessor\n');await git(repo,['commit','-am','predecessor integration fixture']);const newSha=await git(repo,['rev-parse','HEAD']);
    const meetingId=randomUUID(),projectId=randomUUID(),target=randomUUID();const proposed={meetingId,planTaskId:'dependent',title:'whole dependent delivery',objective:'complete two files after approved revision',targetDeviceId:target,agentId:'file-test',resource:'repository',permission:'workspace-write',projectId,baseCommit:oldSha,dependencies:['predecessor'],inputs:[]};
    const meeting={id:meetingId,revision:1,coordinatorDeviceId:'A',members:[target],planApproved:true,plan:[proposed],verifiedCommit:newSha};
    const predecessor={id:'predecessor-id',planTaskId:'predecessor',meetingId,status:'delivered',integration:'verified',exitConfirmed:true,resource:'repository',pendingFollowups:[]};const snap=snapshot(meeting,[],[predecessor]);
    verifiedFixture(predecessor);
    const agent={agentId:'file-test',backendId:'file-test',available:true,executionModes:['worker']};snap.entities.device=[{id:target,online:true,acceptingTasks:true,agents:[agent]}];snap.entities.project=[{id:projectId,revision:1,name:'owned Git fixture',repository:{provider:'github',canonicalUrl:'https://github.com/fixture/revised-sha'}}];snap.entities.binding=[{projectId,deviceId:target,state:'ready'}];
    const state=initial(snap);state.bindings[projectId]={confirmed:true};state.meetingWorkspaces={[meetingId]:repo};const dispatcher=new StationService(join(root,'dispatcher'));memory(dispatcher,state);let creates=0;let created;
    dispatcher.send=async(action,payload)=>{assert.equal(action,'task.create');creates++;created={...payload,id:randomUUID(),revision:1,attemptId:randomUUID(),status:'offered',pendingFollowups:[],stopRequested:false};state.snapshot.entities.task.push(created);return created;};
    await dispatcher.doPump();assert.equal(creates,0);assert.equal(pendingBaseRevisions(snap,meeting)[0].toCommit,newSha);
    // Server-side plan.review approval and immutable history are covered by
    // the real Hub test; here its resulting approved snapshot is injected.
    state.snapshot.entities.meeting[0].plan=[{...proposed,baseCommit:newSha}];state.snapshot.entities.meeting[0].revision++;
    await dispatcher.doPump();await dispatcher.doPump();assert.equal(creates,1);assert.equal(created.baseCommit,newSha);
    const local=initial(structuredClone(state.snapshot));local.deviceId=target;local.config={acceptingTasks:true,maxConcurrency:1,agents:[agent]};local.allowedAgents=['file-test'];local.bindings[projectId]={schemaVersion:1,projectId,deviceId:target,localRepoRoot:repo,taskWorkspaceRoot:work,permissionCeiling:'workspace-write',allowedAgentIds:['file-test'],confirmed:true,revision:1};
    receiver=new StationService(join(root,'receiver'));memory(receiver,local);receiver.send=async()=>({});receiver.deliverTask=async()=>{}; // No GitHub publication in this local execution check.
    const start=receiver.startTask.bind(receiver);let starts=0;receiver.startTask=async(...args)=>{starts++;return start(...args);};await receiver.doPump();
    for(let n=0;n<800&&local.receipts[created.id]?.status!=='executed';n++)await new Promise(r=>setTimeout(r,25));
    const receipt=local.receipts[created.id];assert.equal(receipt?.status,'executed',local.error);assert.equal(receipt.exitConfirmed,true);assert.equal(await git(receipt.cwd,['rev-parse','HEAD']),newSha);assert.equal(await readFile(join(receipt.cwd,'baseline.txt'),'utf8'),'verified predecessor\n');assert.match(await readFile(join(receipt.cwd,'delivery.txt'),'utf8'),/complete two files/);
    const thread=receipt.nativeThreadId;await receiver.doPump();await receiver.doPump();assert.equal(starts,1);assert.equal(local.receipts[created.id].nativeThreadId,thread);assert.equal(await git(repo,['status','--porcelain']),'');
  }finally{for(const handle of receiver?.active.values()??[])await handle.stop();if(previous===undefined)delete process.env.AHASTATION_ENABLE_TEST_AGENT;else process.env.AHASTATION_ENABLE_TEST_AGENT=previous;await rm(root,{recursive:true,force:true});}
});
test('R3 explicit auth errors stop connection; business codes and service outages never revoke a valid credential',async()=>{
  let mode='business';const server=createServer((_req,res)=>{const status=mode==='invalid'?401:mode==='outage'?503:403;res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({detail:{code:mode==='invalid'?'AUTH_INVALID':mode==='business'?'FORBIDDEN':'UNAVAILABLE',message:mode}}));});server.listen(0,'127.0.0.1');await once(server,'listening');const statuses=[];
  const c=new CollaborationConnection({url:'http://127.0.0.1:'+server.address().port,token:'owned',onSnapshot:async()=>{},onEvent:async()=>{},onStatus:(...s)=>statuses.push(s)});c.connected=true;
  try{for(mode of ['business','outage']){await assert.rejects(c.request('/op'));assert.equal(c.connected,true);assert.equal(statuses.length,0);}mode='invalid';await assert.rejects(c.request('/op'));assert.equal(c.connected,false);assert.equal(statuses.at(-1)[2],true);}
  finally{c.stop();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('R3 recovery requires server identity and a valid snapshot, never merely clearing the local flag',async()=>{
  let identity='A';const entities=Object.fromEntries(['device','project','binding','meeting','message','task','approval','native','history','nativecontrol'].map(k=>[k,[]]));entities.device=[{id:'A',revision:1,name:'A',platform:'windows',acceptingTasks:false,maxConcurrency:1,agents:[],online:true,revoked:false,lastSeenAt:0,connectionGeneration:1,activeTasks:0}];
  const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url.endsWith('/identity')?{deviceId:identity}:{protocol:2,cursor:0,entities}));});server.listen(0,'127.0.0.1');await once(server,'listening');const status=[];const c=new CollaborationConnection({url:'http://127.0.0.1:'+server.address().port,token:'owned',onSnapshot:async()=>{},onEvent:async()=>{},onStatus:(...s)=>status.push(s)});
  try{assert.equal((await c.validateCredential('A')).entities.device[0].id,'A');identity='B';await assert.rejects(c.validateCredential('A'),/不匹配/);assert.equal(status.at(-1)[2],true);}
  finally{c.stop();server.closeAllConnections();await new Promise(r=>server.close(r));}await assert.rejects(c.validateCredential('A'));assert.equal(c.connected,false);
});
test('R3 realtime authentication rejection invalidates; transient handshake failure preserves credentials',async()=>{
  let code=1013;const server=createServer();const wss=new WebSocketServer({server});wss.on('connection',socket=>socket.close(code));server.listen(0,'127.0.0.1');await once(server,'listening');const statuses=[];
  const connection=new CollaborationConnection({url:'http://127.0.0.1:'+server.address().port,token:'owned',onSnapshot:async()=>{},onEvent:async()=>{},onStatus:(...s)=>statuses.push(s)});
  const wait=async check=>{for(let n=0;n<100;n++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('WS status not observed');};
  try{connection.start();await wait(()=>statuses.length>0);assert.ok(!statuses.some(s=>s[2]));connection.stop();statuses.length=0;code=4401;connection.start();await wait(()=>statuses.some(s=>s[2]));assert.equal(connection.connected,false);}
  finally{connection.stop();for(const socket of wss.clients)socket.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
});
test('R4 editor edits, replacement, pasted labels, duplicate names, email, multiple and native recipients keep exact routing',async()=>{
  const {mentions}=await renderer();const {bindSharedMention:bind,editSharedMentions:edit,resolveSharedMention:resolve}=mentions;
  const a={id:'member-A-codex',deviceId:'A',agentId:'codex',label:'中文 电脑 + @测试',online:true};const b={...a,id:'member-B-codex',deviceId:'B'};const native={id:'native-B-exact',deviceId:'B',agentId:'codex',nativeSessionId:'exact',label:'同名 对话 / 接续',online:true};
  let text='@'+b.label+' /skill 讨论';let bindings=[bind(b,0)];assert.equal(resolve(text,bindings,[a,b]).deviceId,'B');
  const added='前缀 '+text;bindings=edit(text,added,bindings);assert.equal(resolve(added,bindings,[a,b]).deviceId,'B');assert.equal(bindings[0].start,3);
  const broken=added.replace('中文','改过');assert.equal(edit(added,broken,bindings).length,0);assert.throws(()=>resolve(broken,[],[a,b]),/@/);
  assert.equal(edit(added,'只聊方案',bindings).length,0);assert.equal(resolve('只聊方案 /skill contact test@example.com',[],[a,b]),undefined);
  assert.throws(()=>resolve(text,[],[a,b]),/@/);assert.throws(()=>resolve(text,[bind(b,0)],[a]),/离会/);assert.throws(()=>resolve(text,[bind(b,0)],[a,{...b,online:false}]),/离线/);
  const two='@'+a.label+' @'+b.label;assert.throws(()=>resolve(two,[bind(a,0),bind(b,a.label.length+2)],[a,b]),/一个/);
  const nt='@'+native.label+' 继续';assert.equal(resolve(nt,[bind(native,0)],[a,native]).nativeSessionId,'exact');assert.equal(resolve('@'+a.id+' 本机',[],[a,b]).deviceId,'A');
});

test('R1–R4 two Station services with production Hub: terminal recovery, exact plan revision, valid-token reconnect and renamed mention',
 {timeout:90000,skip:!process.env.COLLABORATION_PYTHON},async()=>{
  const root=await mkdtemp(join(tmpdir(),'station-review-integration-'));const originalPath=app.getPath;const previousEnv={test:process.env.AHASTATION_ENABLE_TEST_AGENT,loop:process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK};
  app.getPath=()=>root;safeStorage.isEncryptionAvailable=()=>true;safeStorage.encryptString=value=>Buffer.from('fixture:'+value);safeStorage.decryptString=value=>value.toString().replace(/^fixture:/,'');process.env.AHASTATION_ENABLE_TEST_AGENT='1';process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK='1';
  const child=spawn(process.env.COLLABORATION_PYTHON,['services/remote/tests/station_collaboration_fixture.py'],{stdio:['pipe','pipe','pipe'],windowsHide:true});const lines=createInterface({input:child.stdout});let stderr='';child.stderr.on('data',v=>{stderr=(stderr+v).slice(-4000);});let a,b;
  const until=async(check,why)=>{for(let n=0;n<600;n++){if(await check())return;await new Promise(r=>setTimeout(r,30));}assert.fail(why);};
  try{
    const fixture=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Hub startup: '+stderr)),20000);lines.on('line',line=>{try{const value=JSON.parse(line);if(value.ready){clearTimeout(timer);resolve(value);}}catch{}});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Hub exited: '+stderr));});});
    await updateRemoteControlFields(()=>({enabled:true,mode:'public',serviceUrl:fixture.url,ownerId:fixture.owner,controlToken:fixture.token}));
    a=new StationService(join(root,'A'));b=new StationService(join(root,'B'));await a.initialize();await b.initialize();await until(()=>a.view().connected&&b.view().connected,'both Stations online');
    const command=(service,action,payload)=>service.action('command',{action,payload});
    const meeting=await command(a,'meeting.create',{title:'review fixtures','members':[b.view().deviceId],participants:[{deviceId:b.view().deviceId,agentId:'file-test'}],hostAuthority:'original-orchestrator',hostAgentId:'codex',autoApprovePlan:false,autoAssign:false});
    // Only the model transport is deterministic. Input preparation, original
    // Host lifecycle, checkpoints, Station queues and Hub routes remain real.
    const host=a.coordinator(meeting);let modelTurns=0;host.start=async()=>{host.orch={hostSessionSnapshot:()=>null,sendUserText(){modelTurns++;setImmediate(()=>host.event({source:'talker',event:{kind:'turn-status',status:'completed'}}));},interruptHostReply:async()=>{},end(){}};};
    const bad=await command(a,'message.send',{meetingId:meeting.id,text:'read unbound material',attachments:[{repository:'https://github.com/fixture/materials',commit:'a'.repeat(40),paths:['selected.txt']}]});
    await until(()=>a.storage.read().hostMessages?.[bad.id]==='failed','unstarted input must fail');assert.equal(modelTurns,0);
    const next=await command(a,'message.send',{meetingId:meeting.id,text:'ordinary next input'});await until(()=>a.storage.read().hostMessages?.[next.id]==='completed','next input must proceed');
    host.hooks.prepareInput=async message=>({text:String(message.text),images:[]}); // repaired input fixture, no private project access
    const retry=await command(a,'message.retry',{messageId:bad.id});const repeated=await command(a,'message.retry',{messageId:bad.id});assert.equal(retry.id,repeated.id);await until(()=>a.storage.read().hostMessages?.[retry.id]==='completed','explicit retry must complete');assert.equal(modelTurns,2);
    // A coordinator-only operation reaches the real server and returns 403.
    await assert.rejects(b.send('task.control',{taskId:'nonexistent',attemptId:randomUUID(),operation:'review',evidence:'test'}));
    await assert.rejects(b.send('meeting.update',{meetingId:meeting.id,expectedRevision:meeting.revision,members:[],autoApprovePlan:false,autoAssign:false}),/coordinating/);assert.equal(b.view().connected,true);assert.notEqual(b.storage.read().credentialInvalid,true);
    const encrypted=b.storage.read().tokenEnc,deviceId=b.view().deviceId;
    b.connection.stop();await b.storage.update(s=>{s.credentialInvalid=true;});await b.action('connect');await until(()=>b.view().connected,'valid original credential must recover');assert.equal(b.storage.read().tokenEnc,encrypted);assert.equal(b.view().deviceId,deviceId);assert.equal(b.storage.read().credentialInvalid,false);
    // Rename between editor selection and submission, using the actual IPC
    // action adapter and the Hub's persisted structured recipient.
    const {store,setView,commands}=await renderer();await until(()=>a.view().snapshot.entities.device?.some(d=>d.id===deviceId),'snapshot knows B');setView(a.view());await store.refreshShared();const model=store.projectShared(a.view(),meeting.id),member=model.members[0];const mention={start:0,end:member.label.length+1,text:'@'+member.label,memberId:member.id,deviceId:member.deviceId,agentId:member.agentId};
    await b.action('configure',{config:{...b.view().config,name:'改名 中文 + 符号',acceptingTasks:false},allowedAgents:['file-test']});await until(()=>a.view().snapshot.entities.device?.find(d=>d.id===deviceId)?.name==='改名 中文 + 符号','rename propagated');setView(a.view());await store.refreshShared();
    // Capture validated renderer payload then submit with the real Station.
    await store.sendShared(model,mention.text+' 请讨论',undefined,[],[mention]);
    const sent=await command(a,'message.send',JSON.parse(JSON.stringify(commands.at(-1).payload)));assert.equal(sent.route,'agent');assert.equal(sent.targetDeviceId,deviceId);
    const project=await a.action('project.create',{name:'metadata-only baseline fixture',repository:'https://github.com/fixture/review'});
    // The fixture pauses the receiver while advertising a target, so this
    // portion tests exact dispatch and approval, not real model/Git execution.
    await a.storage.update(s=>{s.bindings[project.id]={confirmed:true};s.meetingWorkspaces={[meeting.id]:root};});
    await b.storage.update(s=>{s.config.acceptingTasks=true;});await b.publishConfig();await b.storage.update(s=>{s.config.acceptingTasks=false;});
    await b.send('binding.report',{schemaVersion:1,projectId:project.id,deviceId,state:'ready',bindingRevision:1});
    const first={meetingId:meeting.id,planTaskId:'first',title:'first','objective':'metadata first',targetDeviceId:deviceId,agentId:'file-test',resource:'repository',permission:'workspace-write',projectId:project.id,baseCommit:'a'.repeat(40),dependencies:[],inputs:[]};const second={...first,planTaskId:'second',title:'second',objective:'metadata second',dependencies:['first']};
    await assert.rejects(command(a,'plan.propose',{meetingId:meeting.id,tasks:[first,second]}),/version protection/);const basis=a.view().snapshot.entities.meeting.find(m=>m.id===meeting.id);let plan=await command(a,'plan.propose',{meetingId:meeting.id,expectedPlanVersion:Number(basis.planVersion??0),expectedPlanDecisionVersion:Number(basis.planDecisionVersion??0),tasks:[first,second]});await command(a,'plan.decide',{meetingId:meeting.id,expectedPlanVersion:plan.planVersion,approved:true});await until(()=>a.view().snapshot.entities.task?.some(t=>t.planTaskId==='first'),'first dispatch');
    const firstTask=a.view().snapshot.entities.task.find(t=>t.planTaskId==='first'),base={taskId:firstTask.id,attemptId:firstTask.attemptId};await b.send('task.receipt',{...base,bindingRevision:1});const delivery={summary:'metadata-only fixture',tests:'no Git execution claimed',files:[],commit:'b'.repeat(40),branch:'fixture',prUrl:'',report:{version:1,...base,summary:'metadata-only fixture',exitConfirmed:true,files:[],commit:'b'.repeat(40),tests:[],unresolved:['Isolated protocol metadata fixture; no actual Git execution or test claim']}};await b.send('task.event',{...base,status:'delivered',turnOutcome:'completed',exitConfirmed:true,delivery});const deliveryHash=createHash('sha256').update(deliveryIdentity({...firstTask,delivery})).digest('hex');await a.send('task.control',{...base,deliveryHash,operation:'review',evidence:'Current metadata and isolated test limitations inspected'});await a.send('task.control',{...base,deliveryHash,operation:'integrate',commit:'b'.repeat(40),evidence:'isolated protocol fixture only'});
    await until(()=>pendingBaseRevisions(a.view().snapshot,a.view().snapshot.entities.meeting.find(m=>m.id===meeting.id)).length===1,'second waits for visible revision');assert.equal(a.view().snapshot.entities.task.filter(t=>t.planTaskId==='second').length,0);
    plan=a.view().snapshot.entities.meeting.find(m=>m.id===meeting.id);await command(b,'plan.review',{meetingId:meeting.id,expectedPlanVersion:plan.planVersion,tasks:[first,{...second,baseCommit:'b'.repeat(40)}],approved:true});await until(()=>a.view().snapshot.entities.task?.some(t=>t.planTaskId==='second'),'approved exact new baseline dispatch');await a.pump();await a.pump();assert.equal(a.view().snapshot.entities.task.filter(t=>t.planTaskId==='second').length,1);assert.equal(a.view().snapshot.entities.task.find(t=>t.planTaskId==='second').baseCommit,'b'.repeat(40));
  }finally{
    for(const service of [a,b])if(service){service.closing=true;clearInterval(service.nativeTimer);clearInterval(service.recoveryTimer);service.connection?.stop();for(const host of service.hosts.values())host.close();}
    child.stdin.end();if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));lines.close();await flushSettingsWrites();app.getPath=originalPath;for(const [key,value] of [['AHASTATION_ENABLE_TEST_AGENT',previousEnv.test],['AHASTATION_REMOTE_ALLOW_LOOPBACK',previousEnv.loop]])if(value===undefined)delete process.env[key];else process.env[key]=value;await rm(root,{recursive:true,force:true});
  }
});
