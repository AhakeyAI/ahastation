import {deliveryHash} from '../electron/collaboration/delivery-identity';
import type {StationView,SharedEntity} from '../electron/collaboration/production-types';
/** UI-only fixture. Never linked by production entry points without Vite DEV. */
export function unifiedFixture(enabled:boolean){
  const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';const id='ui-unified-meeting';
  const task={meetingId:id,planTaskId:'whole-api',title:'登录接口与回归测试',objective:'连续完成接口修改、必要回归和修正，说明交付。',targetDeviceId:b,agentId:'codex',resource:'text',permission:'read-only',dependencies:[],inputs:[]};
  const meeting={id,revision:1,planVersion:1,planDecisionVersion:0,title:'界面交互夹具 · 无模型／无公网验收',hostAgentId:'codex',hostAuthority:'original-orchestrator',coordinatorDeviceId:a,members:[b],participants:[{deviceId:b,agentId:'codex'}],autoAssign:false,autoApprovePlan:false,planApproved:false,plan:[task],planBrief:{goal:'完成登录功能和必要回归',approach:'接口与回归属于一项完整交付，文档另行安排。',steps:[{title:'完成接口及回归',detail:'在同一任务内连续修改、测试和修正',taskId:'whole-api'}],risks:['示例不代表测试通过'],openQuestions:[]}};
  const agent={agentId:'codex',backendId:'codex',available:true,executionModes:['worker','native-session']};
  const view:StationView={connected:true,credentialReady:true,deviceId:a,config:{name:'电脑 A',platform:'windows',acceptingTasks:true,maxConcurrency:1,agents:[agent] as StationView['config']['agents']},allowedAgents:['codex'],bindings:[],directories:[],probes:[{agentId:'codex',installed:true,authenticated:true,executionModes:['worker'],guide:'界面示例'}],snapshot:{protocol:2,cursor:1,capabilities:['unified-meeting-v1','unified-review-fixes-v1','unified-stability-v1','unified-hardening-v1'],entities:{device:[{id:a,revision:1,name:'电脑 A',online:true,acceptingTasks:true,maxConcurrency:1,activeTasks:0,agents:[agent]},{id:b,revision:1,name:'电脑 B',online:true,acceptingTasks:true,maxConcurrency:1,activeTasks:1,agents:[agent]}],project:[{id:'fixture-materials',revision:1,name:'隔离资料仓库',repository:{provider:'github',canonicalUrl:'https://github.com/fixture/materials'}}],binding:[],meeting:enabled?[meeting]:[],message:[],task:[],approval:[],native:[],history:[],nativecontrol:[]}}};
  if(enabled)localStorage.setItem('station-meeting:'+a,id);
  const listeners=new Set<()=>void>();let seq=0;
  const requests=new Map<string,{digest:string;value:unknown}>();
  let lastTarget:HTMLOutputElement|undefined;
  if(enabled){
    const bar=document.createElement('aside');bar.setAttribute('aria-label','隔离界面夹具控制');bar.style.cssText='position:fixed;left:12px;bottom:86px;z-index:100001;background:#fff8dc;color:#222;padding:6px;border:1px solid #888;max-width:680px;font-size:12px';
    const notify=()=>{for(const cb of listeners)cb();};
    for(const [label,run] of [
      ['夹具：相同快照',()=>notify()],
      ['夹具：普通进度',()=>{view.snapshot.entities.device[1].activeTasks=2;notify();}],
      ['夹具：新计划',()=>{meeting.plan=meeting.plan.map(t=>({...t,objective:t.objective+'（新版交付要求）'}));meeting.planVersion++;meeting.revision++;notify();}],
      ['夹具：分发首项',()=>{meeting.planApproved=true;meeting.planDecisionVersion++;const t=meeting.plan[0];view.snapshot.entities.task.push({...t,id:'task-'+t.planTaskId,revision:1,status:'offered',attemptId:'fixture-attempt'});notify();}],
      ['夹具：第二会议',()=>{view.snapshot.entities.meeting.push({...structuredClone(meeting),id:'ui-second-meeting',title:'第二会议隔离夹具',plan:meeting.plan.map(t=>({...t,meetingId:'ui-second-meeting'}))});notify();}],
      ['夹具：设备改名',()=>{view.snapshot.entities.device[1].name='改名后的中文电脑 + 工作站';notify();}],
      ['夹具：切换离线',()=>{view.snapshot.entities.device[1].online=!view.snapshot.entities.device[1].online;notify();}],
      ['夹具：依赖基线',()=>{
        const first={...task,planTaskId:'first',title:'前序完整交付',resource:'repository',permission:'workspace-write',projectId:'fixture-project',baseCommit:'a'.repeat(40)};
        const second={...first,planTaskId:'second',title:'依赖前序的完整交付',dependencies:['first']};
        Object.assign(meeting,{plan:[first,second],planVersion:meeting.planVersion+1,planApproved:true,verifiedCommit:'b'.repeat(40)});
        view.snapshot.entities.project=[{id:'fixture-project',revision:1,name:'隔离示例仓库'}];
        const delivered:SharedEntity={...first,id:'task-first',revision:1,status:'delivered',attemptId:'fixture-attempt',
          integration:'verified',exitConfirmed:true,turnOutcome:'completed',pendingFollowups:[],
          delivery:{scopeVersion:0,summary:'界面夹具生成的成果报告；无真实模型或 Git 操作',report:{
            taskId:'task-first',attemptId:'fixture-attempt',exitConfirmed:true,tests:[],
          }},
        };
        delivered.verificationBinding={attemptId:delivered.attemptId,reviewed:true,deliveryHash:deliveryHash(delivered)};
        view.snapshot.entities.task=[delivered];
        notify();
      }],
      ['夹具：切换 B 视角',()=>{view.deviceId=b;localStorage.setItem('station-meeting:'+b,id);notify();}],
    ] as Array<[string,()=>void]>){const button=document.createElement('button');button.textContent=label;button.onclick=run;bar.append(button);}
    lastTarget=document.createElement('output');lastTarget.setAttribute('aria-label','夹具最后发送目标');bar.append(lastTarget);document.body.append(bar);
  }
  return {onChanged:(cb:()=>void)=>{listeners.add(cb);return()=>{listeners.delete(cb);};},request:async(action:string,p:Record<string,unknown>={})=>{
    if(action==='status')return {ok:true,value:structuredClone(view)};
    if(action==='files.stage')return {ok:true,value:{repository:'https://github.com/fixture/materials',commit:'c'.repeat(40),paths:(p.files as Array<{name:string}>).map(f=>f.name)}};
    if(action==='github.status')return {ok:true,value:{message:'界面夹具，不检测真实登录'}};
    if(action==='command'){
      const identity=String(p.requestId??'fixture-'+(++seq));const digest=JSON.stringify(p);const previous=requests.get(identity);if(previous)return previous.digest===digest?{ok:true,value:structuredClone(previous.value)}:{ok:false,error:'提交身份内容不符'};
      const value=p.payload as Record<string,unknown>;
      if(lastTarget)lastTarget.textContent=JSON.stringify({action:p.action,targetDeviceId:value.targetDeviceId,targetAgentId:value.targetAgentId,nativeSessionId:value.nativeSessionId,baseCommits:Array.isArray(value.tasks)?value.tasks.map(t=>(t as Record<string,unknown>).baseCommit):undefined});
      let result:unknown=meeting;
      if(p.action==='message.send'){const message={id:'message-'+(++seq),submissionId:identity,revision:1,...value,sourceDeviceId:a,createdAt:Date.now(),route:value.taskId?'task':value.nativeSessionId?'native':value.targetAgentId?'agent':'host'} as SharedEntity;view.snapshot.entities.message.push(message);result=message;}
      if(p.action==='plan.review'&&value.expectedPlanVersion!==meeting.planVersion)return {ok:false,error:'Plan changed'};
      if(p.action==='plan.review'){meeting.planVersion++;meeting.planDecisionVersion++;meeting.plan=value.tasks as typeof meeting.plan;meeting.planApproved=true;if(value.brief)meeting.planBrief=value.brief as typeof meeting.planBrief;meeting.revision++;for(const task of meeting.plan)if(!view.snapshot.entities.task.some(t=>t.planTaskId===task.planTaskId))view.snapshot.entities.task.push({...task,id:'task-'+task.planTaskId,revision:1,attemptId:'attempt-ui',status:'offered'});}
      if(p.action==='meeting.update'){Object.assign(meeting,value);meeting.revision++;}
      requests.set(identity,{digest,value:structuredClone(result)});for(const cb of listeners)cb();return {ok:true,value:structuredClone(result)};
    }
    return {ok:true,value:{}};
  }};
}
