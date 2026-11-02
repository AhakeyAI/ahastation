import {DurableState} from '../dist-electron/collaboration/durable-state.js';
import {spawn} from 'node:child_process';
import {textSlice} from '../dist-electron/collaboration/text-slice.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID,randomBytes,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import {app,safeStorage} from 'electron';
import {StationService} from '../dist-electron/collaboration/station-service.js';
import {CollaborationHttpError} from '../dist-electron/collaboration/connection.js';
import {UnifiedMeetingHost} from '../dist-electron/collaboration/unified-host.js';
import {encryptDeviceCredential,decryptDeviceCredential,LocalCredentialError} from '../dist-electron/collaboration/device-credential.js';
import {preserveText,readFullText,uploadText,downloadText} from '../dist-electron/collaboration/text-artifacts.js';
import {deliveryIdentity} from '../dist-electron/collaboration/delivery-identity.js';

test('F08 rejected 409/426 proposals reject through Host and never emit successful review',async()=>{
 const root=await mkdtemp(join(tmpdir(),'station-ui-plan-'));try{
  for(const [status,code] of [[409,'PLAN_VERSION_CONFLICT'],[409,'DISPATCHED_TASK_OMITTED'],[409,'CONNECTION_GENERATION_CHANGED'],[426,'PROTOCOL_INCOMPATIBLE']]){
   const service=new StationService(join(root,code));await service.storage.update(s=>{s.hostPlanBases={input:{version:4,decisionVersion:2}};});const replies=[];
   service.send=async action=>{if(action==='plan.propose')throw new CollaborationHttpError('specific '+code,status,code);return {id:'notice'};};
   const host=new UnifiedMeetingHost({id:'m'},()=>({entities:{}}),root,{plan:(tasks,id)=>service.proposeHostPlan({id:'m'},tasks,id),reply:async text=>replies.push(text),checkpoint:async()=>{},session:async()=>{},consult:async()=>{},control:async()=>{}});
   host.start=async()=>{};host.dispatchCommands=()=>service.proposeHostPlan({id:'m'},[],'input');await assert.rejects(host.finish('input',''),e=>e.code===code);assert.equal(replies.includes('计划已提交审阅。'),false);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
test('F08 multiple distinct full plans are rejected before any original command applies; duplicates coalesce',async()=>{
 const h=new UnifiedMeetingHost({id:'m'},()=>({entities:{}}),'unused',{});let writes=0;h.orch={executeMeetingCommand:async()=>{writes++;return {ok:true};}};
 const command=value=>'```meeting-command\n'+JSON.stringify({kind:'propose-plan',tasks:[{id:value}]})+'\n```';
 await assert.rejects(h.dispatchCommands(command('a')+'\n'+command('b')),/多份/);assert.equal(writes,0);await h.dispatchCommands(command('a')+'\n'+command('a'));assert.equal(writes,1);writes=0;await h.dispatchCommands(command('a')+'\n```meeting-command\n'+JSON.stringify({tasks:[{id:'a'}],kind:'propose-plan'},null,2)+'\n```');assert.equal(writes,1);
});
test('F03 scoped errors resolve only their own operation/attempt, retain history and ignore late terminal regression',async()=>{
 const root=await mkdtemp(join(tmpdir(),'station-ui-error-'));try{const s=new StationService(root);await s.storage.load();s.localReady=true;const a={id:'t1',meetingId:'m1',attemptId:'a1'},b={id:'t2',meetingId:'m2',attemptId:'a2'};
 await s.error(new Error('first'),a);await s.error(new Error('second'),b);assert.equal(s.view().error,undefined);assert.equal(s.view().businessErrors.filter(e=>e.meetingId==='m1'&&e.active).length,1);
 await s.clearBusinessError(a);assert.equal(s.view().businessErrors.find(e=>e.entityId==='t2').active,true);assert.deepEqual(s.view().businessErrors.find(e=>e.entityId==='t1').history,['first']);
 await s.storage.update(state=>{state.receipts.t1={taskId:'t1',attemptId:'a1',status:'delivered',bindingRevision:0,output:[],exitConfirmed:true};});await s.error(new Error('late failure'),a);assert.equal(s.view().businessErrors.find(e=>e.entityId==='t1').active,false);assert.deepEqual(s.view().businessErrors.find(e=>e.entityId==='t1').history,['first','late failure']);
 await s.error(new Error('device disconnected'));assert.equal(s.view().error,'device disconnected');assert.equal(s.view().errorScope,'device');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('F04 events replace devices in place instead of reordering by heartbeat arrival',async()=>{
 const root=await mkdtemp(join(tmpdir(),'station-ui-order-'));try{const s=new StationService(root);s.pump=async()=>{};await s.storage.update(v=>{v.snapshot.entities.device=[{id:'a',revision:1,name:'same'},{id:'b',revision:1,name:'same'}];});await s.event({seq:1,kind:'device',id:'a',revision:2,value:{id:'a',revision:2,name:'renamed'}});assert.deepEqual(s.view().snapshot.entities.device.map(d=>d.id),['a','b']);}finally{await rm(root,{recursive:true,force:true});}
});
test('F09 device envelopes bind purpose/account/device/profile and diagnose wrong keys without secret values',async()=>{
 const root=await mkdtemp(join(tmpdir(),'station-ui-crypto-'));const old={path:app.getPath,ready:app.isReady,available:safeStorage.isAsyncEncryptionAvailable,encrypt:safeStorage.encryptStringAsync,decrypt:safeStorage.decryptStringAsync};let key=randomBytes(32);const token='owned-secret-'+randomUUID();
 try{app.getPath=()=>root;app.isReady=()=>true;safeStorage.isAsyncEncryptionAvailable=()=>true;safeStorage.encryptStringAsync=text=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),bytes=Buffer.concat([c.update(text,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]);};safeStorage.decryptStringAsync=bytes=>{const c=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));c.setAuthTag(bytes.subarray(12,28));return {result:Buffer.concat([c.update(bytes.subarray(28)),c.final()]).toString('utf8'),shouldReEncrypt:false};};
 await writeFile(join(root,'Local State'),JSON.stringify({os_crypt:{encrypted_key:'owned-key-one'}}));const binding={ownerId:randomUUID(),serviceUrl:'https://fixture.invalid',deviceId:randomUUID()},sealed=await encryptDeviceCredential(token,binding);
 assert.equal(await decryptDeviceCredential(sealed.cipher,binding,sealed.metadata),token);assert.equal(sealed.metadata.purpose,'station-device');for(const altered of [{...sealed.metadata,purpose:'other'},{...sealed.metadata,version:999},{...sealed.metadata,profileId:'foreign-profile'}])await assert.rejects(()=>decryptDeviceCredential(sealed.cipher,binding,altered),e=>e instanceof LocalCredentialError&&e.kind==='credential-profile-or-identity-mismatch');assert.equal(JSON.stringify(sealed.metadata).includes(token),false);
 await assert.rejects(()=>decryptDeviceCredential(sealed.cipher,{...binding,ownerId:randomUUID()},sealed.metadata),e=>e instanceof LocalCredentialError&&e.kind==='credential-profile-or-identity-mismatch');
 key=randomBytes(32);await writeFile(join(root,'Local State'),JSON.stringify({os_crypt:{encrypted_key:'owned-key-two'}}));await assert.rejects(()=>decryptDeviceCredential(sealed.cipher,binding,sealed.metadata),e=>{assert.equal(e.kind,'local-decryption-failed');assert.equal(e.diagnostic.keyChanged,true);assert.equal(JSON.stringify(e.diagnostic).includes(token),false);assert.equal(JSON.stringify(e.diagnostic).includes(sealed.cipher),false);return true;});
 app.isReady=()=>false;await assert.rejects(()=>encryptDeviceCredential(token,binding),/secure-storage-unavailable/);
 }finally{app.getPath=old.path;app.isReady=old.ready;safeStorage.isAsyncEncryptionAvailable=old.available;safeStorage.encryptStringAsync=old.encrypt;safeStorage.decryptStringAsync=old.decrypt;await rm(root,{recursive:true,force:true});}
});
test('F10 durable UTF8 plus interrupted upload retries only missing bytes and download restores only missing pieces',async()=>{
 const root=await mkdtemp(join(tmpdir(),'station-ui-text-'));try{
 const text='\ufeff'+('完整中文🧭e\u0301\n'.repeat(15000))+'FULL-END',taskId=randomUUID(),attemptId=randomUUID(),local=await preserveText(root,taskId,attemptId,text,true);assert.equal((await readFullText(local.reference)).toString('utf8'),text);
 const saved=new Map(),puts=new Map(),gets=new Map();let losePut=true,loseGet=true;const connection={request:async(route,body,method)=>{
  if(route.endsWith('/text-artifacts'))return {manifest:local.manifest,missing:Array.from({length:local.manifest.chunkCount},(_,i)=>i).filter(i=>!saved.has(i))};
  if(route.endsWith('/complete'))return {...local.manifest,status:'complete'};
  const m=/chunks\/(\d+)$/.exec(route);if(m){const i=Number(m[1]);if(method==='PUT'){saved.set(i,body);puts.set(i,(puts.get(i)??0)+1);if(i===0&&losePut){losePut=false;throw new Error('reply lost after persisted chunk');}return {ok:true};}gets.set(i,(gets.get(i)??0)+1);if(i===1&&loseGet){loseGet=false;throw new Error('download disconnected');}return {index:i,...saved.get(i)};}
  return {manifest:{...local.manifest,status:'complete'}};
 }};
 await assert.rejects(uploadText(connection,local.manifest,local.reference,()=>true),/reply lost/);assert.equal((await readFullText(local.reference)).toString('utf8'),text);const complete=await uploadText(connection,local.manifest,local.reference,()=>true);assert.equal(puts.get(0),1);
 const cache=join(root,'download');await assert.rejects(downloadText(connection,complete,()=>true,cache),/disconnected/);const got=await downloadText(connection,complete,()=>true,cache);assert.equal(got.text,text);assert.equal(gets.get(0),1);assert.equal(createHash('sha256').update(got.data).digest('hex'),complete.sha256);
 await writeFile(local.reference.path,'corrupt');await assert.rejects(readFullText(local.reference),/SHA/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('F06 delivery identity changes with attempt, content, actual test or manifest hash, not unrelated progress',()=>{
 const base={id:'task',meetingId:'meeting',attemptId:'one',revision:1,delivery:{summary:'preview',textArtifact:{sha256:'a'},report:{tests:[{exitCode:0}]}}};assert.equal(deliveryIdentity(base),deliveryIdentity({...base,revision:9,output:['new progress']}));assert.notEqual(deliveryIdentity(base),deliveryIdentity({...base,attemptId:'two'}));assert.notEqual(deliveryIdentity(base),deliveryIdentity({...base,delivery:{...base.delivery,textArtifact:{sha256:'b'}}}));
});

test('F10 recovered legacy previews never replay a Host plan; verified durable full bytes do',async()=>{
 const root=await mkdtemp(join(tmpdir(),'station-ui-legacy-'));try{const s=new StationService(root);s.localReady=true;const meeting={id:'m',revision:1,hostAgentId:'codex',coordinatorDeviceId:'local'},message={id:'input',revision:1,meetingId:'m',route:'host'};await s.storage.update(v=>{v.deviceId='local';v.snapshot.entities.meeting=[meeting];v.snapshot.entities.message=[message];v.hostMessages={input:'starting'};});let applied='';s.coordinator=()=>({finish:async(id,body)=>{applied=body;}});s.inspectHost=async()=>({result:{ok:true,cleanup_confirmed:true,json:{last_message:'old cropped station-plan'}}});await s.recoverInput('input','starting');assert.equal(applied,'');assert.equal(s.storage.read().hostMessages.input,'starting');assert.match(s.storage.read().reconciliation['input:input'].reason,/历史预览/);const local=await preserveText(root,randomUUID(),randomUUID(),'verified complete plan body',true);s.inspectHost=async()=>({summary:'bounded preview must not win',result:{ok:true,cleanup_confirmed:true,fullText:local.reference,contentComplete:true,json:{last_message:'preview'}}});await s.recoverInput('input','starting');assert.equal(applied,'verified complete plan body');}finally{await rm(root,{recursive:true,force:true});}
});
test('F08 empty Host recovery completes without an extra message',async()=>{let replies=0;const h=new UnifiedMeetingHost({id:'m'},()=>({entities:{}}),'unused',{reply:async()=>{replies++;},checkpoint:async()=>{}});h.start=async()=>{};await h.finish('empty','');assert.equal(replies,0);});

test('F10 bounded previews and adjacent pages preserve Unicode scalars and exact concatenated UTF8',()=>{const text='x'+'🧭e\u0301中文'.repeat(10000)+'END';for(let n=1;n<100;n++){const preview=textSlice(text,0,n);assert.equal(Buffer.from(preview).toString('utf8'),preview);}let all='';for(let n=0;n<text.length;n+=12000){const page=textSlice(text,n,n+12000);assert.equal(Buffer.from(page).toString('utf8'),page);all+=page;}assert.deepEqual(Buffer.from(all),Buffer.from(text));});

test('F09 failed authentication leaves local recovery timers running and cannot pump new work',async()=>{const root=await mkdtemp(join(tmpdir(),'station-ui-auth-timers-'));const s=new StationService(root);let recovered=0,pumped=0;try{s.probe=async()=>{};s.connect=async()=>{throw new Error('owned decryption failure');};s.recoverReceipts=async()=>{recovered++;};s.pump=async()=>{pumped++;};await assert.rejects(s.initialize(),/owned decryption/);assert.ok(s.recoveryTimer&&s.nativeTimer);await new Promise(r=>setTimeout(r,2200));assert.ok(recovered>0);assert.equal(pumped,0);assert.equal(s.view().connected,false);}finally{clearInterval(s.recoveryTimer);clearInterval(s.nativeTimer);await rm(root,{recursive:true,force:true});}});

test('F09 Windows denied atomic replacement preserves the exact credential record until explicit successful retry',{skip:process.platform!=='win32'||!process.env.COLLABORATION_PYTHON},async()=>{const root=await mkdtemp(join(tmpdir(),'station-ui-atomic-')),file=join(root,'credential.json'),original={cipher:'owned-encrypted-record',metadata:{version:1,purpose:'station-device'},history:['retained']};let child;try{const state=new DurableState(file,original);await state.update(()=>{});const originalBytes=await readFile(file);const code="import ctypes,sys;k=ctypes.WinDLL('kernel32',use_last_error=True);k.CreateFileW.restype=ctypes.c_void_p;k.CreateFileW.argtypes=[ctypes.c_wchar_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p];h=k.CreateFileW(sys.argv[1],0x80000000,1,None,3,0,None);assert h and h!=ctypes.c_void_p(-1).value;print('held',flush=True);sys.stdin.readline();k.CloseHandle(ctypes.c_void_p(h))";child=spawn(process.env.COLLABORATION_PYTHON,['-c',code,file],{stdio:['pipe','pipe','ignore'],windowsHide:true});await new Promise((yes,no)=>{const t=setTimeout(()=>no(new Error('owned lock startup')),5000);child.stdout.once('data',()=>{clearTimeout(t);yes();});child.once('error',no);});await assert.rejects(state.update(v=>{v.cipher='new-owned-record';}),e=>['EACCES','EPERM','EBUSY'].includes(e.code));assert.deepEqual(await readFile(file),originalBytes);assert.deepEqual(state.read(),original);const reopened=new DurableState(file,{});await reopened.load();assert.deepEqual(reopened.read(),original);child.stdin.end('release\n');await new Promise(r=>child.once('exit',r));await state.update(v=>{v.cipher='new-owned-record';});assert.equal(JSON.parse(await readFile(file,'utf8')).cipher,'new-owned-record');}finally{if(child&&child.exitCode===null){child.stdin.end();await new Promise(r=>child.once('exit',r));}await rm(root,{recursive:true,force:true});}});
