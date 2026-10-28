import test from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {app,safeStorage} from 'electron';import {StationService} from '../dist-electron/collaboration/station-service.js';import {updateRemoteControlFields} from '../dist-electron/store.js';
import {macosTaskTestsEnabled} from './platform-support.mjs';
const loader="data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));";
async function ready(child){return new Promise((resolve,reject)=>{let errors='';child.stderr?.on('data',v=>{errors=(errors+v).slice(-2000);});const timer=setTimeout(()=>reject(new Error('Fixture startup timed out '+errors)),20000);createInterface({input:child.stdout}).on('line',line=>{try{const r=JSON.parse(line);if(r.ready){clearTimeout(timer);resolve(r);}}catch{}});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Fixture exited '+code+' '+errors));});});}
async function exited(child){if(child.exitCode===null&&child.signalCode===null)await new Promise(r=>child.once('exit',r));}
async function until(fn,message){for(let n=0;n<600;n++){if(await fn())return;await new Promise(r=>setTimeout(r,40));}assert.fail(message);}
test('receiver process crash restores original device, proves in-process fixture exit and waits for explicit continue', {timeout:90000,skip:!process.env.POCKET_VIBE_TEST_PYTHON||!macosTaskTestsEnabled},async()=>{
  const root=await mkdtemp(join(tmpdir(),'station-process-'));app.getPath=()=>root;safeStorage.isEncryptionAvailable=()=>true;safeStorage.encryptString=s=>Buffer.from('fixture:'+s);safeStorage.decryptString=b=>b.toString().slice(8);
  process.env.AHASTATION_ENABLE_TEST_AGENT='1';process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK='1';
  const hub=spawn(process.env.POCKET_VIBE_TEST_PYTHON,['services/remote/tests/station_collaboration_fixture.py'],{stdio:['pipe','pipe','pipe'],windowsHide:true});let receiver,a;
  try{
    const info=await ready(hub);const connection=join(root,'private-fixture.json');await writeFile(connection,JSON.stringify(info));
    await updateRemoteControlFields(()=>({enabled:true,mode:'public',serviceUrl:info.url,ownerId:info.owner,controlToken:info.token}));
    a=new StationService(join(root,'A'));await a.initialize();await until(()=>a.view().connected,'A should connect');
    const launch=()=>spawn(process.execPath,['--import',loader,'tests/fixtures/station-receiver.mjs',join(root,'B'),connection],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    receiver=launch();const first=await ready(receiver);
    const command=(action,payload)=>a.action('command',{action,payload});const meeting=await command('meeting.create',{title:'Crash recovery',members:[first.deviceId],autoApprovePlan:false,autoAssign:false});
    const taskPayload={meetingId:meeting.id,title:'whole fixture',objective:'[wait]',targetDeviceId:first.deviceId,agentId:'file-test',resource:'text',permission:'read-only',dependencies:[],inputs:[]};
    const plan=await command('plan.propose',{meetingId:meeting.id,tasks:[taskPayload]});await command('plan.decide',{meetingId:meeting.id,expectedRevision:plan.revision,approved:true});const task=await command('task.create',taskPayload);
    await until(()=>a.view().snapshot.entities.task?.find(t=>t.id===task.id)?.status==='running','Original receiver should execute once');
    const before=JSON.parse(await readFile(join(root,'B/station-v2.json'),'utf8')).receipts[task.id];
    receiver.kill();await exited(receiver);receiver=launch();const second=await ready(receiver);assert.equal(second.deviceId,first.deviceId);
    await until(()=>a.view().snapshot.entities.task?.find(t=>t.id===task.id)?.status==='stopped','Restart must prove old fixture process exit, not rerun it');
    const stopped=JSON.parse(await readFile(join(root,'B/station-v2.json'),'utf8')).receipts[task.id];assert.equal(stopped.attemptId,before.attemptId);assert.equal(stopped.nativeThreadId,before.nativeThreadId);assert.equal(stopped.exitConfirmed,true);
    await command('task.control',{taskId:task.id,attemptId:task.attemptId,operation:'continue',text:'Complete original delivery after explicit human instruction'});
    await until(()=>a.view().snapshot.entities.task?.find(t=>t.id===task.id)?.status==='delivered','Only explicit continue starts a fresh attempt in the same task');
  }finally{if(receiver){receiver.stdin.end('\n');await exited(receiver);}await a?.shutdown();hub.stdin.end('\n');await exited(hub);await rm(root,{recursive:true,force:true});}
});
