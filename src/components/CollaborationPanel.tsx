import {dependencyWait} from '../../electron/collaboration/plan-revision';
import {verifiedDelivery} from '../../electron/collaboration/delivery-identity';
import { useCallback, useEffect, useState } from 'react';
import type { SharedEntity, StationView } from '../../electron/collaboration/production-types';

function text(value: unknown): string {return typeof value==='string'?value:JSON.stringify(value??'');}
type SharedFile={repository:string;commit:string;paths:string[]};
const fileKey=(ref:SharedFile)=>JSON.stringify([ref.repository,ref.commit,ref.paths]);
function ContinueTask({task,submit}:{task:SharedEntity;submit:(payload:Record<string,unknown>)=>Promise<unknown>}) {
  const [objective,setObjective]=useState(text(task.objective));
  const pending=(task.pendingFollowups??[]) as Array<{id:string;text:string;inputs?:SharedFile[];delivered:boolean;ignored?:boolean}>;
  const [edits,setEdits]=useState<Record<string,{action:string;text:string}>>({});
  return <details><summary>核对补充并继续</summary><label>本轮工作要求<textarea value={objective} onChange={e=>setObjective(e.target.value)}/></label>
    {pending.map(f=><div key={f.id}>{f.delivered||f.ignored?<p>{f.delivered?'已经投递，避免重复执行':'已忽略'}：{f.text}</p>:<><select value={edits[f.id]?.action??'include'} onChange={e=>setEdits({...edits,[f.id]:{action:e.target.value,text:edits[f.id]?.text??f.text}})}><option value="include">纳入本轮</option><option value="ignore">忽略此补充</option></select><textarea value={edits[f.id]?.text??f.text} onChange={e=>setEdits({...edits,[f.id]:{action:edits[f.id]?.action??'include',text:e.target.value}})}/></>}{f.inputs?.map(ref=><p key={fileKey(ref)}>资料：{ref.paths.join("、")} · {ref.commit}</p>)}</div>)}
    <button onClick={()=>void submit({text:objective,followups:pending.filter(f=>!f.delivered&&!f.ignored).map(f=>({id:f.id,...(edits[f.id]??{action:'include',text:f.text})}))})}>确认范围并继续原任务</button></details>;
}
export function NativeHistory({deviceId,sessionId,recent,request}:{deviceId:string;sessionId:string;recent:SharedEntity[];request:(action:string,payload?:Record<string,unknown>)=>Promise<unknown>}) {
  const [messages,setMessages]=useState<SharedEntity[]>([]);const [cursor,setCursor]=useState(0);const [more,setMore]=useState(true);
  const merge=(incoming:SharedEntity[])=>setMessages(current=>Array.from(new Map([...current,...incoming].map(m=>[m.id,m])).values()).sort((a,b)=>Number(a.firstSeq)-Number(b.firstSeq)));
  const load=async(after:number)=>{const result=await request('native.history',{deviceId,sessionId,after}) as {messages:SharedEntity[];cursor:number;hasMore:boolean}|undefined;if(result){merge(result.messages);setCursor(result.cursor);setMore(result.hasMore);}};
  useEffect(()=>{void load(0);},[deviceId,sessionId]);
  useEffect(()=>{merge(recent.filter(m=>m.deviceId===deviceId&&m.sessionId===sessionId));},[recent,deviceId,sessionId]);
  return <div>{messages.map(m=><p key={m.id}><small>{text(m.source)} · {text(m.role)}</small><br/>{text(m.text)}</p>)}{more&&<button onClick={()=>void load(cursor)}>加载下一批历史</button>}<small>历史分批加载；已选对话的新消息会持续同步。</small></div>;
}
function useCollaboration() {
  const [view,setView]=useState<StationView>();const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const refresh=useCallback(async()=>{const r=await window.vibeMeet.collaboration.request('status');if(r.ok)setView(r.value as StationView);else setError(r.error??'读取失败');},[]);
  useEffect(()=>{void refresh();return window.vibeMeet.collaboration.onChanged(()=>void refresh());},[refresh]);
  const request=async(action:string,payload?:Record<string,unknown>)=>{
    setBusy(true);setError('');try {const r=await window.vibeMeet.collaboration.request(action,payload);if(!r.ok)throw new Error(r.error);await refresh();return r.value;}
    catch(e){setError(e instanceof Error?e.message:'操作失败');return undefined;}finally{setBusy(false);}
  };
  const command=(action:string,payload:Record<string,unknown>)=>request('command',{action,payload});
  return {view,error,busy,request,command};
}

export function CollaborationSettings() {
  const {view,error,busy,request}=useCollaboration();
  const [name,setName]=useState('');const [repository,setRepository]=useState('');const [projectName,setProjectName]=useState('');
  const [resourceKind,setResourceKind]=useState('repository');const [checks,setChecks]=useState('[]');const [permission,setPermission]=useState('workspace-write');
  if(!view) return <section className="collaboration-settings">正在读取设备协作配置…</section>;
  const save=(patch:Record<string,unknown>,allowed=view.allowedAgents)=>request('configure',{config:{...view.config,...patch},allowedAgents:allowed});
  return <section className="collaboration-settings">
    <h2>同账号设备协作</h2>
    <p>先在上方登录协作账号，再接入本机。模型和 GitHub 使用各电脑自己的登录。</p>
    {view.credentialFailure&&<details><summary>设备凭据本机诊断：{view.credentialFailure.kind}</summary><pre>{JSON.stringify(view.credentialFailure.diagnostic,null,2)}</pre><p>原密文与旧任务保留；账号登录、设备密文和服务端认证是不同状态。不会自动清理或重新配对。</p></details>}{view.legacyError&&<details><summary>历史未分类诊断（保留原记录）</summary><pre>{view.legacyError}</pre></details>}<p role="status">{view.connected?'实时连接在线':'未连接'} · {view.credentialFailure?'设备凭据待核对（记录保留）':view.credentialReady?'设备已注册':'尚未注册'} · {view.config.acceptingTasks?'接收已开放':'接收已关闭'}</p>
    {(error||view.error)&&<p role="alert">{error||view.error}</p>}
    <button disabled={busy} onClick={()=>void request('connect')}>接入／重新连接本机</button>{' '}
    <button disabled={busy} onClick={()=>void request('device.revoke')}>撤销本机接入并停止相关执行</button>{' '}
    <button disabled={busy} onClick={()=>void request('device.reactivate')}>正常登录后明确恢复设备凭据／授权</button>{' '}
    <button disabled={busy} onClick={()=>void request('probe')}>重新检测 Agent</button>
    <label>设备名称 <input value={name||view.config.name} onChange={e=>setName(e.target.value)} onBlur={()=>{if(name)void save({name});}}/></label>
    <label><input type="checkbox" checked={view.config.acceptingTasks} onChange={e=>void save({acceptingTasks:e.target.checked})}/>接收新工作</label>
    <label>全设备任务并发 <input type="number" min={1} max={64} value={view.config.maxConcurrency} onChange={e=>{const n=Number(e.target.value);if(n>=1&&n<=64)void save({maxConcurrency:n});}}/></label>
    {view.probes.map(probe=><label key={probe.agentId}><input type="checkbox" checked={view.allowedAgents.includes(probe.agentId)} disabled={!probe.installed||!probe.authenticated||busy}
      onChange={e=>void save({},e.target.checked?[...view.allowedAgents,probe.agentId]:view.allowedAgents.filter(id=>id!==probe.agentId))}/>
      {probe.agentId} · {probe.installed?'已安装':'缺少组件'} · {probe.authenticated?'已登录':'待登录'}<small>{probe.guide}</small></label>)}
    <h3>共享项目及本机授权</h3>
    <select aria-label="项目资源" value={resourceKind} onChange={e=>setResourceKind(e.target.value)}><option value="repository">GitHub 代码／资料仓库</option><option value="directory">普通研究目录</option><option value="text">纯文字</option></select>
    <input aria-label="共享项目名称" placeholder="项目名称" value={projectName} onChange={e=>setProjectName(e.target.value)}/>
    <input aria-label="GitHub 仓库" placeholder="用户指定的 GitHub 仓库 URL" value={repository} onChange={e=>setRepository(e.target.value)}/>
    <button disabled={busy||!projectName||(resourceKind==='repository'&&!repository)} onClick={()=>void request('project.create',{name:projectName,repository,...(resourceKind!=='repository'?{resourceKind}:{})})}>创建共享项目</button>
    <label>本机权限上限 <select value={permission} onChange={e=>setPermission(e.target.value)}><option value="read-only">只读</option><option value="workspace-write">工作区写入</option><option value="full-access">接续原本完全访问的原生对话（需本机确认）</option></select></label>
    <label>会议组合验证命令（可执行文件和参数的 JSON 数组）<textarea value={checks} onChange={e=>setChecks(e.target.value)} placeholder={'[["npm","run","typecheck"],["npm","test"]]'}/></label>
    {(view.snapshot.entities.project??[]).map(project=><article key={project.id}>
      <strong>{text(project.name)}</strong><p>{text((project.repository as {canonicalUrl?:string})?.canonicalUrl)}</p>
      <p>{view.bindings.find(b=>b.projectId===project.id)?.confirmed||view.directories.find(b=>b.projectId===project.id)?.confirmed?'本机已授权':'本机未授权'}</p>
      {!!project.repository&&<><button disabled={busy} onClick={()=>{try{void request('project.bind',{projectId:project.id,permission:permission==='full-access'?'workspace-write':permission,validationCommands:JSON.parse(checks)});}catch{window.alert('请填写合法的 JSON 命令数组');}}}>选择本机副本和工作区</button>{' '}<button disabled={busy} onClick={()=>void request('project.clone',{projectId:project.id})}>确认位置后克隆</button></>}
      <button disabled={busy} onClick={()=>void request('directory.grant',{projectId:project.id,permission})}>授权普通目录／原生对话发现</button>{' '}
      <button disabled={busy} onClick={()=>void request('project.revoke',{projectId:project.id})}>撤销本机授权并停止相关任务</button>
    </article>)}
    <h3>账号内设备</h3>
    <button disabled={busy} onClick={()=>void request('native.launch')}>启动 Codex 联动桌面</button>{' '}<button disabled={busy} onClick={()=>void request('native.refresh')}>刷新授权目录内原生对话</button>
    <p>首次联动若桌面仍在运行，先保存工作并自行退出桌面，再使用此入口。日常接续无需逐条开启共享。</p>
    {(view.snapshot.entities.device??[]).map(device=><article key={device.id}>
      <strong>{text(device.name)}</strong> · {device.online?'在线':'离线'} · {device.acceptingTasks?'接收开放':'不接收'}
      <p>任务名额 {text(device.activeTasks)} / {text(device.maxConcurrency)} · Agent {(device.agents as Array<{agentId:string;available:boolean}>).map(a=>a.agentId+(a.available?' 可用':' 未就绪')).join('、')}</p>
      <p>项目就绪 {(view.snapshot.entities.binding??[]).filter(b=>b.deviceId===device.id&&b.state==='ready').length} 个</p>
    </article>)}
  </section>;
}

export function SharedMeetings() {
  const {view,error,busy,command,request}=useCollaboration();const [open,setOpen]=useState(false);const [selected,setSelected]=useState('');
  const [title,setTitle]=useState('');const [members,setMembers]=useState<string[]>([]);const [message,setMessage]=useState('');
  const [target,setTarget]=useState('');const [agent,setAgent]=useState('codex');const [project,setProject]=useState('');const [base,setBase]=useState('');
  const [objective,setObjective]=useState('');const [taskTitle,setTaskTitle]=useState('');const [native,setNative]=useState('');
  const [taskNative,setTaskNative]=useState('');const [targetBranch,setTargetBranch]=useState('');const [finalPr,setFinalPr]=useState('');
  const [selectedFiles,setSelectedFiles]=useState<string[]>([]);
  const [parentTask,setParentTask]=useState('');const [dependencies,setDependencies]=useState<string[]>([]);
  const [materials,setMaterials]=useState('');const [materialBase,setMaterialBase]=useState('');const [materialTarget,setMaterialTarget]=useState('');
  const [scope,setScope]=useState<Record<string,unknown>>({});
  if(!open) return <button className="collaboration-launch" onClick={()=>setOpen(true)}>共享会议</button>;
  const entities=view?.snapshot.entities??{};const meetings=entities.meeting??[];const meeting=meetings.find(m=>m.id===selected);
  const tasks=(entities.task??[]).filter(t=>t.meetingId===selected);const devices=entities.device??[];
  const availableFiles=Array.from(new Map([...(view?.sharedFiles??[]),...(entities.message??[]).filter(m=>m.meetingId===selected).flatMap(m=>(m.attachments??[]) as SharedFile[])].map(ref=>[fileKey(ref),ref])).values());
  const controls=(task:SharedEntity,operation:string,extra:Record<string,unknown>={})=>command('task.control',{taskId:task.id,attemptId:task.attemptId,operation,...extra});
  return <div className="collaboration-overlay" role="dialog" aria-modal="true" aria-label="共享会议">
    <header><h2>共享会议</h2><button onClick={()=>setOpen(false)}>暂离界面</button></header>
    <p role="status">{view?.connected?'实时在线':'未连接，请在设置中接入本机'}</p>{(error||view?.error)&&<p role="alert">{error||view?.error}</p>}
    <div className="collaboration-columns"><aside>
      {meetings.map(row=><button key={row.id} onClick={()=>setSelected(row.id)} aria-pressed={selected===row.id}>{text(row.title)}</button>)}
      <hr/><input placeholder="新会议目标" value={title} onChange={e=>setTitle(e.target.value)}/>
      <p>选入执行设备</p>{devices.filter(d=>d.acceptingTasks&&d.online).map(d=><label key={d.id}><input type="checkbox" checked={members.includes(d.id)} onChange={e=>setMembers(e.target.checked?[...members,d.id]:members.filter(id=>id!==d.id))}/>{text(d.name)}</label>)}
      <button disabled={busy||!title||!view?.connected} onClick={()=>void command('meeting.create',{title,members,autoApprovePlan:false,autoAssign:false,hostAgentId:'codex'}).then(value=>{if(value)setSelected((value as SharedEntity).id);})}>创建会议（Codex Host）</button>
    </aside><main>{meeting&&<>
      <h3>{text(meeting.title)}</h3><p>协调设备：{text(devices.find(d=>d.id===meeting.coordinatorDeviceId)?.name)} · {meeting.planApproved?'计划已批准':'等待计划批准'}</p>
      <label><input type="checkbox" checked={meeting.autoApprovePlan===true} onChange={e=>void command('meeting.update',{meetingId:selected,expectedPlanVersion:Number(meeting.planVersion??0),members:meeting.members,autoApprovePlan:e.target.checked,autoAssign:meeting.autoAssign})}/>自动批准计划</label>
      <label><input type="checkbox" checked={meeting.autoAssign===true} onChange={e=>void command('meeting.update',{meetingId:selected,expectedPlanVersion:Number(meeting.planVersion??0),members:meeting.members,autoApprovePlan:meeting.autoApprovePlan,autoAssign:e.target.checked})}/>自动分配</label>
      <section className="collaboration-chat">{(entities.message??[]).filter(m=>m.meetingId===selected).map(m=><article key={m.id}><small>{text(devices.find(d=>d.id===m.sourceDeviceId)?.name)} · {text(m.route)} · {text(m.executionStatus)}</small><p>{text(m.text)}</p>{!!m.output&&<p>原生对话结果：{text(m.output)}</p>}{m.route==='native'&&!m.exitConfirmed&&<button onClick={()=>void command('message.stop',{messageId:m.id})}>停止此接续项</button>}</article>)}</section>
      <select aria-label="发言目标" value={native} onChange={e=>setNative(e.target.value)}><option value="">会议 Host</option>{(entities.native??[]).filter(n=>n.meetingId===selected).map(n=><option key={n.id} value={n.id}>@{text(n.title)}</option>)}</select>
      <textarea aria-label="会议消息" value={message} onChange={e=>setMessage(e.target.value)} placeholder="提出目标或点名交流"/>
      <button disabled={busy||!message} onClick={()=>{const n=(entities.native??[]).find(r=>r.id===native);void command('message.send',{meetingId:selected,text:message,attachments:availableFiles.filter(ref=>selectedFiles.includes(fileKey(ref))),...(n?{nativeSessionId:n.sessionId,targetDeviceId:n.deviceId}:{})}).then(v=>{if(v)setMessage('');});}}>发送</button>
      <h3>计划与完整任务</h3><input placeholder="独立交付标题" value={taskTitle} onChange={e=>setTaskTitle(e.target.value)}/><textarea placeholder="完整工作要求、必要测试与成果说明" value={objective} onChange={e=>setObjective(e.target.value)}/>
      <label>验收后追加工作关联<select value={parentTask} onChange={e=>setParentTask(e.target.value)}><option value="">新目标</option>{tasks.filter(t=>t.status==='accepted').map(t=><option key={t.id} value={t.id}>{text(t.title)}</option>)}</select></label>
      <details><summary>前序成果依赖</summary>{tasks.filter(t=>verifiedDelivery(t)&&view&&!dependencyWait(view.snapshot,selected,t)).map(t=><label key={t.id}><input type="checkbox" checked={dependencies.includes(t.id)} onChange={e=>setDependencies(e.target.checked?[...dependencies,t.id]:dependencies.filter(id=>id!==t.id))}/>{text(t.title)}</label>)}</details>
      <details><summary>加入已有原生对话</summary>{(entities.native??[]).map(n=><article key={n.id}><strong>{text(n.title)}</strong><p>{text(n.status)} · 项目 {text((entities.project??[]).find(p=>p.id===n.projectId)?.name)}</p><button disabled={busy||!!n.meetingId&&n.meetingId!==selected} onClick={()=>void command('native.bind',{meetingId:selected,deviceId:n.deviceId,sessionId:n.sessionId,operation:n.meetingId===selected?'unbind':'bind'})}>{n.meetingId===selected?'停止并核对后移出':'选择加入会议'}</button>
        {n.meetingId===selected&&<><p>{text(n.executionStatus)} · {text(n.reason)}</p><button disabled={busy||!n.nativeTurnId} onClick={()=>void command('native.stop',{meetingId:selected,deviceId:n.deviceId,sessionId:n.sessionId,turnId:n.nativeTurnId})}>停止此原生轮次</button><details><summary>选定对话历史及桌面新消息</summary><NativeHistory deviceId={text(n.deviceId)} sessionId={text(n.sessionId)} recent={entities.history??[]} request={request}/></details></>}</article>)}</details>
      <select aria-label="执行设备" value={target} onChange={e=>setTarget(e.target.value)}><option value="">选择会议内设备</option>{devices.filter(d=>(meeting.members as string[]).includes(d.id)).map(d=><option key={d.id} value={d.id}>{text(d.name)}</option>)}</select>
      <select aria-label="执行 Agent" value={agent} onChange={e=>setAgent(e.target.value)}>{((devices.find(d=>d.id===target)?.agents??[]) as Array<{agentId:string;available:boolean}>).filter(a=>a.available).map(a=><option key={a.agentId}>{a.agentId}</option>)}</select>
      <select aria-label="任务项目" value={project} onChange={e=>setProject(e.target.value)}><option value="">纯文字交流</option>{(entities.project??[]).map(p=><option key={p.id} value={p.id}>{text(p.name)}</option>)}</select>
      <select aria-label="正式任务原生目标" value={taskNative} onChange={e=>setTaskNative(e.target.value)}><option value="">新任务执行</option>{(entities.native??[]).filter(n=>n.meetingId===selected&&n.deviceId===target).map(n=><option key={n.id} value={text(n.sessionId)}>关联原生对话：{text(n.title)}</option>)}</select>
      {project&&<input placeholder="准确的 40 位基线提交号" value={base} onChange={e=>setBase(e.target.value)}/>}
      <button disabled={busy||!project||base.length!==40} onClick={()=>void request('files.share',{projectId:project,baseCommit:base,meetingId:selected})}>选择文件并发布到资料分支</button>
      {availableFiles.map(ref=><label key={fileKey(ref)}><input type="checkbox" checked={selectedFiles.includes(fileKey(ref))} onChange={e=>setSelectedFiles(e.target.checked?[...selectedFiles,fileKey(ref)]:selectedFiles.filter(i=>i!==fileKey(ref)))}/>选入资料 {ref.paths.join('、')} · {ref.commit.slice(0,12)}</label>)}
      <button disabled={busy||!objective||!taskTitle||!target} onClick={()=>{const chosen=(entities.project??[]).find(p=>p.id===project);const nativeRow=(entities.native??[]).find(n=>n.sessionId===taskNative&&n.deviceId===target);const resource=taskNative?'native':chosen?.resourceKind??(project?'repository':'text');void command('plan.propose',{meetingId:selected,expectedPlanVersion:Number(meeting.planVersion??0),expectedPlanDecisionVersion:Number(meeting.planDecisionVersion??0),tasks:[{meetingId:selected,title:taskTitle,objective,targetDeviceId:target,agentId:agent,resource,...(taskNative?{projectId:nativeRow?.projectId,nativeSessionId:taskNative}:project?{projectId:project,...(resource==='repository'?{baseCommit:base}:{})}:{}),permission:resource==='text'?'read-only':taskNative?nativeRow?.permission??'workspace-write':'workspace-write',dependencies,...(parentTask?{parentTaskId:parentTask}:{}),inputs:availableFiles.filter(ref=>selectedFiles.includes(fileKey(ref)))}]});}}>提交计划</button>{' '}
      <button disabled={busy} onClick={()=>void command('plan.decide',{meetingId:selected,approved:true,expectedPlanVersion:Number(meeting.planVersion??0)})}>批准当前计划</button>{' '}
      <button disabled={busy||meeting.planApproved!==true} onClick={()=>{for(const planned of (meeting.plan??[]) as Array<Record<string,unknown>>)void command('task.create',planned);}}>分配批准的任务</button>
      <details><summary>查看当前计划</summary><pre>{JSON.stringify(meeting.plan,null,2)}</pre></details>
      {tasks.map(task=><article className="collaboration-task" key={task.id}><strong>{text(task.title)}</strong><p>{text(task.status)} · {text(devices.find(d=>d.id===task.targetDeviceId)?.name)} / {text(task.agentId)}</p>
        <button onClick={()=>void controls(task,'stop')}>停止任务</button>{' '}
        {task.status==='stopped'&&<ContinueTask key={text(task.attemptId)} task={task} submit={payload=>controls(task,'continue',{...payload,inputs:availableFiles.filter(ref=>selectedFiles.includes(fileKey(ref)))})}/>}
        {task.status==='delivery-pending'&&<button onClick={()=>void controls(task,'retry-delivery')}>重试交付</button>}
        {task.status==='delivered'&&<button onClick={()=>void request('delivery.fetch',{taskId:task.id})}>获取准确成果副本</button>}
        {task.status==='delivered'&&task.resource==='repository'&&<button onClick={()=>void request('delivery.integrate',{taskId:task.id})}>检查成果并运行会议组合验证</button>}
        {task.status==='delivered'&&task.resource!=='repository'&&<button onClick={()=>{const evidence=window.prompt('记录成果审查与验证结果');if(evidence)void controls(task,'review',{evidence}).then(()=>controls(task,'integrate',{evidence}));}}>记录成果核验并放行依赖</button>}
        {task.targetDeviceId===view?.deviceId&&task.resource!=='text'&&task.resource!=='repository'&&<><button onClick={()=>void request('delivery.inspect',{taskId:task.id}).then(value=>{if(value)setScope({...scope,[task.id]:value});})}>核对本机原有修改及当前差异</button>{!!scope[task.id]&&<pre>{JSON.stringify(scope[task.id],null,2)}</pre>}<button disabled={!materials||materialBase.length!==40||!materialTarget} onClick={()=>void request('delivery.select',{taskId:task.id,projectId:materials,baseCommit:materialBase,targetBranch:materialTarget})}>确认成果文件范围并发布到资料仓库</button></>}
        {task.status==='delivered'&&<button onClick={()=>void controls(task,'accept')}>最终验收此任务</button>}
        <button onClick={()=>{const input=window.prompt('保存同一任务的未执行补充；当前选入的准确版本资料也会随补充保存');if(input)void controls(task,'supplement',{text:input,inputs:availableFiles.filter(ref=>selectedFiles.includes(fileKey(ref)))});}}>补充要求与选入资料</button>
        <details><summary>输出、成果及验证证据</summary><pre>{text(task.output)}</pre><pre>{JSON.stringify(task.delivery,null,2)}</pre><pre>{JSON.stringify(task.evidence,null,2)}</pre><p>会议集成：{text(task.integration)}</p></details>
        {!!(task.delivery as {prUrl?:string})?.prUrl&&<a href={(task.delivery as {prUrl:string}).prUrl} target="_blank" rel="noreferrer">打开成果 PR</a>}
      </article>)}
      <label>普通目录／原生对话成果的资料仓库<select value={materials} onChange={e=>setMaterials(e.target.value)}><option value="">选择用户指定并已授权的 GitHub 仓库</option>{(entities.project??[]).filter(p=>p.repository).map(p=><option key={p.id} value={p.id}>{text(p.name)}</option>)}</select></label><input placeholder="资料仓库准确的 40 位基线提交" value={materialBase} onChange={e=>setMaterialBase(e.target.value)}/><input placeholder="资料成果 PR 的目标分支" value={materialTarget} onChange={e=>setMaterialTarget(e.target.value)}/>
      {(entities.approval??[]).filter(a=>(a.meetingId===selected||tasks.some(t=>t.id===a.taskId))&&!a.decision&&!a.effectiveDecision).map(a=><article key={a.id}><strong>工具审批：{text(a.tool)}</strong><pre>{text(a.description)}</pre>{a.supported?<><button onClick={()=>void command('approval.decide',{approvalId:a.id,decision:'allow'})}>允许这一次</button><button onClick={()=>void command('approval.decide',{approvalId:a.id,decision:'deny'})}>拒绝</button></>:<p>请在执行设备的 Codex 桌面处理此原生交互</p>}</article>)}
      {(entities.approval??[]).filter(a=>(a.meetingId===selected||tasks.some(t=>t.id===a.taskId))&&(a.decision||a.effectiveDecision)).map(a=><p key={a.id}>{a.effectiveDecision?'执行端已确认决定：':'审批决定已保存：'}{text(a.effectiveDecision??a.decision)}。执行结果以任务后续状态为准。</p>)}
      <input placeholder="用户指定的最终目标分支" value={targetBranch} onChange={e=>setTargetBranch(e.target.value)}/>
      <button disabled={busy||!targetBranch} onClick={()=>void request('meeting.final-pr',{meetingId:selected,targetBranch}).then(result=>{if(result)setFinalPr(text((result as {prUrl:string}).prUrl));})}>创建／打开会议成果 PR</button>{!!(meeting.finalPrUrl||finalPr)&&<a href={text(meeting.finalPrUrl||finalPr)} target="_blank" rel="noreferrer">前往 GitHub 最终审查与合并</a>}
    </>}</main></div>
  </div>;
}
