import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexAppServerTransport } from '../backends/codex-app-server-transport.js';
import { mapCodexApprovalRequest, codexApprovalResponse } from '../backends/codex-adapter.js';
import type { CodexAppServerRequest } from '../backends/codex-app-server-transport.js';
import type {TurnOutcome} from './production-types.js';
export interface ExecutionRequest { objective: string; cwd: string; permission: 'read-only' | 'workspace-write'; threadId?: string; textOnly?:boolean;images?:string[] }
export interface ExecutionHooks {
  identity(threadId: string, turnId?: string): Promise<void>;
  output(text: string): Promise<void>;
  approval(id: string, tool: string, description: string, supported: boolean): Promise<'allow' | 'deny'>;
  approvalObserved?(id:string,decision:'allow'|'deny'):Promise<void>;
}
export interface ExecutionHandle {
  run(request: ExecutionRequest, hooks: ExecutionHooks): Promise<{summary: string; stopped: boolean; exitConfirmed: boolean;turnOutcome?:TurnOutcome}>;
  stop(): Promise<boolean>;
  close(): void;
}
/** Test adapter exercises the same persistent receiver, authorization and slots. */
export class FileTestExecution implements ExecutionHandle {
  private stopped=false; private done?: Promise<void>; private resolveDone?: () => void;
  async run(request: ExecutionRequest, hooks: ExecutionHooks) {
    this.done=new Promise(resolve => {this.resolveDone=resolve;});
    try {
      await hooks.identity('fixture-'+randomUUID(),'fixture-turn-'+randomUUID());
      await hooks.output('非模型适配器已开始完整交付');
      if (request.objective.includes('[approval]')) {
        const decision=await hooks.approval(randomUUID(),'fixture.write','写入两个验收文件',true);
        if (decision==='deny') return {summary:'操作被拒绝',stopped:true,exitConfirmed:true};
      }
      if (request.objective.includes('[wait]')) while(!this.stopped) await new Promise(resolve=>setTimeout(resolve,20));
      if (!this.stopped && request.permission==='workspace-write') {
        await mkdir(request.cwd,{recursive:true});
        await writeFile(join(request.cwd,'delivery.txt'),request.objective+'\n');
        await writeFile(join(request.cwd,'validation.txt'),'two-file fixture delivery verified\n');
      }
      return {summary:this.stopped?'执行已停止':'已完成非模型双文件交付',stopped:this.stopped,exitConfirmed:true};
    } finally { this.resolveDone?.(); }
  }
  async stop() { this.stopped=true; await this.done; return true; }
  close() { this.stopped=true; }
}

export class CodexExecution implements ExecutionHandle {
  private transport?: CodexAppServerTransport; private thread?: string; private turn?: string;
  private stopped=false;private stopRequested=false; private completion?: {resolve():void;reject(error:Error):void};
  private approvals=new Map<string,CodexAppServerRequest>();
  constructor(private binary: string, private env: NodeJS.ProcessEnv) {}
  async run(request: ExecutionRequest,hooks: ExecutionHooks) {
    let summary=''; let reported: Promise<unknown>=Promise.resolve();
    const completed=new Promise<void>((resolve,reject)=>{this.completion={resolve,reject};});
    // Observe the rejection immediately, including failures during startup.
    void completed.catch(()=>{});
    this.transport=new CodexAppServerTransport({binaryPath:this.binary,env:this.env,
      onExit:error=>this.completion?.reject(error),
      onNotification:message=>{
        const p=message.params as Record<string,unknown> | undefined;
        if (!p || (p.threadId && p.threadId!==this.thread)) return;
        if(message.method==='item/agentMessage/delta' && typeof p.delta==='string') {
          summary=(summary+p.delta).slice(-48000);
          reported=reported.then(()=>hooks.output(String(p.delta)));
        }
        if(message.method==='turn/completed') {
          const turn=p.turn as {id?:string;status?:string;error?:unknown};
          if(this.turn && turn.id!==this.turn) return;
          if(turn.status==='failed') this.completion?.reject(new Error('Codex 执行失败，保留原任务等待核对'));
          else {if(turn.status==='interrupted') this.stopped=true; this.completion?.resolve();}
        }
      },
      onRequest:async native=>{
        const mapped=mapCodexApprovalRequest(native); const id=randomUUID(); this.approvals.set(id,native);
        if(!mapped) {await hooks.approval(id,native.method,'此原生交互需在 Codex 桌面处理',false); throw new Error('不支持的原生交互');}
        const decision=await hooks.approval(id,mapped.toolName,JSON.stringify(mapped.input).slice(0,12000),true);
        this.approvals.delete(id); return codexApprovalResponse(native,decision);
      },
    });
    await this.transport.start();
    this.thread=request.threadId
      ? await this.transport.resumeThread(request.threadId,{cwd:request.cwd})
      : await this.transport.openThread({cwd:request.cwd,approvalPolicy:'untrusted',sandbox:request.permission});
    await hooks.identity(this.thread);
    if(this.stopRequested) return {summary:'启动前已停止',stopped:true,exitConfirmed:true};
    this.turn=await this.transport.startTurn(this.thread,[{type:'text',text:request.objective,text_elements:[]}]);
    await hooks.identity(this.thread,this.turn);
    await completed; await reported;
    const exitConfirmed=await this.verifyExit();
    return {summary,stopped:this.stopped,exitConfirmed};
  }
  private async verifyExit(): Promise<boolean> {
    if(!this.transport || !this.thread || !this.turn) return false;
    try {
      const page=await this.transport.call<{data:Array<{id:string;status:string;items:Array<Record<string,unknown>>}>}>(
        'thread/turns/list',{threadId:this.thread,limit:100,itemsView:'full',sortDirection:'desc'});
      const turn=page.data.find(t=>t.id===this.turn);
      if(!turn || !['completed','interrupted','failed'].includes(turn.status) || !Array.isArray(turn.items)) return false;
      if(turn.items.some(item=>item.status==='inProgress' || item.status==='running' || item.type==='collabAgentToolCall')) return false;
      const background=await this.transport.call<{data?:unknown[];terminals?:unknown[]}>(
        'thread/backgroundTerminals/list',{threadId:this.thread});
      const entries=background.data ?? background.terminals;
      return Array.isArray(entries) && entries.length===0;
    } catch { return false; }
  }
  async stop(): Promise<boolean> {
    this.stopRequested=true;
    if(!this.transport || !this.thread || !this.turn) return false;
    await this.transport.interruptTurn(this.thread,this.turn);
    for(let n=0;n<50;n++) {
      if(await this.verifyExit()) return true;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    return false;
  }
  close(): void {this.transport?.close();}
}
