import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {app,safeStorage,dialog} from 'electron';
import {StationService} from '../dist-electron/collaboration/station-service.js';
import {updateRemoteControlFields,flushSettingsWrites} from '../dist-electron/store.js';
import {parseSharedCommand} from '../dist-electron/collaboration/production-validation.js';
import {DurableState} from '../dist-electron/collaboration/durable-state.js';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {validateSharedWire} from '../dist-electron/collaboration/production-validation.js';
import {normalizeHostPlan} from '../dist-electron/collaboration/coordinator.js';
import {nativeHelper} from '../dist-electron/collaboration/native-helper.js';
import {randomUUID} from 'node:crypto';

test('Host preserves inline source text without treating it as an unverified Git file or accepting privilege escalation',()=>{
  const task={meetingId:'meeting',title:'whole delivery',objective:'Complete a whole document',targetDeviceId:'device',agentId:'file-test',resource:'text',permission:'read-only',dependencies:[],inputs:['Keep all validation requirements']};
  const [normalized]=normalizeHostPlan('meeting',[task]);assert.deepEqual(normalized.inputs,[]);assert.match(normalized.objective,/Keep all validation requirements/);
  assert.throws(()=>normalizeHostPlan('meeting',[{...task,permission:'full-access'}]));assert.throws(()=>normalizeHostPlan('other',[task]));
});

test('v2 shared command fixtures have identical TypeScript and Python acceptance and reject incompatible output', {skip:!process.env.COLLABORATION_PYTHON},()=>{
  const cases=JSON.parse(readFileSync(new URL('../contracts/collaboration/v2-validation-cases.json',import.meta.url),'utf8'));
  const results=cases.map(c=>{try{parseSharedCommand(c.value);return true;}catch{return false;}});
  assert.deepEqual(results,cases.map(c=>c.valid));
  const python=JSON.parse(execFileSync(process.env.COLLABORATION_PYTHON,['services/remote/collaboration_contracts/check_v2.py'],{input:JSON.stringify(cases),encoding:'utf8',timeout:15000}));
  assert.deepEqual(results,python);
  assert.throws(()=>validateSharedWire('event',{protocol:999,seq:1,kind:'task',id:'x',revision:1,value:{}}));
  assert.throws(()=>validateSharedWire('snapshot',{protocol:2,cursor:0,entities:{}}));
});

const until=async(check,why)=>{for(let n=0;n<600;n++){if(await check())return;await new Promise(r=>setTimeout(r,30));}assert.fail(why);};
test('production command schema rejects remote cwd, unknown protocol and privilege smuggling',()=>{
  for(const value of [
    {protocol:999,requestId:'id',action:'meeting.create',payload:{}},
    {protocol:2,requestId:'id',action:'message.send',payload:{meetingId:'m',text:'hello',cwd:'C:/private'}},
    {protocol:2,requestId:'id',action:'device.update',payload:{ownerId:'other'}},
  ])assert.throws(()=>parseSharedCommand(value));
});
test('durable state serializes writes and rejects corrupt restart records',async()=>{
  const root=await mkdtemp(join(tmpdir(),'station-durable-'));
  try{
    const state=new DurableState(join(root,'state.json'),{n:0});await state.load();
    await Promise.all(Array.from({length:20},()=>state.update(s=>{s.n++;})));
    const restart=new DurableState(join(root,'state.json'),{n:0});await restart.load();assert.equal(restart.read().n,20);
    if(process.platform==='win32'&&process.env.COLLABORATION_PYTHON){
      const code="import ctypes,sys;k=ctypes.WinDLL('kernel32',use_last_error=True);k.CreateFileW.restype=ctypes.c_void_p;k.CreateFileW.argtypes=[ctypes.c_wchar_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p];h=k.CreateFileW(sys.argv[1],0x80000000,1,None,3,0,None);assert h and h!=ctypes.c_void_p(-1).value;print('held',flush=True);sys.stdin.readline();k.CloseHandle(ctypes.c_void_p(h))";
      const reader=spawn(process.env.COLLABORATION_PYTHON,['-c',code,join(root,'state.json')],{stdio:['pipe','pipe','inherit'],windowsHide:true});
      try{
        await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('File lock fixture startup')),5000);reader.stdout.once('data',()=>{clearTimeout(timer);resolve();});reader.once('error',reject);});
        let acknowledged=false;const save=restart.update(s=>{s.n++;}).then(()=>{acknowledged=true;});
        await new Promise(r=>setTimeout(r,180));assert.equal(acknowledged,false);assert.equal(restart.read().n,20);assert.equal(JSON.parse(await readFile(join(root,'state.json'),'utf8')).n,20);
        reader.stdin.end('\n');await save;assert.equal(restart.read().n,21);
      }finally{reader.stdin.end();if(reader.exitCode===null)await new Promise(r=>reader.once('exit',r));}
    }
    await writeFile(join(root,'state.json'),'invalid original receipt');await assert.rejects(restart.load());assert.equal(await readFile(join(root,'state.json'),'utf8'),'invalid original receipt');
  }finally{await rm(root,{recursive:true,force:true});}
});
test('corrupt Station restart blocks registration and writes, preserving original reconciliation bytes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'station-corrupt-'));const path=join(root,'station-v2.json');await writeFile(path,'original unknown task data');
  try{const service=new StationService(root);await assert.rejects(service.initialize());await service.error(new Error('corrupt restart'));assert.match(service.view().error,/corrupt restart/);await assert.rejects(service.action('connect'));assert.equal(await service.shutdown(),false);assert.equal(await readFile(path,'utf8'),'original unknown task data');}
  finally{await rm(root,{recursive:true,force:true});}
});

test('frozen worker keeps the local journal namespace across filtered launch, exact stop and inspection', {timeout:25000,skip:process.platform!=='win32'},async()=>{
  const root=await mkdtemp(join(tmpdir(),'station-worker-namespace-'));const previous=process.env.POCKET_VIBE_STATE_DIR;const appPath=app.getAppPath;const executionId=randomUUID();
  process.env.POCKET_VIBE_STATE_DIR=root;app.getAppPath=()=>process.cwd();let running;
  try{
    running=nativeHelper({operation:'worker-check',executionId,command:[process.execPath,'-e','setTimeout(()=>{},5000)'],cwd:root,objective:'owned fixture',permission:'read-only'},undefined,{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,USERPROFILE:process.env.USERPROFILE});
    await until(async()=>{try{const state=JSON.parse(await readFile(join(root,'remote/tasks/codex',executionId,'containment.json'),'utf8'));return state.phase==='running';}catch{return false;}},'Filtered launch must persist in the same locally selected namespace');
    const stopped=await nativeHelper({operation:'worker-stop',executionId});assert.equal(stopped.cleanup_confirmed,true);assert.equal(stopped.cancelled,true);
    assert.equal((await running).cleanup_confirmed,true);const observed=await nativeHelper({operation:'worker-inspect',executionId});assert.equal(observed.result.cleanup_confirmed,true);assert.equal(observed.result.cancelled,true);
  }finally{await running?.catch(()=>{});if(previous===undefined)delete process.env.POCKET_VIBE_STATE_DIR;else process.env.POCKET_VIBE_STATE_DIR=previous;app.getAppPath=appPath;await rm(root,{recursive:true,force:true});}
});
test('two production Station receivers share real Hub state, persist receipt, execute once, stop and explicitly continue',
 {timeout:90000,skip:!process.env.POCKET_VIBE_TEST_PYTHON},async()=>{
  const root=await mkdtemp(join(tmpdir(),'station-two-devices-'));const originalPath=app.getPath;
  app.getPath=()=>root;safeStorage.isEncryptionAvailable=()=>true;
  safeStorage.encryptString=value=>Buffer.from('fixture-cipher:'+value);safeStorage.decryptString=value=>value.toString().replace('fixture-cipher:','');
  process.env.AHASTATION_ENABLE_TEST_AGENT='1';process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK='1';
  const child=spawn(process.env.POCKET_VIBE_TEST_PYTHON,['services/remote/tests/station_collaboration_fixture.py'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  let stderr='';child.stderr.on('data',v=>{stderr=(stderr+v).slice(-8000);});const lines=createInterface({input:child.stdout});
  let a,b;
  try{
    const fixture=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Hub startup timed out: '+stderr)),20000);
      lines.on('line',line=>{try{const value=JSON.parse(line);if(value.ready){clearTimeout(timeout);resolve(value);}}catch{}});
      child.on('exit',code=>{clearTimeout(timeout);reject(new Error('Hub exited '+code+': '+stderr));});
    });
    await updateRemoteControlFields(()=>({enabled:true,mode:'public',serviceUrl:fixture.url,ownerId:fixture.owner,controlToken:fixture.token}));
    a=new StationService(join(root,'A'));b=new StationService(join(root,'B'));await a.initialize();await b.initialize();
    await until(()=>a.view().connected&&b.view().connected,'Both authenticated Station WSS connections must become ready');
    for(const [service,name] of [[a,'A'],[b,'B']])await service.action('configure',{config:{...service.view().config,name,acceptingTasks:true,maxConcurrency:1},allowedAgents:['file-test']});
    const command=async(service,action,payload)=>{
      if(action==='task.create') {
        const plan=await service.action('command',{action:'plan.propose',payload:{meetingId:payload.meetingId,tasks:[payload]}});
        await service.action('command',{action:'plan.decide',payload:{meetingId:payload.meetingId,approved:true,expectedRevision:plan.revision}});
      }
      return service.action('command',{action,payload});
    };
    const project=await a.action('project.create',{name:'Ordinary research directory',resourceKind:'directory'});
    await until(()=>b.view().snapshot.entities.project?.some(p=>p.id===project.id),'Project push must reach the other device');
    const projectRoot=join(root,'ordinary');const workspace=join(root,'task-workspaces');await mkdir(projectRoot);await mkdir(workspace);
    let picks=[projectRoot,workspace];dialog.showOpenDialog=async()=>({canceled:false,filePaths:[picks.shift()]});dialog.showMessageBox=async()=>({response:0});
    await b.action('directory.grant',{projectId:project.id,permission:'workspace-write'});
    const meeting=await command(a,'meeting.create',{title:'Whole delivery',members:[b.view().deviceId],autoApprovePlan:false,autoAssign:false});
    await command(a,'plan.decide',{meetingId:meeting.id,approved:true,expectedRevision:meeting.revision});
    const task=await command(a,'task.create',{meetingId:meeting.id,title:'two files',objective:'write both files and validate',targetDeviceId:b.view().deviceId,agentId:'file-test',resource:'directory',projectId:project.id,permission:'workspace-write',dependencies:[],inputs:[]});
    await until(()=>a.view().snapshot.entities.task?.find(t=>t.id===task.id)?.status==='delivered','Received task must finish real two-file execution');
    const disk=JSON.parse(await readFile(join(root,'B','station-v2.json'),'utf8'));const receipt=disk.receipts[task.id];
    assert.equal(receipt.status,'delivered');assert.equal(await readFile(join(receipt.cwd,'delivery.txt'),'utf8'),'write both files and validate\n');
    assert.ok(!JSON.stringify(a.view()).includes(fixture.token));assert.ok(disk.tokenEnc&&!disk.controlToken);
    const waiting=await command(a,'task.create',{meetingId:meeting.id,title:'wait',objective:'[wait]',targetDeviceId:b.view().deviceId,agentId:'file-test',resource:'text',permission:'read-only',dependencies:[],inputs:[]});
    await until(()=>b.view().snapshot.entities.task?.find(t=>t.id===waiting.id)?.status==='running','Waiting adapter should occupy the one device slot');
    const originalGeneration=b.view().snapshot.entities.device.find(d=>d.id===b.view().deviceId).connectionGeneration;
    const beforeRestart=JSON.parse(await readFile(join(root,'B','station-v2.json'),'utf8')).receipts[waiting.id];
    child.stdin.write('restart\n');
    await until(()=>a.view().connected&&b.view().connected&&b.view().snapshot.entities.device.find(d=>d.id===b.view().deviceId)?.connectionGeneration>originalGeneration,'Real Hub process restart must restore both WSS connections');
    const afterRestart=JSON.parse(await readFile(join(root,'B','station-v2.json'),'utf8')).receipts[waiting.id];
    assert.equal(afterRestart.nativeThreadId,beforeRestart.nativeThreadId);assert.equal(afterRestart.attemptId,beforeRestart.attemptId);
    await command(a,'task.control',{taskId:waiting.id,attemptId:waiting.attemptId,operation:'stop'});
    await until(()=>a.view().snapshot.entities.task?.find(t=>t.id===waiting.id)?.status==='stopped','Stop requires actual fixture exit before releasing capacity');
    const continued=await command(a,'task.control',{taskId:waiting.id,attemptId:waiting.attemptId,operation:'continue',text:'complete original task'});
    assert.notEqual(continued.attemptId,waiting.attemptId);
    await until(()=>a.view().snapshot.entities.task?.find(t=>t.id===waiting.id)?.status==='delivered','Explicit continue reuses business task with new attempt');
    assert.equal(a.view().snapshot.entities.task.filter(t=>t.id===waiting.id).length,1);
    const stableDevice=b.view().deviceId;const expired=new Promise(resolve=>lines.on('line',line=>{try{if(JSON.parse(line).expired===stableDevice)resolve();}catch{}}));child.stdin.write('expire-device '+stableDevice+'\n');await expired;
    await assert.rejects(b.action('command',{action:'meeting.create',payload:{title:'Must fail while credential expired',members:[],autoApprovePlan:false,autoAssign:false}}));
    await until(async()=>JSON.parse(await readFile(join(root,'B/station-v2.json'),'utf8')).credentialInvalid===true,'Expired credential must block new work and retain reconciliation records');
    const originalEncryptedToken=b.storage.read().tokenEnc;
    await assert.rejects(b.action('connect'),/expired|revoked|失效/);
    assert.equal(b.storage.read().credentialInvalid,true);assert.equal(b.storage.read().tokenEnc,originalEncryptedToken);assert.equal(b.view().deviceId,stableDevice);
    // A genuinely expired token cannot use the legacy-misclassification
    // recovery path. The explicit local reauthorization dialog is separate.
    await b.action('device.reactivate');await until(()=>b.view().connected,'Explicit local account authorization must restore the same device');assert.equal(b.view().deviceId,stableDevice);
    assert.equal(b.view().snapshot.entities.task.find(t=>t.id===waiting.id).attemptId,continued.attemptId);
  }catch(error){
    console.error('Station fixture diagnostics',JSON.stringify({a:a?.view(),b:b?.view()}));throw error;
  }finally{
    await a?.shutdown();await b?.shutdown();await flushSettingsWrites();app.getPath=originalPath;
    child.stdin.end('\n');await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);});
    await rm(root,{recursive:true,force:true});
  }
});
