import assert from 'node:assert/strict';
import test from 'node:test';
import { macosTaskTestsEnabled } from './platform-support.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { app, safeStorage } from 'electron';
import { remoteControlAction, remoteControlView, remotePendingKey, setRemotePending, getRemotePending } from '../dist-electron/remote-control.js';
import { getSettings, flushSettingsWrites } from '../dist-electron/store.js';
import { PocketVibeBackend, fetchPocketVibeRemoteSessions } from '../dist-electron/backends/pocket-vibe-adapter.js';

const root=await mkdtemp(join(tmpdir(),'station-public-control-')); app.getPath=()=>root;
safeStorage.isEncryptionAvailable=()=>true;
safeStorage.encryptString=(value)=>Buffer.from('test-encrypted:'+value);
safeStorage.decryptString=(buffer)=>buffer.toString().replace('test-encrypted:','');
test.after(async()=> { await flushSettingsWrites(); await rm(root,{recursive:true,force:true}); });
const reply=(data,status=200)=>({ok:status<400,status,json:async()=>data,text:async()=>JSON.stringify(data)});
const until=async(fn)=> { for(let i=0;i<1000;i++) { if(fn())return; await new Promise(resolve=>setTimeout(resolve,5)); } assert.fail('Timed out'); };
const target={device_id:'device-native',agent_id:'device-native-codex',provider:'codex',session_id:'native-exact',cwd:'C:\\authorized\\remote',title:'Remote Project',service_url:'https://fixture.example',owner_id:'owner-a'};

test('remote identity uses existing encrypted store and whitelisted IPC, atomic per-member pending refs, and separate legacy config',async()=> {
  const calls=[]; let shown;
  const fetchImpl=async(url,options)=> { calls.push({url,...options});
    if(url.includes('/v2/auth/'))return reply({owner_id:'owner-a',login:'alice',control_token:'secret-control-fixture',recovery_code:'secret-recovery-fixture'});
    if(url.endsWith('/v2/devices'))return reply({devices:[{id:'device',name:'PC',online:true,token:'must-not-cross-ipc'}]});
    return reply({owner_id:'owner-a',protocol:2}); };
  assert.equal((await remoteControlAction('configure',{enabled:true,mode:'public',serviceUrl:'http://example.test'})).ok,false);
  assert.equal((await remoteControlAction('configure',{enabled:true,mode:'public',serviceUrl:'https://fixture.example'})).ok,true);
  const result=await remoteControlAction('register',{login:'alice',password:'test-password-123'},{fetchImpl,showRecovery:async(login,code)=> {shown={login,code};}});
  assert.equal(result.ok,true); assert.equal(shown.code,'secret-recovery-fixture'); assert.equal(result.settings.loggedIn,true);
  assert.ok(!JSON.stringify(result).includes('secret-')); assert.ok(!JSON.stringify(remoteControlView()).includes('secret-'));
  const devices=await remoteControlAction('devices',{}, {fetchImpl}); assert.deepEqual(devices.devices,[{id:'device',name:'PC',online:true}]);
  assert.equal(calls.at(-1).headers.Authorization,'Bearer secret-control-fixture'); assert.ok(!calls.at(-1).url.includes('secret-'));
  const a=remotePendingKey(target),b=remotePendingKey({...target,session_id:'another'});
  await Promise.all([setRemotePending(a,'submit-a'),setRemotePending(b,'submit-b')]); assert.equal(getRemotePending(a),'submit-a'); assert.equal(getRemotePending(b),'submit-b');
  await Promise.all([setRemotePending(a,'new-submission'),setRemotePending(a,undefined,'submit-a')]);
  assert.equal(getRemotePending(a),'new-submission','Late cleanup compares the submission inside the settings write lock');
  await setRemotePending(a,'submit-a');
  await flushSettingsWrites(); const disk=await readFile(join(root,'settings.json'),'utf8'); assert.ok(!disk.includes('"controlToken":')); assert.ok(disk.includes('controlTokenEnc')); assert.ok(!disk.includes('secret-control-fixture'));
  await remoteControlAction('logout',{}, {fetchImpl}); assert.equal(remoteControlView().loggedIn,false); assert.equal(getRemotePending(a),'submit-a');
  await remoteControlAction('configure',{enabled:false,mode:'legacy',serviceUrl:''}); assert.equal(getSettings().remoteControl.mode,'legacy');
  const oversized=await fetchPocketVibeRemoteSessions({authMode:'apikey',apiKey:'test',publicMode:true,baseUrl:'https://fixture.example'},true,
    {fetchImpl:async()=>new Response('x'.repeat(600000))});
  assert.equal(oversized.ok,false); assert.match(oversized.error,/大小/);
});

function publicHub() {
  const posts=[],reads=[],pending=new Map(); let cancelled=false; let completed=true;
  const fetchImpl=async(url,init={})=> {
    if(url.endsWith('/health')) return reply({ok:true,protocol:2});
    assert.equal(init.headers.Authorization,'Bearer test-control'); assert.equal(init.headers['X-Pocket-Token'],undefined);
    if(url.endsWith('/v1/agents'))return reply({agents:[]});
    if(url.includes('/v1/remote-sessions'))return reply({ok:true,status:'connected',agents:[{agent_id:target.agent_id,device_id:target.device_id,provider:'codex',status:'ready'}],sessions:[target]});
    if(url.endsWith('/cancel')) {cancelled=true; return reply({ok:true});}
    if(url.endsWith('/v1/turns')) {posts.push(JSON.parse(init.body)); return reply({ok:true,turn_id:'turn-'+posts.length});}
    reads.push(url); const task={status:cancelled?'cancelled':completed?'done':'running',result:{ok:!cancelled,cancelled,cleanup_confirmed:completed||cancelled,json:{last_message:'remote feedback'}}};
    return reply({ok:true,turn_id:'turn-restored',task});
  };
  return {posts,reads,fetchImpl,pendingStore:{get:key=>pending.get(key),set:(key,value)=>value?pending.set(key,value):pending.delete(key)},pending,slow:()=>{completed=false;},cancelled:()=>cancelled};
}
const config={cwd:'C:\\station\\local',remoteTarget:target,env:{POCKET_VIBE_AUTH_MODE:'public',POCKET_VIBE_HUB_URL:target.service_url,POCKET_VIBE_OWNER_ID:target.owner_id,POCKET_VIBE_TOOL_TOKEN:'test-control'}};
const auth=()=>({enabled:true,mode:'public',serviceUrl:target.service_url,ownerId:target.owner_id,controlToken:'test-control'});
test('public member sends native target, stable idempotency references and two turns; stop waits for actual exit proof',async()=> {
  const hub=publicHub(),events=[]; const backend=new PocketVibeBackend({...hub,pollIntervalMs:1,liveAuth:auth});
  const session=backend.createSession(config,event=>events.push(event)); await session.start();
  try {
    session.sendUserText('one'); await until(()=>events.filter(event=>event.kind==='message'&&event.message.type==='result').length===1);
    session.sendUserText('two'); await until(()=>events.filter(event=>event.kind==='message'&&event.message.type==='result').length===2);
    assert.equal(hub.posts.length,2); assert.notEqual(hub.posts[0].idempotency_key,hub.posts[1].idempotency_key);
    for(const body of hub.posts) { assert.equal(body.session_id,target.session_id); assert.equal(body.cwd,target.cwd); assert.equal(body.target_agent_id,target.agent_id); assert.equal(body.turn_options.mode,'resume'); }
    assert.equal(hub.pending.size,0);
    hub.slow(); session.sendUserText('slow'); await until(()=>hub.posts.length===3);
    assert.equal(hub.pending.size,1); await session.interrupt('user'); assert.equal(hub.cancelled(),true); assert.equal(hub.pending.size,0);
    assert.ok(events.some(event=>event.kind==='message'&&JSON.stringify(event).includes('退出已确认')));
  } finally {session.end();}
});
test('restart restores original submission without POST, shutdown preserves pending, and owner mismatch never dispatches',async()=> {
  const hub=publicHub(),events=[]; const key=JSON.stringify([target.service_url,target.owner_id,target.device_id,target.provider,target.session_id]); hub.pending.set(key,'persisted-submission');
  const session=new PocketVibeBackend({...hub,pollIntervalMs:1,liveAuth:auth}).createSession(config,event=>events.push(event));
  try {await session.start(); await until(()=>hub.reads.some(url=>url.includes('persisted-submission'))); await until(()=>hub.pending.size===0); assert.equal(hub.posts.length,0);}
  finally {session.end();}
  hub.slow(); const next=new PocketVibeBackend({...hub,pollIntervalMs:1,liveAuth:auth}).createSession(config,()=>{});
  await next.start(); next.sendUserText('shutdown'); await until(()=>hub.posts.length===1); await next.interrupt('shutdown'); next.end(); assert.equal(hub.cancelled(),false); assert.equal(hub.pending.size,1);
  const invalid=new PocketVibeBackend({...hub,pollIntervalMs:1,liveAuth:auth}).createSession({...config,remoteTarget:{...target,owner_id:'someone-else'}},event=>events.push(event));
  await assert.rejects(invalid.start(),/身份|服务/); invalid.end(); assert.equal(hub.posts.length,1);
});

test('real public Bridge → durable Hub → Station native two turns and remote process cancellation', {skip:!process.env.POCKET_VIBE_TEST_PYTHON||!macosTaskTestsEnabled},async(t)=> {
  const fixture=fileURLToPath(new URL('../services/remote/tests/public_remote_fixture.py',import.meta.url));
  const child=spawn(process.env.POCKET_VIBE_TEST_PYTHON,['-u',fixture],{stdio:['pipe','pipe','pipe']}); let output='',errors='',ready;
  child.stdout.on('data',chunk=>{output+=chunk; for(const line of output.split(/\r?\n/)) {try {const data=JSON.parse(line);if(data.ready)ready=data;}catch{}}});
  child.stderr.on('data',chunk=>{errors+=chunk;});
  t.after(async()=>{child.stdin.end('stop\n'); await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,15000))]); if(child.exitCode===null)child.kill();});
  await until(()=>ready||child.exitCode!==null); assert.ok(ready,errors); process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK='1';
  const remote={...ready.target,service_url:ready.url,owner_id:ready.owner}; const pending=new Map(); const events=[];
  const session=new PocketVibeBackend({pollIntervalMs:10,healthTimeoutMs:10000,pendingStore:{get:key=>pending.get(key),set:(key,value)=>value?pending.set(key,value):pending.delete(key)},
    liveAuth:()=>({enabled:true,mode:'public',serviceUrl:ready.url,ownerId:ready.owner,controlToken:ready.token})}).createSession({cwd:root,remoteTarget:remote,
      env:{POCKET_VIBE_AUTH_MODE:'public',POCKET_VIBE_HUB_URL:ready.url,POCKET_VIBE_OWNER_ID:ready.owner,POCKET_VIBE_TOOL_TOKEN:ready.token}},event=>events.push(event));
  try {
    await session.start(); session.sendUserText('round-one'); await until(()=>events.filter(event=>event.kind==='message'&&event.message.type==='result').length===1);
    session.sendUserText('round-two'); await until(()=>events.filter(event=>event.kind==='message'&&event.message.type==='result').length===2);
    assert.equal((await readFile(join(remote.cwd,'turns.txt'),'utf8')).split(/\r?\n/).filter(Boolean).length,2);
    assert.equal(pending.size,0); session.sendUserText('slow'); await until(()=>existsSync(join(remote.cwd,'owned-writing.txt')));
    await session.interrupt('user'); assert.equal(pending.size,0);
    assert.ok(events.some(event=>JSON.stringify(event).includes('进程退出已确认')));
  } finally {session.end(); delete process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK;}
});
