import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { applicationEnv, findGit, launchDetached } from '../scripts/launch-station.mjs';

test('independent launch sanitizes only scoped app environment, discovers Git, and never changes HOME/auth or parent env',()=>{
  const source={PATH:'original',HOME:'home',CODEX_HOME:'codex-home',ELECTRON_RUN_AS_NODE:'1',NODE_OPTIONS:'--inspect',VITE_DEV_SERVER_URL:'http://localhost:5173',VIBE_MEET_DEVTOOLS:'1'};
  const result=applicationEnv(source,process.execPath,'git-directory');
  assert.equal(result.HOME,'home'); assert.equal(result.CODEX_HOME,'codex-home'); assert.equal(source.NODE_OPTIONS,'--inspect');
  for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','VITE_DEV_SERVER_URL','VIBE_MEET_DEVTOOLS']) assert.equal(result[key],undefined);
  assert.match(result.PATH,/git-directory/);
  const attempted=[];
  const git=findGit({ProgramFiles:'C:\\Program Files'},process.execPath,(binary,args)=>{attempted.push([binary,args]);return binary==='git'?{status:1}:{status:0,stdout:'git version 2.50.0.windows.1'};});
  assert.ok(git); assert.deepEqual(attempted[0],['git',['--version']]);
  assert.throws(()=>findGit({},process.execPath,()=>({status:1})),/Git was not found/);
});

test('launcher detaches with independent stdio, unrefs after successful spawn, and reports spawn failure',async()=>{
  let options, unref=0; const env={PATH:'fixture'};
  const pid=await launchDetached('fixture',['.'],{cwd:'/fixture',env},(binary,args,opts)=>{
    options=opts; assert.equal(binary,'fixture');assert.deepEqual(args,['.']);
    const child=new EventEmitter(); child.pid=123; child.unref=()=>unref++;
    queueMicrotask(()=>child.emit('spawn')); return child;
  });
  assert.equal(pid,123);assert.equal(options.detached,true);assert.equal(options.stdio,'ignore');assert.equal(options.windowsHide,true);assert.equal(options.env,env);assert.equal(unref,1);
  await assert.rejects(launchDetached('fixture',[],{cwd:'/fixture',env},()=>{const child=new EventEmitter();queueMicrotask(()=>child.emit('error',new Error('spawn denied')));return child;}),/spawn denied/);
});

test('Windows process fixture survives normal launcher exit and forced launcher termination; all fixture children exit', {skip:process.platform!=='win32'},async()=>{
  const root=await mkdtemp(join(tmpdir(),'station-launch-fixture-'));
  const module=pathToFileURL(fileURLToPath(new URL('../scripts/launch-station.mjs',import.meta.url))).href;
  const child=join(root,'child.cjs');
  await writeFile(child,`const fs=require('fs');const [root,mode]=process.argv.slice(2);let count=0;const timer=setInterval(()=>{fs.writeFileSync(root+'/'+mode+'.beat',String(++count));if(fs.existsSync(root+'/'+mode+'.stop')||count>100){clearInterval(timer);fs.writeFileSync(root+'/'+mode+'.done','done');}},100);`);
  const until=async fn=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50));}assert.fail('fixture timed out');};
  const exists=async path=>{try{await access(path);return true;}catch{return false;}};
  const parents=[];
  try {
    for(const mode of ['normal','terminated']){
      const parent=spawn(process.execPath,['--input-type=module','-e',`import {launchDetached} from ${JSON.stringify(module)};import {writeFileSync} from 'node:fs';const pid=await launchDetached(process.execPath,[${JSON.stringify(child)},${JSON.stringify(root)},${JSON.stringify(mode)}],{cwd:${JSON.stringify(root)},env:process.env});writeFileSync(${JSON.stringify(join(root,mode+'.parent'))},String(pid));${mode==='terminated'?'setInterval(()=>{},1000);':''}`],{stdio:'ignore',windowsHide:true});
      parents.push(parent);
      await until(()=>exists(join(root,mode+'.beat')));
      if(mode==='terminated')parent.kill();
      await until(async()=>parent.exitCode!==null || parent.signalCode!==null);
      const before=await readFile(join(root,mode+'.beat'),'utf8');
      await until(async()=>await readFile(join(root,mode+'.beat'),'utf8')!==before);
      await writeFile(join(root,mode+'.stop'),'stop');
      await until(()=>exists(join(root,mode+'.done')));
      const pid=Number(await readFile(join(root,mode+'.parent'),'utf8'));
      await until(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
    }
  } finally {
    for(const mode of ['normal','terminated'])await writeFile(join(root,mode+'.stop'),'stop');
    for(const parent of parents)if(parent.exitCode===null&&parent.signalCode===null)parent.kill();
    for(const mode of ['normal','terminated'])if(await exists(join(root,mode+'.parent')))await until(()=>exists(join(root,mode+'.done')));
    await rm(root,{recursive:true,force:true});
  }
});

test('second launch/macOS activate recreates missing main window, restores minimized window, and keeps existing windows',async()=>{
  const {focusMainWindow}=await import('../dist-electron/main-window-focus.js');
  const actions=[];let current=null;
  const create=()=>{actions.push('create');current={isMinimized:()=>true,restore:()=>actions.push('restore'),show:()=>actions.push('show'),focus:()=>actions.push('focus')};};
  focusMainWindow(()=>current,create);assert.deepEqual(actions,['create','restore','show','focus']);
  actions.length=0;focusMainWindow(()=>current,create);assert.deepEqual(actions,['restore','show','focus']);
});

test('lifecycle logs keep exit/load metadata, exclude secrets, and do not replace exception/quit behavior',async()=>{
  const root=await mkdtemp(join(tmpdir(),'station-lifecycle-'));
  const previous=process.env.AHASTATION_LAUNCH_LOG_DIR;process.env.AHASTATION_LAUNCH_LOG_DIR=root;
  const oldExit=process.listeners('exit'),oldMonitor=process.listeners('uncaughtExceptionMonitor');
  const oldUncaught=process.listeners('uncaughtException');
  try {
    const {installLifecycleLog}=await import('../dist-electron/lifecycle-log.js');
    const app=new EventEmitter();app.getPath=()=>root;installLifecycleLog(app);
    const win=new EventEmitter();win.id=2;win.webContents=new EventEmitter();
    app.emit('browser-window-created',null,win);win.webContents.emit('did-fail-load',null,-102,'secret-token','https://secret.example?token=secret');
    app.emit('second-instance',null,['secret-password']);app.emit('before-quit');app.emit('quit',null,0);
    const log=await readFile(join(root,'lifecycle.jsonl'),'utf8');
    assert.match(log,/main-start/);assert.match(log,/renderer-load-failed/);assert.match(log,/before-quit/);assert.match(log,/"code":0/);assert.doesNotMatch(log,/secret/);
    assert.deepEqual(process.listeners('uncaughtException'),oldUncaught);
  } finally {
    for(const fn of process.listeners('exit'))if(!oldExit.includes(fn))process.removeListener('exit',fn);
    for(const fn of process.listeners('uncaughtExceptionMonitor'))if(!oldMonitor.includes(fn))process.removeListener('uncaughtExceptionMonitor',fn);
    if(previous===undefined)delete process.env.AHASTATION_LAUNCH_LOG_DIR;else process.env.AHASTATION_LAUNCH_LOG_DIR=previous;
    await rm(root,{recursive:true,force:true});
  }
});
