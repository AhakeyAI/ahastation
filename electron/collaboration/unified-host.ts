import {canonicalJson} from './delivery-identity.js';
import {rejectedHostPlan} from './host-plan-outcome.js';
import {textSlice} from './text-slice.js';
import { mkdir } from 'node:fs/promises';
import { Orchestrator } from '../orchestrator.js';
import { extractText } from '../orchestrator-helpers.js';
import type { BackendSessionSnapshot } from '../backends/cli-backend.js';
import type { MeetingPlanBrief, PlanMeetingTaskInput } from '../meeting-tools.js';
import type { OrchestratorEvent } from '../orchestrator-types.js';
import type { SharedEntity, SharedSnapshot } from './production-types.js';
import { normalizeHostPlan, type CoordinatorHooks } from './coordinator.js';
import {getBackendRegistry} from '../backends/registry.js';
import {getBackendAuth} from '../store.js';
import {GuardedCodexExecution} from './native-helper.js';
import {PORTABLE_MEETING_COMMAND_PROMPT} from '../orchestrator-prompts.js';
import type {SessionFactory} from '../worker-scheduler.js';
import type {SDKMessage} from '../claude-cli/types.js';
import type {MeetingInput} from './meeting-input.js';
class InvalidHostCommand extends Error {}

export interface UnifiedHostHooks extends CoordinatorHooks {
  plan(tasks:Array<Record<string,unknown>>,inputId:string,brief?:MeetingPlanBrief):Promise<void>;
  session(value:BackendSessionSnapshot):Promise<void>;
  consult(memberId:string,text:string,inputId?:string):Promise<unknown>;
  control(taskId:string,operation:string,text?:string,inputId?:string):Promise<unknown>;
  prepareInput?(message:SharedEntity,folder:string):Promise<MeetingInput>;
}
/** Original HostGroup, portable meeting-command/MCP and plan semantics. Local
 * WorkerScheduler is never populated: approved tasks have one Hub dispatcher. */
export class UnifiedMeetingHost {
  private orch?:Orchestrator;
  private queue:Promise<void>=Promise.resolve();
  private current?:{id:string;output:string;invoked:boolean;executionEnded?:boolean;resolve():void;reject(error:Error):void};
  private starting?:Promise<void>;
  private planWrites:Promise<unknown>=Promise.resolve();
  private cancelled=new Set<string>();
  private appliedPlans=new Set<string>();
  private rejectedPlans=new Map<string,Error>();
  private execution?:GuardedCodexExecution;
  private images:string[]=[];
  constructor(private meeting:SharedEntity,private snapshot:()=>SharedSnapshot,private folder:string,private hooks:UnifiedHostHooks,private resume?:BackendSessionSnapshot){}
  private async start() {
    if(this.orch)return;
    await mkdir(this.folder,{recursive:true});
    this.orch=new Orchestrator({cwd:this.folder,meetingId:'shared-'+this.meeting.id,defaultBackendId:String(this.meeting.hostAgentId??'codex'),
      ...(this.meeting.hostAgentId==='codex'?{sessionFactory:this.guardedFactory()}:{}),
      resumeBackendSessions:this.resume?{default:this.resume}:{},emit:e=>this.event(e),
      sharedExecution:{propose:async(tasks,brief)=>{
        const input=this.current;if(!input)throw new Error('No active shared Host input');
        if(this.cancelled.has(input.id))throw new Error('Host 回复已停止，本轮不再提交计划');
        const mapped=this.mapPlan(tasks);
        const write=this.planWrites.then(()=>this.hooks.plan(mapped,input.id,brief));
        this.planWrites=write.catch(()=>{});
        try{
          await write;
          this.rejectedPlans.delete(input.id);
          this.appliedPlans.add(input.id);
        }catch(error){
          this.rejectedPlans.set(input.id,error instanceof Error?error:new Error(String(error)));
          throw error;
        }
      },consult:(id,text)=>this.hooks.consult(id,text,this.current?.id),control:(id,op,text)=>this.hooks.control(id,op,text,this.current?.id)},
    });
    try{await this.orch.start();}catch(error){this.orch.end();this.orch=undefined;throw error;}
  }
  /** Transport only: parsing, authorization and planning still go through the
   * original Orchestrator. Guardian identity equals the durable input identity. */
  private guardedFactory():SessionFactory {
    return options=>({start:async()=>{},end:()=>{},resolvePermission:()=>{},
      snapshot:()=>this.resume??null,
      interrupt:async()=>{if(this.execution&&!await this.execution.stop())throw new Error('Host 真实退出待核对');},
      sendUserContent:()=>{throw new Error('共享 Host 的资料通过准确引用提供');},
      sendUserText:text=>{
        const current=this.current;if(!current)throw new Error('Host 输入身份缺失');
        const backend=getBackendRegistry().get('codex');const binary=backend?.resolveBinary();if(!binary||!backend)throw new Error('Codex Host 未就绪');
        const auth=getBackendAuth('codex')??{authMode:'oauth' as const};this.execution=new GuardedCodexExecution(current.id,binary,backend.buildEnv(auth),getBackendAuth('codex')?.model);
        void (async()=>{
          try{
            const system=options.sessionOptions?.systemPrompt;const prompt=typeof system==='string'?system:'';
            const sharedSchema='\npropose-plan是完整计划替换，不是只追加任务：必须保留快照plan中已分发条目的准确planTaskId和不变字段。遗漏时按具体语义错误修订完整提案，不自行删除或改派旧任务。共享计划仍使用原 meeting-command 契约。任务根级字段是 id、title、prompt、deps、sharedTarget、acceptanceCriteria（可选）。依赖只写 deps，资料只写 sharedTarget.inputs，不要在任务根级写 dependencies 或 inputs。acceptanceCriteria 若提供，必须是对象数组 [{"id":"content","description":"检查完整内容","verification":{"kind":"manual"}}]，不能使用字符串数组；命令核验用 verification={"kind":"command","argv":["node","test.mjs"]}。例：{"kind":"propose-plan","goal":"完整交付","approach":"按独立成果安排","tasks":[{"id":"whole","title":"完整成果","prompt":"连续完成必要工作与核验","deps":[],"sharedTarget":{"deviceId":"从快照选择","agentId":"codex","resource":"text","permission":"read-only","inputs":[]}}]}。';
            // A durable intent must precede handing work to the guardian. A lost
            // checkpoint never launches a model; an uncertain launch is inspected.
            if(this.cancelled.has(current.id))throw new Error('Host 本轮已在启动前停止');
            await this.hooks.checkpoint(current.id,'starting');
            if(this.cancelled.has(current.id))throw new Error('Host 本轮已在启动前停止');current.invoked=true;
            const result=await this.execution!.run({cwd:this.folder,permission:'read-only',textOnly:true,images:this.images,threadId:this.resume?.sessionId,objective:prompt+PORTABLE_MEETING_COMMAND_PROMPT+sharedSchema+'\n'+text},{
              identity:async thread=>{this.resume={protocol:'codex-app-server',sessionId:thread};await this.hooks.session(this.resume);},output:async()=>{},approval:async()=> 'deny',
            });
            if(!result.exitConfirmed)throw new Error('Host 守护进程实际退出未确认');
            current.executionEnded=true;
            if(result.turnOutcome==='failed'||result.turnOutcome==='unknown')throw new Error(result.summary||'Host 原生轮次失败或结果未知，保留原输入核对');
            if(result.stopped&&!this.cancelled.has(current.id))throw new Error(result.summary||'Host 本轮失败，输入保留');
            if(!result.stopped&&result.contentComplete!==true)throw new Error('Host 历史结果没有完整正文证据；保留原输入和对话，等待人工核对');
            if(!this.cancelled.has(current.id))await this.dispatchCommands(result.summary);
            const visible=result.summary.replace(/```meeting-command[\s\S]*?```/g,'').trim()||(this.current&&this.appliedPlans.has(this.current.id)?'计划已提交审阅。':'');
            if(visible)options.emit({kind:'message',message:{type:'assistant',message:{role:'assistant',content:[{type:'text',text:visible}]}} as SDKMessage});
            options.emit({kind:'turn-status',status:'completed'});
          }catch(error){
            if(error instanceof InvalidHostCommand){options.emit({kind:'message',message:{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'本轮有指令未通过原会议校验，失败指令未执行：'+error.message+'。请让 Host 按提示修订；当前输入和原模型线程已保留。'}]}} as SDKMessage});options.emit({kind:'turn-status',status:'completed'});}
            else options.emit({kind:'error',error:error instanceof Error?error.message:String(error)});
          }
          finally{this.execution=undefined;}
        })();
      },
    });
  }
  private async dispatchCommands(output:string){
    const blocks=[...output.matchAll(/```meeting-command\s*([\s\S]*?)```/g)];
    const proposals=blocks.map(m=>{try{return JSON.parse(m[1]);}catch{throw new InvalidHostCommand('meeting-command JSON 无效');}}).filter(c=>c.kind==='propose-plan');
    if(new Set(proposals.map(c=>canonicalJson(c))).size>1)throw new InvalidHostCommand('同一输入包含多份不同完整计划，全部未提交；请汇总并保留已分发任务后重提');
    const seen=new Set<string>();
    for(const match of blocks){
      let raw:unknown;try{raw=JSON.parse(match[1]);}catch{throw new InvalidHostCommand('meeting-command JSON 无效');}
      const identity=canonicalJson(raw);if(seen.has(identity))continue;seen.add(identity);
      const result=await this.orch!.executeMeetingCommand('default',raw);
      if(!result.ok)throw result.code==='invalid-command'||result.code==='forbidden'?new InvalidHostCommand(result.error):new Error(result.error);
    }
  }
  async finish(inputId:string,output:string):Promise<void>{
    await (this.starting??=this.start());
    this.current={id:inputId,output:'',invoked:true,executionEnded:true,resolve:()=>{},reject:()=>{}};
    try{
      try{await this.dispatchCommands(output);}
      catch(error){
        if(!(error instanceof InvalidHostCommand))throw error;
        output='原 Host 的本轮指令未通过格式校验，失败指令未执行：'+error.message+'。请补充修订要求，原输入和模型线程已保留。';
      }
      await this.planWrites;
      const visible=output.replace(/```meeting-command[\s\S]*?```/g,'').trim()
        ||(this.appliedPlans.has(inputId)?'计划已提交审阅。':'');
      if(visible)await this.hooks.reply(visible,inputId);
      await this.hooks.checkpoint(inputId,'completed');
    }catch(error){
      const failure=rejectedHostPlan(this.rejectedPlans.get(inputId)??error);
      if(failure)await this.hooks.checkpoint(inputId,'failed',undefined,failure);
      throw error;
    }
    finally{
      if(this.current?.id===inputId)this.current=undefined;
      this.rejectedPlans.delete(inputId);
      this.appliedPlans.delete(inputId);
    }
  }
  private mapPlan(tasks:PlanMeetingTaskInput[]) {
    const members=this.snapshot().entities.meeting?.find(m=>m.id===this.meeting.id)?.participants as Array<{deviceId:string;agentId:string}>|undefined;
    return normalizeHostPlan(this.meeting.id,tasks.map(task=>{
      if(!task.sharedTarget)throw new Error('每项计划必须明确 sharedTarget.deviceId 与 agentId；请修订后审阅');
      const {deviceId,agentId,...target}=task.sharedTarget;
      if(members&&!members.some(m=>m.deviceId===deviceId&&m.agentId===agentId))throw new Error('目标尚未被选为执行候选');
      return {meetingId:this.meeting.id,planTaskId:task.id,title:task.title,objective:task.prompt,targetDeviceId:deviceId,agentId,...target,
        dependencies:task.deps??[],inputs:task.sharedTarget.inputs??[],...(task.acceptanceCriteria?{acceptanceCriteria:task.acceptanceCriteria}:{})};
    }));
  }
  private event(e:OrchestratorEvent) {
    const input=this.current;if(!input||e.source!=='talker')return;
    if(e.event.kind==='message'){
      const message=e.event.message as {type?:string};
      if(message.type==='assistant')input.output=textSlice(input.output+'\n'+extractText(e.event.message),-24000);
      if(message.type==='result'){if(this.meeting.hostAgentId!=='codex')input.executionEnded=true;input.resolve();}
    } else if(e.event.kind==='turn-status'&&e.event.status==='completed'){if(this.meeting.hostAgentId!=='codex')input.executionEnded=true;input.resolve();}
    else if(e.event.kind==='error'||e.event.kind==='auth-required')input.reject(new Error(e.event.error));
    else if(e.event.kind==='ended')input.reject(new Error('Host 连接已结束；保留输入等待核对'));
  }
  input(message:SharedEntity):Promise<void>{
    const job=this.queue.then(async()=>{
      try{
        let resolve!:()=>void,reject!:(error:Error)=>void;
        const done=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});void done.catch(()=>{});
        const input={id:message.id,output:'',invoked:false,resolve,reject};this.current=input;
        await this.hooks.checkpoint(message.id,'preparing');
        await (this.starting??=this.start().catch(error=>{this.starting=undefined;throw error;}));
        const context=JSON.stringify(this.snapshot());
        const prepared=await this.hooks.prepareInput?.(message,this.folder);this.images=prepared?.images??[];
        if(this.images.length&&this.meeting.hostAgentId!=='codex')throw new Error('本轮共享图片输入需要 Codex Host；其他 Host 的本机图片能力仍可在原本机会议使用');
        if(this.cancelled.has(message.id))throw new Error('Host 本轮已在启动前停止');
        if(this.meeting.hostAgentId!=='codex'){await this.hooks.checkpoint(message.id,'starting');if(this.cancelled.has(message.id))throw new Error('Host 本轮已在启动前停止');input.invoked=true;}
        this.orch!.sendUserText('这是同一共享会议的当前状态。你是原会议唯一 Host；保留澄清、完整交付计划、独立批准、依赖、咨询与交付检查。不要在本机执行用户项目，不自动批准计划，不按电脑/文件/步骤拆任务。所有任务通过 propose-plan / plan_meeting，逐项填写 sharedTarget={deviceId,agentId,resource,permission,projectId?,baseCommit?,nativeSessionId?}；以快照的真实候选与授权为准。目标不可用须等待或提出可见修订。不要输出 station-plan。讨论直接答复，普通邀请不触发模型。\n'+context+'\n本次用户输入：\n'+(prepared?.text??String(message.text)));
        await done;
        await this.planWrites;
        if(this.rejectedPlans.has(message.id))throw this.rejectedPlans.get(message.id)!;
        const session=this.orch!.hostSessionSnapshot();if(session)await this.hooks.session(session);
        const visible=textSlice(input.output.replace(/```meeting-command[\s\S]*?```/g,'').trim(),-24000)||(this.current&&this.appliedPlans.has(this.current.id)?'计划已提交审阅。':'');if(visible)await this.hooks.reply(visible,message.id);
        await this.hooks.checkpoint(message.id,'completed');
      }catch(error){
        const invoked=this.current?.invoked===true;
        const failure=rejectedHostPlan(this.rejectedPlans.get(message.id)??error);
        const settled=this.current?.executionEnded===true&&failure;
        await this.hooks.checkpoint(message.id,settled||!invoked?'failed':'reconcile',undefined,
          failure??{message:error instanceof Error?error.message:String(error),notStarted:!invoked});
        throw error;
      }
      finally{
        if(this.current?.id===message.id)this.current=undefined;
        this.rejectedPlans.delete(message.id);
        this.appliedPlans.delete(message.id);
      }
    });this.queue=job.catch(()=>{});return job;
  }
  async stop():Promise<boolean>{
    const current=this.current;if(current){this.cancelled.add(current.id);if(!current.invoked){await this.hooks.checkpoint(current.id,'failed',undefined,{message:'Host 本轮已在启动前停止，未创建执行。原输入保留。',notStarted:true});current.resolve();return true;}}
    await this.orch?.interruptHostReply();current?.resolve();return true;
  }
  close(){this.orch?.end();this.orch=undefined;}
}
