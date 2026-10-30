import {app,safeStorage} from 'electron';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
export interface CredentialBinding {ownerId:string;serviceUrl:string;deviceId:string}
export interface DeviceCredentialMetadata extends CredentialBinding {version:1;purpose:'station-device';provider:'electron-safeStorage';profileId:string;keyFingerprint:string|null;appVersion:string;electronVersion:string;createdAt:string}
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export function credentialContext(){
  const path=resolve(app.getPath('userData'));let keyFingerprint:string|null=null;
  try{const key=JSON.parse(readFileSync(join(path,'Local State'),'utf8')).os_crypt?.encrypted_key;if(typeof key==='string')keyFingerprint=digest(key);}catch{}
  let available=false;try{available=safeStorage.isEncryptionAvailable();}catch{}
  return {ready:typeof app.isReady==='function'?app.isReady():true,available,profileId:digest(process.platform==='win32'?path.toLowerCase():path),keyFingerprint,platform:process.platform,electron:process.versions.electron??'test-stub',appVersion:typeof app.getVersion==='function'?app.getVersion():'unavailable'};
}
export class LocalCredentialError extends Error {
  constructor(readonly kind:string,readonly diagnostic:Record<string,unknown>){super('本机设备凭据无法安全使用（'+kind+'）；原密文、任务和成果已保留。请正常登录后明确选择凭据恢复，重登本身不保证修复。');}
}
export function credentialMetadata(binding:CredentialBinding):DeviceCredentialMetadata{const c=credentialContext();return {...binding,version:1,purpose:'station-device',provider:'electron-safeStorage',profileId:c.profileId,keyFingerprint:c.keyFingerprint,appVersion:c.appVersion,electronVersion:c.electron,createdAt:new Date().toISOString()};}
export function decryptDeviceCredential(cipher:string,binding:CredentialBinding,meta?:DeviceCredentialMetadata):string{
  const c=credentialContext(),detail={...c,purpose:'station-device',format:meta?.version??'legacy',deviceId:binding.deviceId,ownerId:binding.ownerId};
  if(!c.ready||!c.available)throw new LocalCredentialError('secure-storage-unavailable',detail);
  if(meta&&(meta.version!==1||meta.purpose!=='station-device'||meta.provider!=='electron-safeStorage'||meta.ownerId!==binding.ownerId||meta.deviceId!==binding.deviceId||meta.serviceUrl!==binding.serviceUrl||meta.profileId!==c.profileId))throw new LocalCredentialError('credential-profile-or-identity-mismatch',detail);
  try{const bytes=Buffer.from(cipher,'base64');if(!bytes.length||bytes.toString('base64')!==cipher)throw Object.assign(new Error('Invalid cipher format'),{code:'INVALID_CIPHER_FORMAT'});return safeStorage.decryptString(bytes);}
  catch(error){const e=error as {name?:string;code?:string};throw new LocalCredentialError('local-decryption-failed',{...detail,exceptionName:e.name??'Error',exceptionCode:e.code??'SAFE_STORAGE_DECRYPT_FAILED',originalKeyFingerprint:meta?.keyFingerprint??null,keyChanged:!!meta?.keyFingerprint&&!!c.keyFingerprint&&meta.keyFingerprint!==c.keyFingerprint});}
}
export function encryptDeviceCredential(token:string,binding:CredentialBinding){
  const c=credentialContext();if(!c.ready||!c.available)throw new LocalCredentialError('secure-storage-unavailable',c);
  const cipher=safeStorage.encryptString(token).toString('base64');const metadata=credentialMetadata(binding);
  if(decryptDeviceCredential(cipher,binding,metadata)!==token)throw new LocalCredentialError('roundtrip-failed',c);
  return {cipher,metadata};
}
