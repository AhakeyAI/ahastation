import type {SharedEntity,SharedSnapshot} from './production-types.js';
import {verifiedDelivery} from './delivery-identity.js';
export interface BaseRevision {planTaskId:string;fromCommit:string;toCommit:string;reason:string}
export function plannedTaskExists(tasks:SharedEntity[],meetingId:string,plan:Record<string,unknown>):boolean{
  return tasks.some(t=>t.meetingId===meetingId&&(plan.planTaskId?t.planTaskId===plan.planTaskId:t.title===plan.title&&t.objective===plan.objective&&t.parentTaskId===plan.parentTaskId));
}
export function dependencyWait(snapshot:SharedSnapshot,meetingId:string,plan:Record<string,unknown>):string|undefined{
  const pending=[...(plan.dependencies??[]) as string[]],seen=new Set<string>();
  while(pending.length){
    const id=pending.pop()!;
    const task=snapshot.entities.task?.find(t=>t.meetingId===meetingId&&(t.id===id||t.planTaskId===id));
    if(!task)return '等待前序任务分发与成果核验';
    if(seen.has(task.id))continue;
    seen.add(task.id);
    if(task.stopRequested&&!(task.turnOutcome==='completed'&&task.exitConfirmed===true)||task.status==='stopped')return '前序任务已停止，等待明确继续并重新核验';
    if(!verifiedDelivery(task))return '等待全部前序当前成果通过本会议准确核验';
    pending.push(...(task.dependencies??[]) as string[]);
  }
}
/** Derived from durable plan + verified results. Reconnects do not create a
 * revision or change approved fields; only explicit plan.review changes them. */
export function pendingBaseRevisions(snapshot:SharedSnapshot,meeting:SharedEntity):BaseRevision[]{
  if(typeof meeting.verifiedCommit!=='string'||!/^[a-f0-9]{40}$/.test(meeting.verifiedCommit))return [];
  return ((meeting.plan??[]) as Array<Record<string,unknown>>).flatMap((task,index)=>
    task.resource==='repository'&&((task.dependencies??[]) as string[]).length>0&&task.baseCommit!==meeting.verifiedCommit
      &&!plannedTaskExists(snapshot.entities.task??[],meeting.id,task)&&!dependencyWait(snapshot,meeting.id,task)
      ?[{planTaskId:String(task.planTaskId??'planned-'+index),fromCommit:String(task.baseCommit),toCommit:String(meeting.verifiedCommit),reason:'全部前序成果已核验并推进会议提交；此任务尚未分发，须审阅准确新基线后批准修订。'}]:[]);
}
