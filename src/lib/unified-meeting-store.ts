import {verifiedDelivery} from '../../electron/collaboration/delivery-identity';
import { useSyncExternalStore } from 'react';
import type { SharedEntity,StationView } from '../../electron/collaboration/production-types';
import type { BackendInfo,MeetingPlanBrief,PlanMeetingTaskInput,TranscriptEntry } from '../types';
import {resolveSharedMention,type SharedMention} from './shared-mentions';
import {plannedTaskExists} from '../../electron/collaboration/plan-revision';

export type UnifiedModel={view:StationView;meeting:SharedEntity;tasks:SharedEntity[];members:UnifiedMember[]};
export type UnifiedMember={id:string;deviceId:string;agentId:string;label:string;online:boolean;executionCandidate?:boolean;nativeSessionId?:string;tasks:SharedEntity[]};
type State={view?:StationView;activeId:string|null;error?:string};
let state:State={activeId:null};const listeners=new Set<()=>void>();let generation=0;let unsubscribe:(()=>void)|undefined;
function emit(){for(const listener of listeners)listener();}
export async function refreshShared(){
  const ticket=++generation;
  try{const reply=await window.vibeMeet.collaboration.request('status');if(ticket!==generation)return;if(!reply.ok)throw new Error(reply.error);
    const view=reply.value as StationView;let activeId=state.activeId;
    if(view.enabled===false)activeId=null;
    if(state.view?.deviceId!==view.deviceId){try{activeId=localStorage.getItem('station-meeting:'+view.deviceId);}catch{activeId=null;}}
    if(activeId&&!view.snapshot.entities.meeting?.some(m=>m.id===activeId))activeId=null;
    state={view,activeId};emit();
  }catch(error){if(ticket===generation){state={...state,error:String(error)};emit();}}
}
function subscribe(listener:()=>void){
  listeners.add(listener);
  if(!unsubscribe&&typeof window.vibeMeet.collaboration?.onChanged==='function'){
    let active=true;
    const stop=window.vibeMeet.collaboration.onChanged(()=>{if(active)void refreshShared();});
    unsubscribe=()=>{active=false;stop();};
    void refreshShared();
  }
  return()=>{
    listeners.delete(listener);
    if(!listeners.size){
      unsubscribe?.();
      unsubscribe=undefined;
      // An in-flight reply belongs to the previous mounted consumers.
      ++generation;
    }
  };
}
export function useUnifiedMeeting(){return useSyncExternalStore(subscribe,()=>state);}
export function selectSharedMeeting(id:string|null){state={...state,activeId:id};try{if(state.view)localStorage.setItem('station-meeting:'+state.view.deviceId,id??'');}catch{}emit();}
export async function sharedRequest(action:string,payload:Record<string,unknown>={}) {
  const reply=await window.vibeMeet.collaboration.request(action,payload);if(!reply.ok){void refreshShared();throw new Error(reply.error);}
  await refreshShared();return reply.value;
}
export const sharedCommand=(action:string,payload:Record<string,unknown>,requestId?:string)=>sharedRequest('command',{action,payload,...(requestId?{requestId}:{})});
export function projectShared(view:StationView,meetingId:string):UnifiedModel|undefined {
  const meeting=view.snapshot.entities.meeting?.find(m=>m.id===meetingId);if(!meeting)return;
  const tasks=(view.snapshot.entities.task??[]).filter(t=>t.meetingId===meetingId);
  const device=(id:unknown)=>view.snapshot.entities.device?.find(d=>d.id===id);
  const participants=(meeting.participants??(meeting.members as string[]).map(deviceId=>({deviceId,agentId:'codex'}))) as Array<{deviceId:string;agentId:string;executionCandidate?:boolean}>;
  const members:UnifiedMember[]=Array.from(new Map(participants.map(p=>{const id='member-'+p.deviceId+'-'+p.agentId;return [id,{id,...p,label:String(device(p.deviceId)?.name??'离线设备')+((view.snapshot.entities.device??[]).filter(d=>d.name===device(p.deviceId)?.name).length>1?'（'+p.deviceId.slice(-4)+'）':'')+' · '+p.agentId,online:device(p.deviceId)?.online===true&&!device(p.deviceId)?.revoked,tasks:tasks.filter(t=>t.targetDeviceId===p.deviceId&&t.agentId===p.agentId&&!t.nativeSessionId)}];})).values());
  for(const n of view.snapshot.entities.native??[])if(n.meetingId===meetingId)members.push({id:'native-'+n.deviceId+'-'+n.sessionId,deviceId:String(n.deviceId),agentId:'codex',label:String(device(n.deviceId)?.name??'离线设备')+' · '+String(n.title)+'（远程接续）',nativeSessionId:String(n.sessionId),online:device(n.deviceId)?.online===true&&!device(n.deviceId)?.revoked&&n.status!=='unavailable',tasks:tasks.filter(t=>t.nativeSessionId===n.sessionId&&t.targetDeviceId===n.deviceId)});
  return {view,meeting,tasks,members};
}
export function sharedTranscript(model:UnifiedModel):TranscriptEntry[]{
  return (model.view.snapshot.entities.message??[]).filter(m=>m.meetingId===model.meeting.id).sort((a,b)=>Number(a.createdAt)-Number(b.createdAt)).flatMap(m=>{
    const member=model.members.find(p=>p.deviceId===m.targetDeviceId&&(m.nativeSessionId?p.nativeSessionId===m.nativeSessionId:p.agentId===m.targetAgentId));
    const label=m.replyTo?(member?.label??'Host'):String(model.view.snapshot.entities.device?.find(d=>d.id===m.sourceDeviceId)?.name??'参会者');
    const base={id:m.id,role:m.replyTo||m.route==='notice'?'assistant':'user',text:model.members.reduce((text,member)=>text.replaceAll('@'+member.id,'@'+member.label),String(m.text)),ts:Number(m.createdAt??0),source:label} as TranscriptEntry;
    return [base,...(m.output?[{...base,id:m.id+':output',role:'assistant' as const,text:String(m.output),source:member?.label??'状态'}]:[])];
  });
}
export function sharedMentionBackends(model:UnifiedModel,backends:BackendInfo[]):BackendInfo[]{return model.members.map(m=>({...backends.find(b=>b.id===m.agentId),id:m.id,displayName:m.label,sharedStatus:m.label+" · "+(m.online?"设备在线；就绪与执行资格以远端授权为准":"设备离线，保留身份"),available:m.online,loggedIn:true} as BackendInfo));}
export function sharedMessagePayload(model:UnifiedModel,text:string,taskId?:string,attachments:unknown[]=[],mentions:SharedMention[]=[]){
  if(state.view&&((model.view.accountKey&&state.view.accountKey!==model.view.accountKey)||state.view.deviceId!==model.view.deviceId))throw new Error('协作账号或设备已切换，原输入保留，请回到原会议核对');
  const current=projectShared(state.view??model.view,model.meeting.id);if(!current)throw new Error('会议已切换或不可用');
  const target=resolveSharedMention(text,mentions,current.members);if(taskId&&target)throw new Error('请选择任务补充或成员点名中的一个入口');
  return {meetingId:model.meeting.id,text,attachments,...(taskId?{taskId}:target?{targetDeviceId:target.deviceId,...(target.nativeSessionId?{nativeSessionId:target.nativeSessionId}:{targetAgentId:target.agentId})}:{})};
}
export async function sendShared(model:UnifiedModel,text:string,taskId?:string,attachments:unknown[]=[],mentions:SharedMention[]=[],submissionId?:string){
  const payload=sharedMessagePayload(model,text,taskId,attachments,mentions);
  const id=submissionId??globalThis.crypto?.randomUUID?.()??'submit-'+Date.now()+'-'+Math.random().toString(36).slice(2);
  const result=await sharedCommand('message.send',payload,id) as {pending?:boolean};
  if(result?.pending)throw Object.assign(new Error('发送结果待核对；原提交已保存在本机，恢复连接后补投同一次提交。'),{pending:true,submissionId:id});
}
export function sharedPlanTasks(model:UnifiedModel):PlanMeetingTaskInput[]{
  return ((model.meeting.plan??[]) as Array<Record<string,unknown>>).map((task,index)=>({
    id:String(task.planTaskId??'planned-'+index),title:String(task.title),prompt:String(task.objective),
    deps:task.dependencies as string[],executorBackendId:String(task.agentId),
    acceptanceCriteria:task.acceptanceCriteria as PlanMeetingTaskInput['acceptanceCriteria'],
    sharedTarget:{deviceId:String(task.targetDeviceId),agentId:String(task.agentId),resource:task.resource as 'text',permission:task.permission as 'read-only',
      ...(task.projectId?{projectId:String(task.projectId)}:{}),...(task.baseCommit?{baseCommit:String(task.baseCommit)}:{}),
      ...(task.nativeSessionId?{nativeSessionId:String(task.nativeSessionId)}:{})},
  }));
}
export async function approveSharedPlan(model:UnifiedModel,tasks:PlanMeetingTaskInput[],brief?:MeetingPlanBrief,basis:SharedEntity=model.meeting){
  if(basis.id!==model.meeting.id)throw new Error('计划审阅依据属于另一会议');
  const before=(basis.plan??[]) as Array<Record<string,unknown>>;
  const mapped=tasks.map(t=>{const original=before.find((p,i)=>(p.planTaskId??'planned-'+i)===t.id)??{};const {deviceId,agentId,...target}=t.sharedTarget!;
    const defaultCriteria=[{id:'manual-acceptance',description:'人工检查交付内容并确认满足任务目标',verification:{kind:'manual'}}];
    const unchanged=t.title===original.title&&t.prompt===original.objective&&deviceId===original.targetDeviceId&&agentId===original.agentId&&JSON.stringify(t.deps)===JSON.stringify(original.dependencies)&&['resource','permission','projectId','baseCommit','nativeSessionId'].every(k=>target[k as keyof typeof target]===original[k])&&JSON.stringify(t.acceptanceCriteria??[])===JSON.stringify(original.acceptanceCriteria??defaultCriteria);
    if(plannedTaskExists(model.tasks,model.meeting.id,original)&&unchanged)return original;
    return {...original,meetingId:basis.id,...(Object.keys(original).length?{}:{planTaskId:t.id}),inputs:original.inputs??[],title:t.title,objective:t.prompt,dependencies:t.deps,targetDeviceId:deviceId,agentId,...target,...(t.acceptanceCriteria?{acceptanceCriteria:t.acceptanceCriteria}:{})};});
  await sharedCommand('plan.review',{meetingId:basis.id,expectedPlanVersion:Number(basis.planVersion??0),tasks:mapped,approved:true,...(brief?{brief}:{})});return {ok:true};
}
export function sharedPhase(task:SharedEntity):string{
  if(task.status==='accepted')return '最终已验收';if(verifiedDelivery(task))return '检查通过，待最终验收';
  const names:Record<string,string>={offered:'已发出，待设备接收',received:'设备已接收', 'waiting-slot':'等待原设备名额','waiting-desktop':'等待桌面轮次结束',running:'执行中',approval:'等待工具审批','stop-unconfirmed':'停止尚未确认',reconcile:'等待核对真实执行',stopped:'已停止，等待明确继续',executed:'已退出，整理成果','delivery-pending':'等待上传成果',delivered:'成果可获取，待检查'};
  const phase=task.stopRequested&&!task.exitConfirmed?'停止尚未确认':names[String(task.status)]??String(task.status);
  return task.turnOutcome==='completed'&&task.stopRequested?phase+' · 本轮正常结束，后续等待明确继续':task.turnOutcome==='interrupted'?phase+' · 本轮中断，部分成果仅保留本机':phase;
}
