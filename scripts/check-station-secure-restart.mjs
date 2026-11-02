import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
const root=resolve('runtime/collaboration-2026-10-21/secure-restart-'+randomUUID());
await mkdir(root,{recursive:true});await writeFile(join(root,'.station-smoke'),'isolated-loopback-fixture');
const input=join(root,'private-input.json');const token='isolated-fixture-'+randomUUID();
await writeFile(input,JSON.stringify({url:'http://127.0.0.1:1',owner:randomUUID(),token}));
const env={...process.env,AHASTATION_USER_DATA_DIR:root,AHASTATION_LOCAL_SMOKE_FILE:input,AHASTATION_REMOTE_ALLOW_LOOPBACK:'1'};delete env.ELECTRON_RUN_AS_NODE;
for(let pass=0;pass<3;pass++){
  const child=spawn(resolve('node_modules/electron/dist/electron.exe'),['.'],{env,windowsHide:true,stdio:'ignore'});
  const timeout=setTimeout(()=>child.kill(),20000);
  const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});clearTimeout(timeout);
  if(code!==0)throw new Error('OS secure credential restart failed at process '+(pass+1));
}
const result=JSON.parse(await readFile(join(root,'safe-storage-result.json'),'utf8'));
if(!result.restartDecryption||(await readFile(join(root,'settings.json'),'utf8')).includes(token))throw new Error('Restart evidence missing or plaintext credential written');
console.log(JSON.stringify({pass:true,root,...result}));
