import { spawn } from 'node:child_process';
import { collaborationFetch } from './network.js';
/** Use the user's normal Git credential manager. No credential reaches IPC or logs. */
async function credential():Promise<string> {
  return new Promise((resolve,reject)=>{
    const child=spawn('git',['credential','fill'],{windowsHide:true,stdio:['pipe','pipe','pipe'],
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'}});
    let output='';const timeout=setTimeout(()=>{child.kill();reject(new Error('GitHub 登录检查超时，请在本机完成 Git/GitHub 登录'));},10000);
    child.stdout.on('data',value=>{output+=String(value);if(output.length>16000){child.kill();reject(new Error('Git 凭证响应无效'));}});
    child.stderr.resume();child.on('error',()=>{clearTimeout(timeout);reject(new Error('请先安装 Git，并使用 Git Credential Manager 或 GitHub Desktop 登录'));});
    child.on('close',code=>{
      clearTimeout(timeout);const secret=output.split(/\r?\n/).find(line=>line.startsWith('password='))?.slice(9);output='';
      if(code!==0||!secret)reject(new Error('本机缺少 GitHub API 登录，请通过 Git Credential Manager / GitHub Desktop 登录后重试'));
      else resolve(secret);
    });
    child.stdin.end('protocol=https\nhost=github.com\n\n');
  });
}
export async function githubApi<T=Record<string,unknown>>(route:string,body?:unknown):Promise<T> {
  if(!route.startsWith('/repos/'))throw new Error('GitHub API 范围无效');
  const token=await credential();
  const response=await collaborationFetch('https://api.github.com'+route,{method:body?'POST':'GET',
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`GitHub 请求未完成 (${response.status})，保留本机成果，可登录或检查仓库权限后重试交付`);
  return response.json() as Promise<T>;
}
export async function ensurePullRequest(repository:string,head:string,base:string,title:string,body:string,commit?:string,api=githubApi):Promise<string> {
  const name=new URL(repository).pathname.slice(1);const owner=name.split('/')[0];
  const existing=await api<Array<{html_url:string;state:string;merged_at:string|null;head:{sha:string};base:{ref:string}}>>('/repos/'+name+'/pulls?state=all&head='+encodeURIComponent(owner+':'+head)+'&base='+encodeURIComponent(base));
  const open=existing.find(pr=>pr.state==='open'&&pr.base.ref===base);if(open){if(commit&&open.head.sha!==commit)throw new Error('原 PR 的准确提交尚待核对，保留成果与交付记录');return open.html_url;}
  const exact=commit??(await api<{object:{sha:string}}>('/repos/'+name+'/git/ref/heads/'+head.split('/').map(encodeURIComponent).join('/'))).object.sha;
  const same=existing.find(pr=>pr.head.sha===exact&&pr.base.ref===base);
  if(same){if(!same.merged_at)throw new Error('这个成果的 PR 已关闭，请在 GitHub 核对并重新打开后重试交付');return same.html_url;}
  const created=await api<{html_url:string}>('/repos/'+name+'/pulls',{title,head,base,body});
  return created.html_url;
}
