import {useState} from 'react';
import type {UnifiedModel} from '../lib/unified-meeting-store';
import {sharedCommand,sharedRequest} from '../lib/unified-meeting-store';
import {toast} from '../lib/toast';
import {NativeHistory} from './CollaborationPanel';
import type {SharedEntity} from '../../electron/collaboration/production-types';
export const perform=(job:Promise<unknown>)=>{void job.catch(e=>toast.error(String(e instanceof Error?e.message:e)));};
export function SharedExecutionReconciliation({model,messageId,task}:{model:UnifiedModel;messageId?:string;task?:SharedEntity}){
  const message=messageId?model.view.snapshot.entities.message?.find(m=>m.id===messageId):undefined;
  const item=task??message;if(!item)return null;
  const key=task?'execution:'+String(task.attemptId):message?.route==='native'?'execution:'+messageId:message?.route==='control'?'host-control:'+model.meeting.id:'input:'+messageId;
  const issue=model.view.reconciliation?.[key];
  const stopIntent=item.stopRequested||message?.route==='control'&&(message.request as {operation?:string})?.operation==='stop-host';
  const waiting=!item.exitConfirmed&&(stopIntent||['reconcile','stop-unconfirmed'].includes(String(task?item.status:item.executionStatus)));
  const own=task?task.targetDeviceId===model.view.deviceId:message?.route==='host'?model.meeting.coordinatorDeviceId===model.view.deviceId:message?.targetDeviceId===model.view.deviceId;
  return <>
    {waiting&&<div role="status" className="unified-reconciliation">
      <p>{stopIntent?'停止尚未确认':'原轮次执行待核对'}{issue?.reason?'：'+issue.reason:'；保留原执行与真实占用'}</p>
      <button disabled={!own} title={own?'核对原执行，不重新运行':'请在原执行设备重新核对'}
        onClick={()=>perform(sharedRequest('execution.reconcile',task?{taskId:task.id}:{messageId}))}>重新核对</button>
    </div>}
    {!!task?.gitReconciliationReason&&<div role="status">
      <p>Git 退出尚未确认：{String(task.gitReconciliationReason)}</p>
      <button disabled={!own} onClick={()=>perform(sharedRequest('execution.reconcile',{taskId:task.id}))}>重新核对原 Git 交付</button>
    </div>}
    {item.turnOutcome==='completed'&&item.stopRequested&&<p>本轮正常结束；停止后尚未开始的补充与后续执行等待明确继续。</p>}
    {item.turnOutcome==='interrupted'&&<p>本轮已中断；部分文件保留执行电脑，仅同步已有输出和提交／PR信息，尚非完整交付。</p>}
    {!!item.deliveryError&&<p>交付待处理：{String(item.deliveryError)}</p>}
    {!!item.nativeRpcError&&<details>
      <summary>原生 RPC 诊断</summary>
      <pre>{JSON.stringify(item.nativeRpcError,null,2)}</pre>
    </details>}
  </>;
}
export function SharedInvitation({model}:{model:UnifiedModel}){
  const meeting=model.meeting;
  const configure=(participants:Array<{deviceId:string;agentId:string;executionCandidate?:boolean}>)=>perform(sharedCommand('meeting.update',{meetingId:meeting.id,expectedRevision:meeting.revision,members:Array.from(new Set(participants.filter(p=>p.executionCandidate!==false).map(p=>p.deviceId))),participants,autoApprovePlan:meeting.autoApprovePlan,autoAssign:meeting.autoAssign}));
  return <div className="unified-invitation"><p>邀请只建立参会身份；首次被 @ 才调用模型。本机执行默认未选入。</p>
    {[...(model.view.snapshot.entities.device??[])].sort((a,b)=>a.id.localeCompare(b.id)).map(device=><section key={device.id}><strong>{String(device.name)}{device.id===model.view.deviceId?'（本机）':''}</strong><p>{device.online?'在线':'离线，保留原成员与任务'} · {device.acceptingTasks?'接收已开放':'接收未开放'}</p>
      {((device.agents??[]) as Array<{agentId:string;available:boolean;executionModes:string[]}>).map(agent=>{const selected=model.members.some(m=>m.deviceId===device.id&&m.agentId===agent.agentId&&!m.nativeSessionId&&m.executionCandidate!==false);return <label key={agent.agentId}><input type="checkbox" checked={selected} disabled={!selected&&(!agent.available||!device.online)} onChange={e=>{const members=model.members.filter(m=>!m.nativeSessionId).map(m=>({deviceId:m.deviceId,agentId:m.agentId,executionCandidate:m.executionCandidate!==false}));const existing=members.some(m=>m.deviceId===device.id&&m.agentId===agent.agentId);configure(existing?members.map(m=>m.deviceId===device.id&&m.agentId===agent.agentId?{...m,executionCandidate:e.target.checked}:m):[...members,{deviceId:device.id,agentId:agent.agentId,executionCandidate:e.target.checked}]);}}/>{String(device.name)} · {agent.agentId} · {agent.available?'可交流；文件执行另核验项目授权':'尚未登录、授权或适配'}</label>;})}
    </section>)}
    <details><summary>明确选择已有 Codex 对话</summary>{(model.view.snapshot.entities.native??[]).map(n=><article key={n.id}><strong>{String(n.title)}</strong> · {String(model.view.snapshot.entities.device?.find(d=>d.id===n.deviceId)?.name)}<p>{String(n.status)} · {String(n.reason??'保留原目录、权限和上下文')}</p><button disabled={!!n.meetingId&&n.meetingId!==meeting.id} onClick={()=>perform(sharedCommand('native.bind',{meetingId:meeting.id,deviceId:n.deviceId,sessionId:n.sessionId,operation:n.meetingId===meeting.id?'unbind':'bind'}))}>{n.meetingId===meeting.id?'核对退出后移出':'选择此对话'}</button>{n.meetingId===meeting.id&&<><button disabled={!n.nativeTurnId} onClick={()=>perform(sharedCommand('native.stop',{meetingId:meeting.id,deviceId:n.deviceId,sessionId:n.sessionId,turnId:n.nativeTurnId}))}>停止此原生轮次</button><details><summary>选定历史与桌面新消息（仅在详情展示）</summary><NativeHistory deviceId={String(n.deviceId)} sessionId={String(n.sessionId)} recent={model.view.snapshot.entities.history??[]} request={sharedRequest}/></details></>}</article>)}</details>
    <button onClick={()=>void window.vibeMeet.settingsWindow.open({focus:'backends-unconfigured'})}>Agent 就绪与本机授权设置</button>
  </div>;
}
export {SharedParticipants} from './SharedCollaborationPanel';
export function SharedApprovals({model}:{model:UnifiedModel}){return <>{(model.view.snapshot.entities.approval??[]).filter(a=>a.meetingId===model.meeting.id||model.tasks.some(t=>t.id===a.taskId)).map(a=><article className="approval-card" key={a.id}><strong>工具审批 · {String(a.tool)}</strong><p>{String(model.view.snapshot.entities.device?.find(d=>d.id===model.tasks.find(t=>t.id===a.taskId)?.targetDeviceId)?.name??'执行设备')}</p><p>{String(a.description)}</p>{a.effectiveDecision||a.decision?<p>{a.effectiveDecision?'执行端已确认':'决定已保存，等待执行端确认'}：{String(a.effectiveDecision??a.decision)}</p>:a.supported?<><button onClick={()=>perform(sharedCommand('approval.decide',{approvalId:a.id,decision:'allow'}))}>允许这一次</button><button onClick={()=>perform(sharedCommand('approval.decide',{approvalId:a.id,decision:'deny'}))}>拒绝</button></>:<p>此原生交互请在执行设备 Codex 桌面处理</p>}</article>)}</>;}
export function SharedInterrupt({model,onClose}:{model:UnifiedModel;onClose:()=>void}){
  const [selected,setSelected]=useState('');const active=model.tasks.filter(t=>!t.exitConfirmed&&t.status!=='accepted');
  const stop=(id:string)=>{const task=model.tasks.find(t=>t.id===id);if(task)perform(sharedCommand('task.control',{taskId:task.id,attemptId:task.attemptId,operation:'stop'}));};
  return <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-label="选择中断范围" className="unified-dialog"><h2>停止哪些工作</h2><button onClick={()=>{perform(sharedCommand('meeting.request',{meetingId:model.meeting.id,operation:'stop-host'}));onClose();}}>只停止 Host 当前回复</button><label>指定任务<select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">选择任务</option>{active.map(t=><option key={t.id} value={t.id}>{String(t.title)}</option>)}</select></label><button disabled={!selected} onClick={()=>{stop(selected);onClose();}}>停止此任务</button><button onClick={()=>{if(window.confirm('停止本会议全部当前执行？退出确认前仍保留占用；其他会议与未选定桌面工作不受影响。')){perform(sharedCommand('meeting.request',{meetingId:model.meeting.id,operation:'stop-host'}));for(const task of active)stop(task.id);for(const m of model.view.snapshot.entities.message??[])if(m.meetingId===model.meeting.id&&(m.route==='native'||m.route==='agent')&&!m.replyTo&&!m.exitConfirmed)perform(sharedCommand('message.stop',{messageId:m.id}));onClose();}}}>停止本会议全部当前执行…</button><button onClick={onClose}>返回</button></section></div>;
}
