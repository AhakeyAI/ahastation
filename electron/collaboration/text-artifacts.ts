import {validateSharedWire} from './production-validation.js';
import {mkdir,open,readFile,rename} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {CollaborationConnection} from './connection.js';
import type {FullTextReference,TextArtifactManifest} from './production-types.js';
export const TEXT_CHUNK_SIZE=32768;
export const MAX_TEXT_BYTES=16*1024*1024;
const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
export async function atomicTextBytes(file:string,data:Uint8Array){
  await mkdir(dirname(file),{recursive:true});const next=file+'.'+randomUUID()+'.next';const h=await open(next,'wx',0o600);
  try{await h.writeFile(data);await h.sync();}finally{await h.close();}
  for(let n=0;;n++){try{await rename(next,file);return;}catch(error){if(process.platform!=='win32'||n===9||!['EPERM','EACCES','EBUSY'].includes(String((error as NodeJS.ErrnoException).code)))throw error;await delay(Math.min((n+1)*50,250));}}
}
export async function readFullText(ref:FullTextReference):Promise<Buffer>{
  const data=await readFile(ref.path);if(data.length!==ref.byteLength||sha(data)!==ref.sha256)throw new Error('本机完整正文的字节数或SHA不匹配，保留原记录核对');new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);return data;
}
export async function preserveText(folder:string,taskId:string,attemptId:string,text:string,complete:boolean){
  if(![taskId,attemptId].every(id=>/^[A-Za-z0-9_-]{1,80}$/.test(id)))throw new Error('完整正文身份不允许用作本机路径');
  const data=Buffer.from(text,'utf8'),digest=sha(data);const seed=sha(Buffer.from(taskId+'\n'+attemptId+'\n'+digest));
  const hex=seed.slice(0,12)+'5'+seed.slice(13,16)+'8'+seed.slice(17,32);const artifactId=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
  const path=join(folder,taskId,attemptId,digest+'.utf8');await atomicTextBytes(path,data);
  const reference:FullTextReference={version:1,path,byteLength:data.length,sha256:digest,contentComplete:complete};await readFullText(reference);
  const manifest:TextArtifactManifest={version:1,artifactId,taskId,attemptId,mediaType:'text/plain;charset=utf-8',byteLength:data.length,sha256:digest,chunkSize:TEXT_CHUNK_SIZE,chunkCount:Math.ceil(data.length/TEXT_CHUNK_SIZE),contentComplete:complete};
  await atomicTextBytes(path+'.manifest.json',Buffer.from(JSON.stringify(manifest)));return {reference,manifest};
}
export async function uploadText(connection:CollaborationConnection,manifest:TextArtifactManifest,ref:FullTextReference,current:()=>boolean){
  const bytes=await readFullText(ref);const check=()=>{if(!current())throw new Error('完整成果仍保留原设备；账号、连接或执行尝试已变化');};check();
  if(bytes.length>MAX_TEXT_BYTES)throw new Error('完整正文超过16MiB传输限额，本机全文保留，尚未完整交付');
  const base='/api/collaboration/v2/text-artifacts';const value=await connection.request(base,manifest as unknown as Record<string,unknown>) as {manifest:TextArtifactManifest;missing:number[]};
  validateSharedWire('text-status',value);check();for(const index of value.missing){if(!Number.isInteger(index)||index<0||index>=manifest.chunkCount)throw new Error('Hub返回无效缺片范围');const data=bytes.subarray(index*TEXT_CHUNK_SIZE,(index+1)*TEXT_CHUNK_SIZE);check();await connection.request(base+'/'+manifest.artifactId+'/chunks/'+index,{data:data.toString('base64'),sha256:sha(data)},'PUT');}
  check();const complete=await connection.request(base+'/'+manifest.artifactId+'/complete',{}) as TextArtifactManifest;validateSharedWire('text-manifest',complete);check();
  if(complete.artifactId!==manifest.artifactId||complete.taskId!==manifest.taskId||complete.sha256!==manifest.sha256||complete.byteLength!==manifest.byteLength||complete.attemptId!==manifest.attemptId||complete.status!=='complete'||!complete.contentComplete)throw new Error('Hub尚未确认本次完整正文；不标记完整交付');return complete;
}
export async function downloadText(connection:CollaborationConnection,expected:TextArtifactManifest,current:()=>boolean,cacheFolder?:string){
  const check=()=>{if(!current())throw new Error('所选成果或协作身份已变化，请重新打开原成果');};check();const base='/api/collaboration/v2/text-artifacts/'+expected.artifactId;
  const {manifest}=await connection.request(base) as {manifest:TextArtifactManifest};
  validateSharedWire('text-manifest',manifest);if(manifest.artifactId!==expected.artifactId||manifest.sha256!==expected.sha256||manifest.byteLength!==expected.byteLength||manifest.taskId!==expected.taskId||manifest.attemptId!==expected.attemptId||manifest.status!=='complete'||!manifest.contentComplete||manifest.byteLength>MAX_TEXT_BYTES||manifest.chunkSize!==TEXT_CHUNK_SIZE||manifest.chunkCount!==Math.ceil(manifest.byteLength/TEXT_CHUNK_SIZE))throw new Error('完整正文身份或状态尚未核验');
  const parts:Buffer[]=[];for(let index=0;index<manifest.chunkCount;index++){
    check();const expectedLength=Math.min(TEXT_CHUNK_SIZE,manifest.byteLength-index*TEXT_CHUNK_SIZE);const cached=cacheFolder?join(cacheFolder,manifest.artifactId+'.'+index):undefined;let bytes:Buffer|undefined;
    if(cached)try{const proof=JSON.parse(await readFile(cached+'.json','utf8')) as {sha256:string;totalSha256:string};const value=await readFile(cached);if(value.length===expectedLength&&proof.totalSha256===manifest.sha256&&sha(value)===proof.sha256)bytes=value;}catch{}
    if(!bytes){const p=await connection.request(base+'/chunks/'+index) as {data:string;sha256:string;index:number};validateSharedWire('text-chunk',p);const b=Buffer.from(p.data,'base64');if(p.index!==index||sha(b)!==p.sha256||b.length!==expectedLength)throw new Error('下载正文分片校验失败');bytes=b;
      if(cached){await atomicTextBytes(cached,b);await atomicTextBytes(cached+'.json',Buffer.from(JSON.stringify({sha256:p.sha256,totalSha256:manifest.sha256})));}}
    parts.push(bytes);
  }
  check();const data=Buffer.concat(parts);if(data.length!==expected.byteLength||sha(data)!==expected.sha256)throw new Error('下载全文字节数或SHA不一致');return {data,text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data)};
}
