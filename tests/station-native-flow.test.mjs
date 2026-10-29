import {macosTaskTestsEnabled} from './platform-support.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {app,safeStorage,dialog} from 'electron';import {StationService} from '../dist-electron/collaboration/station-service.js';import {updateRemoteControlFields} from '../dist-electron/store.js';
const until=async(fn,message)=>{for(let n=0;n<800;n++){if(await fn())return;await new Promise(r=>setTimeout(r,40));}assert.fail(message);};
test('production Station and frozen helper queue native continuation, stop only its waiter, preserve thread and support both stop directions', {timeout:120000,skip:!process.env.POCKET_VIBE_TEST_PYTHON||!macosTaskTestsEnabled},async()=>{
  const root=await mkdtemp(join(tmpdir(),'station-native-flow-'));app.getPath=()=>root;app.getAppPath=()=>process.cwd();safeStorage.isAsyncEncryptionAvailable=()=>true;safeStorage.encryptStringAsync=s=>Buffer.from('fixture:'+s);safeStorage.decryptStringAsync=async b=>({result:b.toString().slice(8),shouldReEncrypt:false});
  process.env.AHASTATION_ENABLE_TEST_AGENT='1';process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK='1';
  const child=spawn(process.env.POCKET_VIBE_TEST_PYTHON,['services/remote/tests/station_native_fixture.py'],{stdio:['pipe','pipe','pipe'],windowsHide:true});let errors='';child.stderr.on('data',v=>{errors=(errors+v).slice(-4000);});const lines=createInterface({input:child.stdout});let a,b;
  const command=(service,action,payload)=>service.action('command',{action,payload});
  try{
    const fixture=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Native fixture startup '+errors)),20000);lines.on('line',line=>{try{const r=JSON.parse(line);if(r.ready){clearTimeout(timer);resolve(r);}}catch{}});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Native fixture exited '+code+' '+errors));});});
    process.env.POCKET_VIBE_STATE_DIR=fixture.nativeState;
    await updateRemoteControlFields(()=>({enabled:true,mode:'public',serviceUrl:fixture.url,ownerId:fixture.owner,controlToken:fixture.token}));
    a=new StationService(join(root,'A'));b=new StationService(join(root,'B'));await a.initialize();await b.initialize();await until(()=>a.view().connected&&b.view().connected,'Both receivers connect');
    for(const [service,name] of [[a,'A'],[b,'B']])await service.action('configure',{config:{...service.view().config,name,acceptingTasks:true,maxConcurrency:1},allowedAgents:['codex','file-test']});
    const project=await a.action('project.create',{name:'Native original directory',resourceKind:'directory'});await until(()=>b.view().snapshot.entities.project?.some(p=>p.id===project.id),'Shared project push');
    const workspace=join(root,'native-inputs');await mkdir(workspace);let picks=[fixture.projectRoot,workspace];dialog.showOpenDialog=async()=>({canceled:false,filePaths:[picks.shift()]});dialog.showMessageBox=async()=>({response:0});
    await b.action('directory.grant',{projectId:project.id,permission:'read-only'});await b.action('native.refresh');
    await until(()=>a.view().snapshot.entities.native?.some(n=>n.sessionId===fixture.sessionId&&n.deviceId===b.view().deviceId),'Frozen helper must publish authorized original native identity');
    const meeting=await command(a,'meeting.create',{title:'Native serial flow',members:[b.view().deviceId],autoApprovePlan:false,autoAssign:false});await command(a,'native.bind',{meetingId:meeting.id,deviceId:b.view().deviceId,sessionId:fixture.sessionId,operation:'bind'});
    const send=text=>command(a,'message.send',{meetingId:meeting.id,text,nativeSessionId:fixture.sessionId,targetDeviceId:b.view().deviceId});
    const first=await send('Wait behind original Desktop turn');await until(()=>a.view().snapshot.entities.message?.find(m=>m.id===first.id)?.executionStatus==='waiting-desktop','Native waiter is durable');
    const payload={meetingId:meeting.id,title:'Other independent delivery',objective:'whole fixture',targetDeviceId:b.view().deviceId,agentId:'file-test',resource:'text',permission:'read-only',dependencies:[],inputs:[]};
    const plan=await command(a,'plan.propose',{meetingId:meeting.id,tasks:[payload]});await command(a,'plan.decide',{meetingId:meeting.id,expectedRevision:plan.revision,approved:true});const other=await command(a,'task.create',payload);
    await until(()=>a.view().snapshot.entities.task?.find(t=>t.id===other.id)?.status==='delivered','Waiting Desktop must not consume the one Station slot');
    await command(a,'message.stop',{messageId:first.id});await until(()=>a.view().snapshot.entities.message.find(m=>m.id===first.id)?.executionStatus==='stopped','Stop only the Station waiter');
    const state=()=>new Promise(resolve=>{const onLine=line=>{try{const r=JSON.parse(line);if(r.status){lines.off('line',onLine);resolve(r);}}catch{}};lines.on('line',onLine);child.stdin.write('status\n');});
    const held=await state();assert.equal(held.starts,1);assert.equal(held.interrupts,0);assert.equal(held.active,true);
    const second=await send('Continue same original native identity');child.stdin.write('finish-desktop\n');await until(()=>a.view().snapshot.entities.message.find(m=>m.id===second.id)?.executionStatus==='running','Station starts after original Desktop exit');
    const running=a.view().snapshot.entities.message.find(m=>m.id===second.id);assert.ok(running.nativeTurnId);
    await command(a,'native.stop',{meetingId:meeting.id,deviceId:b.view().deviceId,sessionId:fixture.sessionId,turnId:running.nativeTurnId});await until(()=>a.view().snapshot.entities.message.find(m=>m.id===second.id)?.executionStatus==='stopped','Station exact native stop waits for exit');
    const third=await send('Desktop may stop this Station round');await until(()=>a.view().snapshot.entities.message.find(m=>m.id===third.id)?.executionStatus==='running','New explicit free exchange starts once');child.stdin.write('interrupt-current\n');await until(()=>a.view().snapshot.entities.message.find(m=>m.id===third.id)?.executionStatus==='stopped','Desktop stop is observed by Station');
    const final=await state();assert.equal(final.starts,3);assert.equal(final.active,false);assert.equal(a.view().snapshot.entities.task.filter(t=>t.resource==='native').length,0);
    await b.action('native.refresh');await b.action('native.refresh');await until(()=>a.view().snapshot.entities.history?.some(h=>h.source==='desktop')&&a.view().snapshot.entities.history?.some(h=>h.source==='station'),'Selected native history retains Desktop and Station source labels');
  } catch(error) {
    const evidence=process.env.STATION_EVIDENCE_DIR??await mkdtemp(join(tmpdir(),'station-native-diagnostics-'));
    await mkdir(evidence,{recursive:true});
    await writeFile(join(evidence,'native-flow-diagnostics.json'),JSON.stringify({
      error:error.stack,a:a?.view(),b:b?.view(),stderr:errors,
    },null,2));
    console.error('Native fixture diagnostics: '+evidence);
    throw error;
  }
  finally{await a?.shutdown();await b?.shutdown();for(const service of [a,b])if(service){clearInterval(service.nativeTimer);clearInterval(service.recoveryTimer);service.connection?.stop();}child.stdin.end('\n');if(child.exitCode===null)await new Promise(r=>child.once('exit',r));delete process.env.POCKET_VIBE_STATE_DIR;await rm(root,{recursive:true,force:true});}
});
