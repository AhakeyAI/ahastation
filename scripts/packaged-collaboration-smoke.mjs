import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const python=process.env.COLLABORATION_PYTHON;if(!python)throw new Error('Set COLLABORATION_PYTHON');
const root=resolve((process.env.STATION_EVIDENCE_DIR??'runtime/collaboration-2026-10-21')+'/gui-'+randomUUID());await mkdir(root,{recursive:true});
const exe=resolve(process.argv[2]??'release/win-unpacked/AhaStation.exe');
const hold=!process.argv.includes('--no-hold');
const fixture=spawn(python,['services/remote/tests/station_collaboration_fixture.py'],{windowsHide:true,stdio:['pipe','pipe','pipe']});fixture.stderr.resume();
async function ready(child){return new Promise((resolve,reject)=>{const lines=createInterface({input:child.stdout});const timeout=setTimeout(()=>reject(new Error('Startup timeout')),30000);lines.on('line',line=>{try{const r=JSON.parse(line);if(r.ready){clearTimeout(timeout);resolve(r);}}catch{}});child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Process exited '+code));});});}
async function exited(child){if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));}
async function finish(){for(;;){try{await readFile(join(root,'STOP'));return;}catch{}await new Promise(r=>setTimeout(r,500));}}
let guard;
try{
  const info=await ready(fixture);const input=join(root,'private-fixture.json');await writeFile(input,JSON.stringify({...info,root}),{mode:0o600});
  const prepareEnv={...process.env};delete prepareEnv.ELECTRON_RUN_AS_NODE;
  for(const name of ['GUI-A','GUI-B']){const profile=join(root,name);await mkdir(profile);await writeFile(join(profile,'.station-smoke'),'isolated-loopback-fixture');
    for(let pass=0;pass<2;pass++){const prepare=spawn(exe,[],{windowsHide:true,stdio:'ignore',env:{...prepareEnv,AHASTATION_USER_DATA_DIR:profile,AHASTATION_LOCAL_SMOKE_FILE:input,AHASTATION_REMOTE_ALLOW_LOOPBACK:'1'}});const timeout=setTimeout(()=>prepare.kill(),30000);await exited(prepare);clearTimeout(timeout);if(prepare.exitCode!==0)throw new Error('OS credential preparation/restart failed');}}
  guard=spawn(python,['services/remote/tests/station_gui_guardian.py'],{windowsHide:true,stdio:['pipe','pipe','pipe']});guard.stderr.resume();const running=ready(guard);guard.stdin.write(JSON.stringify({root,exe})+'\n');const processes=await running;
  let states;
  for(let n=0;n<120;n++){
    try{states=await Promise.all(['GUI-A','GUI-B'].map(name=>readFile(join(root,name,'collaboration/station-v2.json'),'utf8').then(JSON.parse)));
      if(states.every(s=>s.tokenEnc&&s.snapshot.entities.device?.filter(d=>d.online).length===2))break;
    }catch{}
    await new Promise(r=>setTimeout(r,500));
  }
  if(!states?.every(s=>s.tokenEnc&&s.snapshot.entities.device?.filter(d=>d.online).length===2))throw new Error('Packaged receivers did not reach the real Hub over WSS');
  const first=states.map(s=>({id:s.deviceId,generation:s.snapshot.entities.device.find(d=>d.id===s.deviceId).connectionGeneration}));
  guard.stdin.end('\n');await exited(guard);
  guard=spawn(python,['services/remote/tests/station_gui_guardian.py'],{windowsHide:true,stdio:['pipe','pipe','pipe']});guard.stderr.resume();const restarted=ready(guard);guard.stdin.write(JSON.stringify({root,exe})+'\n');const after=await restarted;
  let restored=false;
  for(let n=0;n<120;n++){
    states=await Promise.all(['GUI-A','GUI-B'].map(name=>readFile(join(root,name,'collaboration/station-v2.json'),'utf8').then(JSON.parse)));
    restored=states.every((s,i)=>s.deviceId===first[i].id&&s.tokenEnc&&s.snapshot.entities.device.find(d=>d.id===s.deviceId)?.connectionGeneration>first[i].generation&&s.snapshot.entities.device.filter(d=>d.online).length===2);
    if(restored)break;await new Promise(r=>setTimeout(r,500));
  }
  if(!restored)throw new Error('Packaged restart did not preserve device identity and reconnect with saved OS credential');
  let rendererLoaded=false;
  for(let n=0;n<100;n++){
    const logs=await Promise.all(['GUI-A','GUI-B'].map(name=>readFile(join(root,name,'logs/lifecycle.jsonl'),'utf8').then(raw=>raw.trim().split('\n').map(line=>JSON.parse(line)))));
    rendererLoaded=logs.every((events,i)=>events.some(e=>e.pid===after.pids[i]&&e.event==='renderer-loaded')&&!events.some(e=>e.pid===after.pids[i]&&['renderer-load-failed','uncaught-exception'].includes(e.event)));
    if(rendererLoaded)break;await new Promise(r=>setTimeout(r,100));
  }
  if(!rendererLoaded)throw new Error('Packaged main processes did not confirm renderer load');
  const result={pass:true,exe,root,pids:after.pids,initialPids:processes.pids,restartIdentityPreserved:true,rendererLoaded:true,scope:'Two real packaged Windows processes, independent profiles, OS-encrypted credentials, local production HTTP/WSS Hub; no real second computer/cloud/native Desktop claims',devices:states.map(s=>({deviceId:s.deviceId,acceptingTasks:s.config.acceptingTasks,credentialEncrypted:!!s.tokenEnc,cursor:s.snapshot.cursor}))};
  await writeFile(join(root,'RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  if(hold){console.log('GUI instances remain available for visual inspection. Create STOP in the reported root to finish.');await finish();}
}catch(error){console.log(JSON.stringify({pass:false,root,error:error.message}));process.exitCode=1;if(guard&&hold)await finish();}
finally{if(guard){guard.stdin.end('\n');await exited(guard);}fixture.stdin.end('\n');await exited(fixture);}
