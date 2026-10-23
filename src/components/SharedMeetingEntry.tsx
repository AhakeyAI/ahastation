import {useState} from 'react';
import type {BackendInfo} from '../types';
import {selectSharedMeeting,sharedCommand,sharedRequest,useUnifiedMeeting} from '../lib/unified-meeting-store';
import {perform} from './UnifiedMeetingParts';
export function SharedMeetingEntry({backends,defaultHost,onEnter}:{backends:BackendInfo[];defaultHost:string;onEnter:()=>void}){
  const {view,error}=useUnifiedMeeting();const [title,setTitle]=useState('');const [project,setProject]=useState('');const [host,setHost]=useState('');const [repository,setRepository]=useState('');const [busy,setBusy]=useState(false);
  const actualHost=host||defaultHost;const canHost=backends.find(b=>b.id===actualHost&&b.available&&(b.loggedIn||b.hasApiKey||b.authMode==='none'));
  const create=async()=>{setBusy(true);try{let projectId=project;
    if(project==='new-directory'||project==='new-repository'){const created=await sharedRequest('project.create',{name:title,...(project==='new-directory'?{resourceKind:'directory'}:{repository})}) as {id:string};projectId=created.id;setProject(projectId);
      const binding=await sharedRequest(project==='new-directory'?'directory.grant':'project.bind',{projectId,permission:'workspace-write'}) as {cancelled?:boolean};if(binding.cancelled)return;
    }
    let base:string|undefined;if(projectId){const result=await sharedRequest('project.inspect',{projectId}) as {commit?:string};base=result.commit;}
    const meeting=await sharedCommand('meeting.create',{title,members:[],participants:[],autoApprovePlan:false,autoAssign:false,hostAgentId:actualHost,hostAuthority:'original-orchestrator',...(projectId?{mainProjectId:projectId}:{}),...(base?{mainBaseCommit:base}:{})}) as {id:string};selectSharedMeeting(meeting.id);onEnter();
  }finally{setBusy(false);}};
  return <section className="unified-entry"><h2>同账号会议</h2><p>{view?.connected?'本机已接入，可创建或加入同一会议':'先在设置登录 Station 并接入本机；原本机会议仍可使用。'}</p>{(error||view?.error)&&<p role="alert">{error||view?.error}</p>}<button onClick={()=>void window.vibeMeet.settingsWindow.open()}>账号、本机与 Agent 设置</button>
    {(view?.snapshot.entities.meeting??[]).map(m=><button className="lobby-row" key={m.id} onClick={()=>{selectSharedMeeting(m.id);onEnter();}}><strong>{String(m.title)}</strong><small>沿用原 Host、项目和任务 · 加入查看与交流</small></button>)}
    <details><summary>新建会议：项目与 Host</summary><label>目标<input value={title} onChange={e=>setTitle(e.target.value)} placeholder="本次完整目标"/></label><label>主项目<select value={project} onChange={e=>setProject(e.target.value)}><option value="">纯文字，无需用户目录</option>{(view?.snapshot.entities.project??[]).map(p=><option key={p.id} value={p.id}>{String(p.name)}</option>)}<option value="new-directory">打开本机普通目录…</option><option value="new-repository">添加用户指定仓库…</option></select></label>{project==='new-repository'&&<input aria-label="用户指定 GitHub 仓库" value={repository} onChange={e=>setRepository(e.target.value)} placeholder="https://github.com/用户/仓库"/>}<label>Host<select value={actualHost} onChange={e=>setHost(e.target.value)}>{backends.filter(b=>b.id!=='pocket-vibe'&&b.supportsCoordinator).map(b=><option key={b.id} value={b.id}>{b.displayName} · {b.available&&(b.loggedIn||b.hasApiKey||b.authMode==='none')?'本机已就绪':'去 Agent 设置准备'}</option>)}</select></label>{project&&!project.startsWith('new-')&&<button onClick={()=>perform(sharedRequest(view?.snapshot.entities.project?.find(p=>p.id===project)?.repository?'project.bind':'directory.grant',{projectId:project,permission:'workspace-write'}))}>就地选择本机副本／目录并确认授权</button>}<p>本机执行默认未选入；创建后从参与者区域明确邀请。B 加入不另建 Host，文件执行前再绑定自己的目录。</p><button disabled={busy||!title.trim()||!view?.connected||!canHost} onClick={()=>perform(create())}>创建并进入会议</button></details>
  </section>;
}
