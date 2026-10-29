import test from 'node:test';import assert from 'node:assert/strict';
import {UnifiedMeetingHost} from '../dist-electron/collaboration/unified-host.js';
import {SharedCoordinator} from '../dist-electron/collaboration/coordinator.js';
import {GuardedCodexExecution} from '../dist-electron/collaboration/native-helper.js';
import {getBackendRegistry} from '../dist-electron/backends/registry.js';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const tick=()=>new Promise(r=>setImmediate(r));
test('H10 failed native Host output never publishes a plan or reports normal completion',async()=>{
 const original=GuardedCodexExecution.prototype.run,backend=getBackendRegistry().get('codex'),oldResolve=backend.resolveBinary,root=await mkdtemp(join(tmpdir(),'failed-native-host-'));backend.resolveBinary=()=>process.execPath;
 GuardedCodexExecution.prototype.run=async()=>({exitConfirmed:true,stopped:false,turnOutcome:'failed',summary:'failed native output'});
 try{
  const events=[],stages=[],m={id:'m',hostAgentId:'codex'};let dispatches=0;
  const hooks={checkpoint:async(_id,status)=>stages.push(status),reply:async()=>{},plan:async()=>{dispatches++;},session:async()=>{},consult:async()=>{},control:async()=>{}};
  const host=new UnifiedMeetingHost(m,()=>({entities:{}}),root,hooks);host.current={id:'input',invoked:false,output:'',resolve(){},reject(){}};host.dispatchCommands=async()=>dispatches++;
  const session=host.guardedFactory()({emit:e=>events.push(e)});session.sendUserText('original input');for(let n=0;n<10&&!events.length;n++)await tick();assert.equal(dispatches,0);assert.equal(events.some(e=>e.kind==='turn-status'&&e.status==='completed'),false);assert.equal(events.some(e=>e.kind==='error'),true);
  const legacy=new SharedCoordinator(m,()=>({entities:{}}),root,hooks);legacy.finish=async()=>dispatches++;await assert.rejects(legacy.input({id:'legacy-input',text:'original'}),/failed|失败/);assert.equal(dispatches,0);
 }finally{GuardedCodexExecution.prototype.run=original;backend.resolveBinary=oldResolve;await rm(root,{recursive:true,force:true});}
});
