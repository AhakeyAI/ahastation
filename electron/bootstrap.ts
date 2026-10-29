import {app,safeStorage} from 'electron';
import {isAbsolute,join} from 'node:path';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
// Apply the profile before importing any module that may cache settings or
// query a backend at module evaluation time.
if(process.env.AHASTATION_USER_DATA_DIR){
  const profile=process.env.AHASTATION_USER_DATA_DIR;
  if(!isAbsolute(profile))throw new Error('Station profile path must be absolute');
  mkdirSync(profile,{recursive:true});app.setPath('userData',profile);
}
// A loopback-only acceptance harness uses the exact packaged executable for
// OS-bound credential encryption. This branch cannot target a cloud service.
if(process.env.AHASTATION_LOCAL_SMOKE_FILE&&process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK==='1'&&process.env.AHASTATION_USER_DATA_DIR){
  const profile=process.env.AHASTATION_USER_DATA_DIR;
  if(readFileSync(join(profile,'.station-smoke'),'utf8')!=='isolated-loopback-fixture')throw new Error('Missing isolated fixture marker');
  const bytes=readFileSync(process.env.AHASTATION_LOCAL_SMOKE_FILE);if(bytes.length>16384)throw new Error('Smoke input exceeds limit');
  const input=JSON.parse(bytes.toString('utf8')) as {url:string;owner:string;token:string};const url=new URL(input.url);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||typeof input.token!=='string'||input.token.length>256)throw new Error('Only local fixture credentials may be prepared');
  void app.whenReady().then(async()=>{
    if(!await safeStorage.isAsyncEncryptionAvailable())throw new Error('Windows secure credential storage unavailable');
    const settingsFile=join(profile,'settings.json');const restarting=existsSync(settingsFile);
    if(restarting){
      const previous=JSON.parse(readFileSync(settingsFile,'utf8')) as {remoteControl?:{controlTokenEnc?:string}};
      if(!previous.remoteControl?.controlTokenEnc||(await safeStorage.decryptStringAsync(Buffer.from(previous.remoteControl.controlTokenEnc,'base64'))).result!==input.token)throw new Error('Saved OS credential did not survive process restart');
    }
    const encrypted=(await safeStorage.encryptStringAsync(input.token)).toString('base64');
    if((await safeStorage.decryptStringAsync(Buffer.from(encrypted,'base64'))).result!==input.token)throw new Error('Secure credential roundtrip failed');
    writeFileSync(join(profile,'settings.json'),JSON.stringify({remoteControl:{enabled:true,mode:'public',serviceUrl:input.url,ownerId:input.owner,login:'station-fixture',controlTokenEnc:encrypted}}));
    // Normal quit lets Chromium flush its encrypted key preferences. Immediate
    // app.exit can leave a valid in-memory ciphertext unreadable on restart.
    writeFileSync(join(profile,'safe-storage-result.json'),JSON.stringify({platform:process.platform,available:true,roundtrip:true,restartDecryption:restarting,plaintextOnDisk:false}));app.quit();
  }).catch(()=>app.exit(1));
}else await import('./main.js');
