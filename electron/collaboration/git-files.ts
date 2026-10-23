import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, lstat, mkdir, writeFile,realpath,rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git } from './workspaces.js';
import { normalizeGithubRepository } from './repository-identity.js';
import {classifyKind,parseAttachmentBuffer} from '../attachments/parse.js';
const exec=promisify(execFile);
export async function previewGitFile(root:string,commit:string,file:string):Promise<{text?:string;image?:string}>{
  if(!/^[a-f0-9]{40}$/.test(commit))throw new Error('成果版本无效');safeRelative(file);
  const entry=await git(root,['ls-tree',commit,'--',file]);if(!/^(100644|100755) blob /.test(entry))throw new Error('只预览准确提交中的普通文件');
  const {stdout}=await exec('git',['-C',root,'show',commit+':'+file],{encoding:'buffer',windowsHide:true,timeout:30000,maxBuffer:25*1024*1024});
  if(!classifyKind(file,''))return {text:'此文件可通过“获取准确成果副本”在本机打开。'};
  const parsed=await parseAttachmentBuffer({name:basename(file),mime:'',sizeBytes:stdout.length,buffer:stdout});
  return parsed.kind==='image'?{image:'data:'+parsed.imageMediaType+';base64,'+stdout.toString('base64')}:{text:(parsed.text??'').slice(0,128000)};
}
export interface GitFileReference {repository:string;commit:string;paths:string[]}
export interface FilePublication extends GitFileReference {cwd:string;branch:string}
export function safeRelative(file:string):string {
  if(!file||file.includes('\0')||isAbsolute(file)||file.split(/[\\/]/).some(p=>!p||p==='..'||p==='.'||p.toLowerCase()==='.git')) throw new Error('文件引用必须是安全的仓库内相对路径');
  return file.replaceAll('\\','/');
}
export async function publishFiles(root:string,workspaceRoot:string,selected:string[],baseCommit:string,prepared?:(publication:FilePublication)=>Promise<void>):Promise<GitFileReference> {
  if(!selected.length||selected.length>100||!/^[a-f0-9]{40}$/.test(baseCommit))throw new Error('请明确选择文件和准确基线版本');
  const repository=normalizeGithubRepository(await git(root,['remote','get-url','origin'])).canonicalUrl;
  const branch='codex/station-materials-'+randomUUID();const cwd=join(workspaceRoot,branch.split('/')[1]);
  await mkdir(workspaceRoot,{recursive:true});await git(root,['worktree','add','-b',branch,cwd,baseCommit]);
  const files:string[]=[];
  for(const file of selected) {
    const info=await lstat(file);const name=safeRelative(basename(file));
    if(!info.isFile()||info.isSymbolicLink()||info.size>50*1024*1024)throw new Error('仅支持选定的普通文件；单文件上限 50 MiB，大文件传输尚未启用');
    if(files.includes(name))throw new Error('所选文件同名，请分别共享或先在本机明确整理名称');
    files.push(name);await copyFile(file,join(cwd,name));
  }
  await git(cwd,['add','--',...files]);await git(cwd,['commit','-m','Share selected Station materials']);
  const commit=await git(cwd,['rev-parse','HEAD']);
  const publication={repository,commit,paths:files,cwd,branch};await prepared?.(publication);
  return pushPublication(publication);
}
export async function pushPublication(publication:FilePublication,write=(args:string[])=>git(publication.cwd,args)):Promise<GitFileReference> {
  const {repository,commit,paths,cwd,branch}=publication;
  if(!/^[a-f0-9]{40}$/.test(commit)||!/^codex\/station-materials-[0-9a-f-]+$/.test(branch))throw new Error('资料交付身份无效');
  if((await git(cwd,['ls-remote','origin','refs/heads/'+branch])).split(/\s/)[0]!==commit)await write(['push','origin',commit+':refs/heads/'+branch]);
  const remote=await git(cwd,['ls-remote','origin','refs/heads/'+branch]);
  if(remote.split(/\s/)[0]!==commit)throw new Error('共享提交尚未在 GitHub 确认，不能标记已共享');
  return {repository,commit,paths};
}
export async function materializeFiles(root:string,ref:GitFileReference,destination:string,authorizedRoot=dirname(destination)):Promise<string[]> {
  if(normalizeGithubRepository(await git(root,['remote','get-url','origin'])).canonicalUrl!==ref.repository||!/^[a-f0-9]{40}$/.test(ref.commit))throw new Error('文件资料仓库或准确版本不匹配');
  const base=await realpath(authorizedRoot);await mkdir(destination,{recursive:true});const actual=await realpath(destination);
  const within=(parent:string,child:string)=>{const r=relative(parent,child);return !isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep);};
  const expected=resolve(destination);if(!within(base,actual)||(process.platform==='win32'?actual.toLowerCase()!==expected.toLowerCase():actual!==expected))throw new Error('输入目录存在越界或符号链接，已保留内容等待核对');
  await git(root,['fetch','origin',ref.commit]);const written:string[]=[];
  for(const raw of ref.paths) {
    const file=safeRelative(raw);const entry=await git(root,['ls-tree',ref.commit,'--',file]);
    if(!/^(100644|100755) blob /.test(entry))throw new Error('资料引用不是普通 Git 文件');
    const target=join(destination,file);const rel=relative(destination,target);if(rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error('资料路径越界');
    await mkdir(dirname(target),{recursive:true});
    if(!within(actual,await realpath(dirname(target))))throw new Error('输入文件的实际目录超出授权范围');
    const {stdout}=await exec('git',['-C',root,'show',ref.commit+':'+file],{encoding:'buffer',windowsHide:true,timeout:30000,maxBuffer:50*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
    const staged=target+'.next-'+randomUUID();await writeFile(staged,stdout,{flag:'wx'});await rename(staged,target);written.push(target);
  }
  return written;
}
export async function fetchDelivery(root:string,commit:string,parent:string,taskId:string):Promise<string> {
  if(!/^[a-f0-9]{40}$/.test(commit))throw new Error('成果缺少准确提交号');
  await git(root,['fetch','origin',commit]);await mkdir(parent,{recursive:true});const cwd=join(parent,'station-result-'+taskId);
  await git(root,['worktree','add','--detach',cwd,commit]);return cwd;
}
