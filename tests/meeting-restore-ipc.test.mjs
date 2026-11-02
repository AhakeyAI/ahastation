import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { app,ipcMain,webContents } from 'electron';
import { SessionRegistry } from '../dist-electron/sessions.js';
import { registerSessionsIpc,flushOpenTabsNow } from '../dist-electron/ipc/sessions.js';
import { getSettings,setOpenTabs,flushSettingsWrites } from '../dist-electron/store.js';
import { registerRemoteControlIpc } from '../dist-electron/remote-control.js';

const testRoot=await mkdtemp(join(tmpdir(),'station-restore-ipc-'));
const originalPath=app.getPath;app.getPath=()=>testRoot;
test.after(async()=>{await flushSettingsWrites();app.getPath=originalPath;await rm(testRoot,{recursive:true,force:true});});

test('production snapshot/close IPC preserves other lazy projects and native refs; quitting empty registry retains captured live snapshot',async()=>{
  const root=testRoot;
  const original=ipcMain.handle,handlers=new Map();ipcMain.handle=(name,fn)=>handlers.set(name,fn);
  const a=join(root,'project-a'),b=join(root,'project-b');
  const target={device_id:'device',agent_id:'bridge',provider:'codex',session_id:'native-exact',cwd:'C:\\remote\\authorized',title:'Native'};
  const refs=[{id:'remote',remoteTarget:target}];
  const registry=new SessionRegistry();
  const ctx={registry,getOrchestrator:id=>registry.get(id)?.orchestrator};
  try {
    await setOpenTabs([{cwd:a,openedAt:1,remoteHosts:refs},{cwd:b,openedAt:2,remoteHosts:refs}],a);
    registerSessionsIpc(ctx);
    registry.open('real-a',a,{listHosts:()=>refs,end:async()=>{}});
    flushOpenTabsNow(ctx);await flushSettingsWrites();
    assert.deepEqual(getSettings().openTabs.map(row=>row.cwd),[b,a]);
    assert.equal(getSettings().openTabs[0].remoteHosts[0].remoteTarget.session_id,'native-exact');
    // Same sequence as app teardown: capture first, then empty registry.
    registry.close('real-a');flushOpenTabsNow(ctx);await flushSettingsWrites();
    assert.equal(getSettings().openTabs.length,2);
    assert.equal(getSettings().lastActiveCwd,a);
    assert.equal((await handlers.get('sessions:forget-restored')({}, {cwd:b})).ok,true);
    flushOpenTabsNow(ctx);await flushSettingsWrites();
    assert.deepEqual(getSettings().openTabs.map(row=>row.cwd),[a]);
    registry.open('real-a2',a,{listHosts:()=>refs,end:async()=>{}});
    assert.equal((await handlers.get('sessions:forget-restored')({}, {cwd:a})).ok,false);
    await handlers.get('sessions:close')({}, {id:'real-a2'});await flushSettingsWrites();
    assert.deepEqual(getSettings().openTabs,[]);
    const restored=await handlers.get('sessions:list-restore')();assert.deepEqual(restored.openTabs,[]);
    assert.equal((await handlers.get('sessions:forget-restored')({}, {cwd:'placeholder:any'})).ok,false);
  } finally {ipcMain.handle=original;await flushSettingsWrites();}
});

test('legitimate settings window configuration broadcasts no credentials and main window can refresh without focus',async()=>{
  const oldHandle=ipcMain.handle,oldAll=webContents.getAllWebContents,handlers=new Map(),events=[];
  ipcMain.handle=(name,fn)=>handlers.set(name,fn);
  webContents.getAllWebContents=()=>[{id:1,isDestroyed:()=>false,send:(...args)=>events.push(['main',...args])},{id:2,isDestroyed:()=>false,send:(...args)=>events.push(['settings',...args])}];
  try {
    registerRemoteControlIpc();
    const reply=await handlers.get('remote-control:request')({sender:{id:2}},'configure',{enabled:true,mode:'public',serviceUrl:'https://fixture.example'});
    assert.equal(reply.ok,true);assert.deepEqual(events,[['main','remote-control:changed'],['settings','remote-control:changed']]);
    events.length=0;await handlers.get('remote-control:request')({sender:{id:1}},'status',{});assert.deepEqual(events,[]);
  } finally {ipcMain.handle=oldHandle;webContents.getAllWebContents=oldAll;await flushSettingsWrites();}
});
