import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath, stat, access } from 'node:fs/promises';
import { join, relative, isAbsolute, sep, dirname } from 'node:path';
import { normalizeGithubRepository } from './repository-identity.js';
import { githubApi, ensurePullRequest } from './github.js';
const exec=promisify(execFile);
export async function executableCommand(binary:string,args:string[]):Promise<string[]> {
  if(process.platform==='win32'&&/^(npm|npx)(\.cmd)?$/i.test(binary)) {
    const tool=binary.toLowerCase().startsWith('npx')?'npx':'npm';
    const found=await exec('where.exe',[tool+'.cmd'],{windowsHide:true,timeout:5000});
    const command=found.stdout.trim().split(/\r?\n/)[0];const script=join(dirname(command),'node_modules','npm','bin',tool+'-cli.js');await access(script);
    const nodes=await exec('where.exe',['node.exe'],{windowsHide:true,timeout:5000});
    return [nodes.stdout.trim().split(/\r?\n/)[0],script,...args];
  }
  if(process.platform==='win32'&&/\.(cmd|bat)$/i.test(binary))throw new Error('请选择可执行文件或 Node 脚本及参数；npm / npx 会自动使用 Node 入口');
  return [binary,...args];
}
export async function runFile(binary: string,args: string[],cwd?: string): Promise<string> {
  const [executable,...parameters]=await executableCommand(binary,args);
  const {stdout}=await exec(executable,parameters,{cwd,windowsHide:true,timeout:60000,maxBuffer:2*1024*1024,
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GH_PROMPT_DISABLED:'1'}});
  return stdout.trim();
}
export const git=(cwd: string,args: string[])=>runFile('git',['-C',cwd,...args]);
export async function trustedDirectory(root: string,candidate: string): Promise<string> {
  const base=await realpath(root); const resolved=await realpath(candidate); const rel=relative(base,resolved);
  if(!(await stat(resolved)).isDirectory() || isAbsolute(rel) || rel==='..' || rel.startsWith('..'+sep)) throw new Error('目录超出本机授权');
  return resolved;
}
export async function checkGithub(root: string,repository: string): Promise<void> {
  if(normalizeGithubRepository(await git(root,['remote','get-url','origin'])).canonicalUrl!==repository) throw new Error('本机副本的 origin 与所选 GitHub 仓库不同');
  await git(root,['ls-remote','--exit-code','origin','HEAD']);
  const name=new URL(repository).pathname.slice(1);
  const result=await githubApi<{permissions:{pull:boolean;push:boolean}}>('/repos/'+name);
  if(result.permissions?.pull!==true) throw new Error('当前 GitHub 登录无法读取该仓库，请在 Git Credential Manager 或 GitHub Desktop 登录');
}
export async function prepareRepository(root: string,workspaceRoot: string,task: string,commit: string,existing?: string): Promise<string> {
  if(!/^[a-f0-9]{40}$/.test(commit)) throw new Error('需要准确的代码基线提交号');
  if(existing) return trustedDirectory(workspaceRoot,existing);
  try {await git(root,['cat-file','-e',commit+'^{commit}']);}
  catch {await git(root,['fetch','origin',commit]);}
  await mkdir(workspaceRoot,{recursive:true});
  const cwd=join(await realpath(workspaceRoot),task);
  try {
    await realpath(cwd);
    if(await realpath(await git(cwd,['rev-parse','--path-format=absolute','--git-common-dir']))!==await realpath(await git(root,['rev-parse','--path-format=absolute','--git-common-dir']))||await git(cwd,['branch','--show-current'])!=='codex/station-task-'+task||await git(cwd,['rev-parse','HEAD'])!==commit||await git(cwd,['status','--porcelain']))throw new Error('既有任务工作区需要核对，文件已保留');
    return cwd;
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  await git(root,['worktree','add','-b','codex/station-task-'+task,cwd,commit]);
  if(await git(cwd,['status','--porcelain'])) throw new Error('任务工作区不干净，请核对保留的目录');
  return cwd;
}
export async function deliverRepository(cwd: string,task: string,meeting: string,summary: string,baseCommit:string,ensurePr=ensurePullRequest,authorize=async()=>{},write=(args:string[],_phase:string)=>git(cwd,args)): Promise<Record<string,unknown>> {
  const branch=await git(cwd,['branch','--show-current']);
  if(branch!=='codex/station-task-'+task) throw new Error('任务分支已变化，保留文件等待范围确认');
  if(await git(cwd,['status','--porcelain'])) {
    await authorize();
    await write(['add','--all'],'add'); await authorize();await write(['commit','-m','Station delivery '+task],'commit');
    if(await git(cwd,['status','--porcelain']))throw new Error('原交付后工作区内容有变化，保留文件等待范围核对');
  }
  const commit=await git(cwd,['rev-parse','HEAD']);
  if(!/^[a-f0-9]{40}$/.test(baseCommit))throw new Error('成果缺少准确原始基线，保留任务文件等待核对');
  const files=(await git(cwd,['diff','--name-only',baseCommit,commit])).split('\n').filter(Boolean);
  if(!files.length)return {summary:summary.slice(0,24000),tests:'本轮没有代码差异，验证说明见执行输出',files,commit,prUrl:'',branch:''};
  await authorize();
  const remote=(await git(cwd,['ls-remote','origin','refs/heads/'+branch])).split(/\s/)[0];
  if(remote!==commit)await write(['push','-u','origin',branch],'push');
  if((await git(cwd,['ls-remote','origin','refs/heads/'+branch])).split(/\s/)[0]!==commit)throw new Error('原成果推送尚未在远端确认，保留交付待处理');
  const repository=normalizeGithubRepository(await git(cwd,['remote','get-url','origin'])).canonicalUrl;
  const base='codex/station-meeting-'+meeting;
  // Coordinator prepares the meeting branch; a missing base is a delivery issue,
  // never a reason to run the Agent again.
  await authorize();const prUrl=await ensurePr(repository,branch,base,'Station task '+task,summary,commit);
  return {summary:summary.slice(0,24000),tests:'详见任务执行输出及成果内测试记录',files,commit,prUrl,branch};
}
