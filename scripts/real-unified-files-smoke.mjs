import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {app} from 'electron';
import {CodexBackend} from '../dist-electron/backends/codex-adapter.js';
import {GuardedCodexExecution} from '../dist-electron/collaboration/native-helper.js';
const root=resolve('runtime/unified-meeting-2026-10-22/real-selected-input-'+randomUUID());await mkdir(root,{recursive:true});
app.getAppPath=()=>process.cwd();process.env.POCKET_VIBE_STATE_DIR=join(root,'owned-state');
// Synthetic PNG test input, never a user screen or private image.
const palette=[[255,0,0],[0,0,255],[0,180,0],[255,255,0]];
function crc(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return (c^0xffffffff)>>>0;}
function chunk(type,bytes){const tag=Buffer.from(type);const size=Buffer.alloc(4);size.writeUInt32BE(bytes.length);const sum=Buffer.alloc(4);sum.writeUInt32BE(crc(Buffer.concat([tag,bytes])));return Buffer.concat([size,tag,bytes,sum]);}
const header=Buffer.alloc(13);header.writeUInt32BE(256,0);header.writeUInt32BE(256,4);header[8]=8;header[9]=2;
const rows=[];for(let y=0;y<256;y++){const row=Buffer.alloc(769);for(let x=0;x<256;x++)Buffer.from(palette[(y>=128?2:0)+(x>=128?1:0)]).copy(row,1+x*3);rows.push(row);}
const image=join(root,'selected.png');await writeFile(image,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.concat(rows))),chunk('IEND',Buffer.alloc(0))]));
const backend=new CodexBackend(),binary=backend.resolveBinary();if(!binary)throw new Error('Pinned Codex missing');
const execution=new GuardedCodexExecution(randomUUID(),binary,backend.buildEnv({authMode:'oauth'}));
const report={pass:false,root,scope:'Real selected-image input plus one complete two-file Codex delivery in an owned temporary workspace; no desktop screenshot, GitHub or cloud acceptance',identities:[],approvals:[]};
const timer=setTimeout(()=>void execution.stop(),150000);
try{
  report.result=await execution.run({cwd:root,permission:'workspace-write',images:[image],objective:'这是隔离临时目录中的一个完整验收任务。只根据本轮附带图片识别四个象限的颜色，按左上、右上、左下、右下顺序，把四个小写英文颜色名用逗号分隔写入 delivery-a.txt。在 delivery-b.txt 写入 STATION-SELECTED-INPUT-OK。实际用 Node 读取两个文件并核对与你的识别结果一致，说明命令和结果。只访问当前目录，不联网，不使用其他项目，不修改选定图片。'}, {
    identity:async(threadId,turnId)=>{report.identities.push({threadId,turnId});},output:async()=>{},
    approval:async(id,tool,description,supported)=>{report.approvals.push({id,tool,description,supported});return supported?'allow':'deny';},
  });
  const a=(await readFile(join(root,'delivery-a.txt'),'utf8')).trim(),b=(await readFile(join(root,'delivery-b.txt'),'utf8')).trim();
  if(a!=='red,blue,green,yellow'||b!=='STATION-SELECTED-INPUT-OK'||!report.result.exitConfirmed||report.result.stopped)throw new Error('Actual image recognition, file content or exit proof did not match');
  report.verification={source:'independent executable script',files:['delivery-a.txt','delivery-b.txt'],actualContents:[a,b],passed:true};report.pass=true;
}catch(error){report.error=String(error);process.exitCode=1;}
finally{clearTimeout(timer);execution.close();await writeFile(join(root,'RESULT.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({pass:report.pass,report:join(root,'RESULT.json'),error:report.error}));}
