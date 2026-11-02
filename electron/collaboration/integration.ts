import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git, runFile } from './workspaces.js';
import { ensurePullRequest } from './github.js';
import { normalizeGithubRepository } from './repository-identity.js';
export async function prepareMeetingBranch(root:string,workspaceRoot:string,meeting:string,commit:string):Promise<string> {
  const branch='codex/station-meeting-'+meeting;await mkdir(workspaceRoot,{recursive:true});const cwd=join(workspaceRoot,'meeting-'+meeting);
  let exists=false;try {await realpath(cwd);exists=true;}catch{}
  if(exists) {
    if(await realpath(await git(cwd,['rev-parse','--show-toplevel']))!==await realpath(cwd)||await git(cwd,['branch','--show-current'])!==branch||await realpath(await git(cwd,['rev-parse','--path-format=absolute','--git-common-dir']))!==await realpath(await git(root,['rev-parse','--path-format=absolute','--git-common-dir'])))throw new Error('会议工作区已有内容不符合本机绑定，保留目录等待核对');
    return cwd;
  }
  if(!/^[a-f0-9]{40}$/.test(commit))throw new Error('会议分支需要准确基线提交号');
  await git(root,['worktree','add','-b',branch,cwd,commit]);await git(cwd,['push','-u','origin',branch]);return cwd;
}
export async function integrateDelivery(cwd:string,commit:string,checks:string[][],runCheck:(binary:string,args:string[],cwd:string)=>Promise<string>=runFile):Promise<{commit:string;checks:string[]}> {
  if(!checks.length)throw new Error('请在协调设备绑定项目时确认组合验证命令');
  if(await git(cwd,['status','--porcelain']))throw new Error('会议集成工作区存在待核对修改');
  await git(cwd,['fetch','origin',commit]);
  const previous=await git(cwd,['rev-parse','HEAD']);const candidateBranch='codex/station-candidate-'+randomUUID();
  const candidate=cwd+'-candidate-'+randomUUID();await git(cwd,['worktree','add','-b',candidateBranch,candidate,previous]);
  try {await git(candidate,['merge','--no-ff','--no-edit',commit]);}
  catch {throw new Error('成果集成冲突，已保留候选工作区和最近通过验证的会议版本，请在原任务中返工');}
  const results:string[]=[];
  for(const [binary,...args] of checks) {
    try {const output=await runCheck(binary,args,candidate);results.push([binary,...args].join(' ')+'\n'+output.slice(-8000));}
    catch {throw new Error('组合验证失败，当前候选版本未放行依赖任务；请在原任务返工');}
  }
  const head=await git(candidate,['rev-parse','HEAD']);await git(cwd,['merge','--ff-only',candidateBranch]);
  await git(cwd,['push','origin','HEAD']);return {commit:head,checks:results};
}
export async function finalMeetingPullRequest(cwd:string,meeting:string,targetBranch:string,summary:string):Promise<string> {
  if(!targetBranch||targetBranch.startsWith('-'))throw new Error('请明确指定最终目标分支');
  const repository=normalizeGithubRepository(await git(cwd,['remote','get-url','origin'])).canonicalUrl;
  return ensurePullRequest(repository,'codex/station-meeting-'+meeting,targetBranch,'Station meeting delivery',summary,await git(cwd,['rev-parse','HEAD']));
}
