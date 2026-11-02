import type { SharedEntity,SharedSnapshot } from './production-types.js';
/** Shared UI and model inputs must never inherit another native conversation's
 * selected history. Keep bounded, useful delivery evidence instead of empty
 * output/evidence placeholders. */
export function boundedMeetingContext(snapshot:SharedSnapshot,meetingId:string):SharedSnapshot {
  const rows=(kind:string)=>snapshot.entities[kind]??[];
  const meeting=rows('meeting').find(m=>m.id===meetingId);
  const members=(meeting?.participants??[]) as Array<{deviceId:string;agentId:string}>;
  const tasks=rows('task').filter(t=>t.meetingId===meetingId).slice(-32).map(t=>({
    id:t.id,revision:t.revision,
    ...Object.fromEntries(['id','revision','title','status','planTaskId','targetDeviceId','agentId','resource','projectId','baseCommit','dependencies','integration','integrationCommit','attemptId','exitConfirmed'].filter(k=>t[k]!==undefined).map(k=>[k,t[k]])),
    objective:String(t.objective??'').slice(0,800),delivery:t.delivery?deliverySummary(t.delivery as Record<string,unknown>):undefined,
  } as SharedEntity));
  const devices=rows('device').filter(d=>d.id===meeting?.coordinatorDeviceId||members.some(m=>m.deviceId===d.id)||(meeting?.members as string[]|undefined)?.includes(d.id));
  const hostMessages=rows('message').filter(m=>m.meetingId===meetingId&&m.route==='host');
  const selected=[...hostMessages.filter(m=>!m.replyTo).slice(-6),...hostMessages.filter(m=>m.replyTo&&m.sourceDeviceId===meeting?.coordinatorDeviceId).slice(-4)];
  const messages=selected.sort((a,b)=>Number(a.createdAt)-Number(b.createdAt)).map(m=>({...m,text:String(m.text).slice(0,1500),attachments:((m.attachments??[]) as unknown[]).filter(ref=>JSON.stringify(ref).length<4000).slice(0,4)}));
  const projectIds=new Set([meeting?.mainProjectId,...tasks.map(t=>t.projectId)]);
  const brief=meeting?.planBrief as {goal?:string;approach?:string;steps?:Array<{title:string;detail:string}>;risks?:string[];openQuestions?:string[]}|undefined;
  const plan=((meeting?.plan??[]) as Array<Record<string,unknown>>).slice(-16).map(t=>({...t,objective:String(t.objective).slice(0,800),inputs:[],acceptanceCriteria:undefined}));
  const summary=meeting?{...meeting,plan,planBrief:brief?{goal:brief.goal?.slice(0,2000),approach:brief.approach?.slice(0,3000),steps:brief.steps?.slice(0,8).map(s=>({title:s.title,detail:s.detail.slice(0,500)})),risks:brief.risks?.slice(0,5),openQuestions:brief.openQuestions?.slice(0,5)}:undefined}:undefined;
  const context:SharedSnapshot={protocol:2,cursor:snapshot.cursor,entities:{meeting:summary?[summary]:[],device:devices,project:rows('project').filter(p=>projectIds.has(p.id)),binding:rows('binding').filter(b=>projectIds.has(b.projectId)&&devices.some(d=>d.id===b.deviceId)),task:tasks,message:messages,history:[],native:[],approval:[]}};
  // Retain accurate references and explicitly omit older detail rather than
  // truncating commit/path strings into fictional executable references.
  while(Buffer.byteLength(JSON.stringify(context),'utf8')>100000&&context.entities.task.length>1)context.entities.task.shift();
  while(Buffer.byteLength(JSON.stringify(context),'utf8')>120000&&context.entities.message.length>1)context.entities.message.shift();
  return context;
}
function deliverySummary(delivery:Record<string,unknown>){
  const report=delivery.report as {taskId?:string;attemptId?:string;tests?:Array<{argv:string[];exitCode:number|null;output:string}>;unresolved?:string[]}|undefined;
  return {summary:String(delivery.summary??'').slice(0,1600),commit:delivery.commit,branch:delivery.branch,prUrl:delivery.prUrl,files:(delivery.files as string[]|undefined)?.slice(0,12),report:report?{taskId:report.taskId,attemptId:report.attemptId,tests:report.tests?.slice(0,8).map(t=>({argv:(t.argv??[]).slice(0,8),exitCode:t.exitCode,output:String(t.output??'').slice(-240)})),unresolved:report.unresolved?.slice(0,4)}:undefined};
}
export function participantIdentity(deviceId:string,agentId:string):string {return 'member-'+deviceId+'-'+agentId;}
export function approvedTargetAvailable(snapshot:SharedSnapshot,task:Record<string,unknown>):boolean {
  return (snapshot.entities.device??[]).some(d=>d.id===task.targetDeviceId&&d.online&&d.acceptingTasks&&!d.revoked&&(d.agents as Array<{agentId:string;available:boolean}>).some(a=>a.agentId===task.agentId&&a.available));
}
