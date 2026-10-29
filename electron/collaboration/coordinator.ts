import {textSlice} from './text-slice.js';
import {rejectedHostPlan} from './host-plan-outcome.js';
import { mkdir } from 'node:fs/promises';
import { getBackendRegistry } from '../backends/registry.js';
import { getBackendAuth } from '../store.js';
import { GuardedCodexExecution } from './native-helper.js';
import type { SharedEntity, SharedSnapshot,HostInputStatus,HostInputFailure } from './production-types.js';
import {parseSharedCommand} from './production-validation.js';
import type { BackendSessionSnapshot } from '../backends/cli-backend.js';
export interface CoordinatorHooks {
  reply(text:string,inputId:string):Promise<void>;
  plan(tasks:Array<Record<string,unknown>>,inputId:string):Promise<void>;
  checkpoint(inputId:string,status:HostInputStatus,threadId?:string,failure?:HostInputFailure):Promise<void>;
  createdSession?(session:BackendSessionSnapshot,inputId:string):Promise<void>;
}
const INSTRUCTIONS = '你是共享会议唯一 Host。只做统筹，围绕完整交付拆分独立任务，包含必要测试和成果说明。纯对话直接回答。不要调用本机工具代替执行设备，不自动扩大授权。明确点名原生对话的消息不会发给你，不要重复派发。提出计划时输出 station-plan JSON 围栏，内容为任务数组。每项包含 meetingId,title,objective,targetDeviceId,agentId,resource(text/directory/repository/native),permission(read-only/workspace-write),dependencies数组,inputs数组；仓库任务还需projectId和准确baseCommit。只从会议members中选择具备可用Agent和授权的设备。一个任务含连续多文件修改、必要测试和交付说明，不把步骤拆成新任务。计划批准和自动分配独立控制。缺少准确基线或条件时说明所需准备，不猜值。同目标返工保持原任务，最终验收后追加才建关联后续任务。禁止最终合并PR，依赖任务须等会议集成和组合验证通过。';
export function normalizeHostPlan(meetingId:string,value:unknown):Array<Record<string,unknown>> {
  if(!Array.isArray(value))throw new Error('Host 计划必须是任务数组');
  const tasks=value.map(raw=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Host 任务格式无效');
    const task=structuredClone(raw) as Record<string,unknown>;if(task.meetingId&&task.meetingId!==meetingId)throw new Error('Host 计划引用了其他会议');task.meetingId=meetingId;
    const inputs=Array.isArray(task.inputs)?task.inputs:[];const inline=inputs.filter((i):i is string=>typeof i==='string');
    // Text is preserved as text, never converted into an unverified file path.
    if(inline.length)task.objective=String(task.objective??'')+'\n补充文字资料：\n'+inline.join('\n');
    task.inputs=inputs.filter(i=>typeof i!=='string');task.dependencies??=[];return task;
  });
  return parseSharedCommand({protocol:2,requestId:'host-plan-validation',action:'plan.propose',payload:{meetingId,tasks}}).payload.tasks as Array<Record<string,unknown>>;
}
/** Each Host turn has a durable owned guardian, with no device task slot. */
export class SharedCoordinator {
  private pending:Promise<void>=Promise.resolve();private execution?:GuardedCodexExecution;private closed=false;
  constructor(private meeting:SharedEntity,private snapshot:()=>SharedSnapshot,private folder:string,private hooks:CoordinatorHooks,private threadId?:string) {}
  input(message:SharedEntity):Promise<void> {
    const job=this.pending.then(async()=>{
      if(this.closed)throw new Error('Host 已停止，原输入保留等待明确继续');
      const backend=getBackendRegistry().get(String(this.meeting.hostAgentId??'codex'));
      const binary=backend?.resolveBinary();if(backend?.id!=='codex'||!binary)throw new Error('会议 Host 不可用，请在协调设备安装并登录 Codex');
      const context=JSON.stringify(this.snapshot());if(Buffer.byteLength(context,'utf8')>140000){await this.hooks.reply('会议上下文超过本轮处理限额，本轮没有派发任务。请在消息中引用本轮准确资料与目标，或在计划界面手动安排完整任务。完整记录仍保留。',message.id);await this.hooks.checkpoint(message.id,'completed',this.threadId);return;}
      await mkdir(this.folder,{recursive:true});await this.hooks.checkpoint(message.id,'starting',this.threadId);
      const configured=getBackendAuth('codex');const auth=configured??{authMode:'oauth' as const};this.execution=new GuardedCodexExecution(message.id,binary,backend.buildEnv(auth),configured?.model);
      let output='';
      try {
        const result=await this.execution.run({cwd:this.folder,permission:'read-only',threadId:this.threadId,
          objective:INSTRUCTIONS+'\ninputs 只放已经发布的 Git 文件引用对象 {repository:"https://github.com/owner/repo",commit:"40位准确提交号",paths:["仓库内相对路径"]}；纯文字要求全部写进 objective，纯文字任务用 permission=read-only，inputs=[]。没有文件就用空数组。dependencies 只引用已经存在的真实业务任务 ID；首轮独立任务用空数组。资料发布通知只更新上下文，尚未给出执行目标时不要派任务。\n当前共享会议快照（不授予本机目录权限）：\n'+context+'\n用户输入：\n'+String(message.text)}, {
          identity:async(thread)=>{
            if(!this.threadId)await this.hooks.createdSession?.({protocol:'codex-app-server',sessionId:thread},message.id);
            this.threadId=thread;await this.hooks.checkpoint(message.id,'starting',thread);
          },
          output:async(text)=>{output=textSlice(output+text,-64000);},approval:async()=> 'deny',
        });
        if(!result.exitConfirmed)throw new Error('Host 原执行退出未确认，请保留原输入等待核对');
        if(result.turnOutcome==='failed'||result.turnOutcome==='unknown')throw new Error(result.summary||'Host 原生轮次失败或结果未知，保留原输入核对');
        if(result.stopped){await this.hooks.reply('Host 本轮未完成，输入与原上下文保留。'+(result.summary?'\n执行结果：'+textSlice(result.summary,-12000):''),message.id);await this.hooks.checkpoint(message.id,'completed',this.threadId);return;}
        if(result.contentComplete!==true)throw new Error('Host 历史结果没有完整正文证据；保留原输入和对话，等待人工核对');
        await this.finish(message.id,result.summary||output);
      } catch(error) {
        if(!rejectedHostPlan(error))await this.hooks.checkpoint(message.id,'reconcile',this.threadId);
        throw error;
      }
      finally {this.execution=undefined;}
    });this.pending=job.catch(()=>{});return job;
  }
  async finish(inputId:string,output:string):Promise<void> {
    const match=output.match(/```station-plan\s*([\s\S]*?)```/);
    let visible=output.replace(/```station-plan[\s\S]*?```/g,'').trim();
    if(match){let tasks:Array<Record<string,unknown>>|undefined;
      try{tasks=normalizeHostPlan(this.meeting.id,JSON.parse(match[1]));}
      catch(error){visible+='\nHost 计划未通过格式或权限校验，本轮没有派发任务。请根据以下原提案修正；原输入和对话保留。\n'+String(error instanceof Error?error.message:error)+'\n'+textSlice(match[1],0,12000);}
      if(tasks){
        try{await this.hooks.plan(tasks,inputId);}
        catch(error){
          const failure=rejectedHostPlan(error);
          if(failure)await this.hooks.checkpoint(inputId,'failed',this.threadId,failure);
          throw error;
        }
      }
    }
    if(visible)await this.hooks.reply(textSlice(visible,-24000),inputId);
    await this.hooks.checkpoint(inputId,'completed',this.threadId);
  }
  async stop():Promise<boolean>{this.closed=true;return this.execution?this.execution.stop():true;}
  close():void {this.execution?.close();}
}
