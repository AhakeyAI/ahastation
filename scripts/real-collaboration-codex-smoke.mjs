import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {app} from 'electron';
import {CodexBackend} from '../dist-electron/backends/codex-adapter.js';
import {GuardedCodexExecution} from '../dist-electron/collaboration/native-helper.js';
app.getAppPath=()=>process.cwd();
const root=resolve('runtime/collaboration-2026-10-21/real-codex-'+randomUUID());await mkdir(root,{recursive:true});
const backend=new CodexBackend();const binary=backend.resolveBinary();if(!binary)throw new Error('Bundled Codex runtime unavailable');
const executionId=randomUUID();const execution=new GuardedCodexExecution(executionId,binary,backend.buildEnv({authMode:'oauth'}));
const report={platform:process.platform,executionId,scope:'Real Codex new-task execution in a dedicated temporary directory; no GitHub/cloud/native-desktop acceptance',cwd:root,events:[],approvals:[]};
try {
  const result=await execution.run({cwd:root,permission:'workspace-write',objective:
    '执行一个严格限定在当前临时工作目录的安装候选版验收任务。创建 delivery-a.txt，内容为 AhaStation-A；创建 delivery-b.txt，内容为 AhaStation-B。'+
    '用 Node.js 读取并断言两个文件的准确内容（允许最后一个换行），实际运行验证，最后简洁说明命令和结果。不要访问或更改其他目录，不要联网，不要创建或修改 Git 仓库。'}, {
      identity:async(thread,turn)=>{report.events.push({thread,turn});},
      output:async text=>{report.lastOutput=((report.lastOutput??'')+text).slice(-16000);},
      approval:async(id,tool,description,supported)=>{report.approvals.push({id,tool,supported,description});return supported?'allow':'deny';},
    });
  report.result=result;
  const a=(await readFile(join(root,'delivery-a.txt'),'utf8')).trim();const b=(await readFile(join(root,'delivery-b.txt'),'utf8')).trim();
  if(a!=='AhaStation-A'||b!=='AhaStation-B'||!result.exitConfirmed||result.stopped)throw new Error('Live Codex acceptance did not produce two verified files and confirmed exit');
  report.pass=true;
}catch(error){report.pass=false;report.error=error.message;process.exitCode=1;}
finally{execution.close();await writeFile(join(root,'RESULT.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({pass:report.pass,report:join(root,'RESULT.json'),error:report.error}));}
