import { app } from 'electron';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionHandle, ExecutionHooks, ExecutionRequest } from './execution.js';
import type { DirectoryGrant,TurnOutcome } from './production-types.js';
interface HelperMessage {type:string;value?:Record<string,unknown>;message?:string;threadId?:string;turnId?:string;status?:string;executionId?:string;text?:string;id?:string;tool?:string;description?:string;supported?:boolean;generation?:string;decision?:'allow'|'deny'}
export function nativeHelper(request: Record<string,unknown>,onMessage?: (message: HelperMessage)=>Promise<void>,env?:NodeJS.ProcessEnv): Promise<Record<string,unknown>> {
  const name=process.platform==='win32'?'station-native.exe':'station-native';
  const bundled=join(process.resourcesPath??'', 'station-native',name);
  const built=join(app.getAppPath(),'build','station-native',name);
  const binary=existsSync(bundled)?bundled:existsSync(built)?built:undefined;
  if(!binary) return Promise.reject(new Error('内部原生接收组件缺失，请修复安装 Station'));
  return new Promise((resolve,reject)=>{
    // Backend auth environments are intentionally filtered. The local journal
    // namespace must nevertheless match run/inspect/stop; it is chosen only
    // by this process, never by a shared task or remote caller.
    const helperEnv:NodeJS.ProcessEnv={...(env??process.env),PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'};
    if(process.env.POCKET_VIBE_STATE_DIR)helperEnv.POCKET_VIBE_STATE_DIR=process.env.POCKET_VIBE_STATE_DIR;
    const child=spawn(binary,[],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:helperEnv});
    let result:Record<string,unknown>|undefined; let error:string|undefined;let queued=Promise.resolve();
    const timeout=['run','attach','worker-run','worker-check'].includes(String(request.operation))?undefined:setTimeout(()=>{error='内部组件核对超时，原执行与记录保留';child.kill();},90000);
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{
      if(line.length>256000) {error='内部组件消息超限';return;}
      try {
        const message=JSON.parse(line) as HelperMessage;
        if(message.type==='result') result=message.value;
        else if(message.type==='error') error=message.message;
        else queued=queued.then(()=>onMessage?.(message)).catch(e=>{error=e instanceof Error?e.message:'内部事件处理失败';});
      } catch {error='内部组件返回无效协议';}
    });
    child.stderr.resume();child.on('error',e=>{clearTimeout(timeout);reject(e);});
    child.stdin.on('error',()=>{error='内部组件输入通道中断，原执行需要核对';});
    child.on('close',()=>{clearTimeout(timeout);void queued.then(()=>{if(error||!result)reject(new Error(error??'内部组件退出，原执行需要核对'));else resolve(result);});});
    child.stdin.end(JSON.stringify(request)+'\n');
  });
}
export class GuardedCodexExecution implements ExecutionHandle {
  constructor(private executionId:string,private binary:string,private env:NodeJS.ProcessEnv,private model?:string){}
  async run(request:ExecutionRequest,hooks:ExecutionHooks) {
    const result=await nativeHelper({operation:'worker-run',executionId:this.executionId,command:[this.binary,'app-server','--stdio'],
      cwd:request.cwd,objective:request.objective,permission:request.permission,threadId:request.threadId,textOnly:request.textOnly===true,images:request.images??[],...(this.model?{model:this.model}:{})},async message=>{
      if(message.type==='identity'&&message.threadId)await hooks.identity(message.threadId,message.turnId);
      if(message.type==='output'&&message.text)await hooks.output(message.text);
      if(message.type==='approval-observed'&&message.id&&message.decision)await hooks.approvalObserved?.(message.id,message.decision);
      if(message.type==='approval'&&message.id) {
        // Do not block identity/output processing while a human decides.
        void hooks.approval(message.id,message.tool??'工具',message.description??'',message.supported===true).then(decision=>
          nativeHelper({operation:'worker-approval',executionId:this.executionId,approvalId:message.id,decision})).catch(()=>{});
      }
    },this.env);
    return {summary:String((result.json as {last_message?:string})?.last_message||result.error||''),stopped:result.cancelled===true,exitConfirmed:result.cleanup_confirmed===true,turnOutcome:(result.cancelled===true?'interrupted':result.ok===true?'completed':result.ok===false?'failed':'unknown') as TurnOutcome};
  }
  async stop(){const result=await nativeHelper({operation:'worker-stop',executionId:this.executionId});return result.cleanup_confirmed===true;}
  close(){}
}
export class NativeExecution implements ExecutionHandle {
  private hooks?: ExecutionHooks;
  constructor(private executionId:string,private sessionId:string,private grants:DirectoryGrant[],
    private wait:(waiting:boolean)=>Promise<void>,private slot:()=>Promise<boolean>,private attach=false,private alreadyLeased=false) {}
  async run(request:ExecutionRequest,hooks:ExecutionHooks) {
    this.hooks=hooks;if(!this.alreadyLeased)await this.wait(true);let leased=this.alreadyLeased;
    const result=await nativeHelper({operation:this.attach?'attach':'run',executionId:this.executionId,sessionId:this.sessionId,objective:request.objective,grants:this.grants},async message=>{
      if(message.type==='identity'&&message.threadId) {await this.wait(false);await hooks.identity(message.threadId,message.turnId);}
      if(message.type==='slot-request'&&!leased&&await this.slot()) {leased=true;await nativeHelper({operation:'grant-slot',executionId:this.executionId,generation:message.generation});}
      if(message.type==='state'&&['waiting','waiting-slot'].includes(message.status??'')&&!leased) await this.wait(true);
    });
    const summary=String((result.json as {last_message?:string})?.last_message??result.error??'');
    if(summary) await hooks.output(summary);
    return {summary,stopped:result.cancelled===true,exitConfirmed:result.cleanup_confirmed===true,turnOutcome:(result.cancelled===true?'interrupted':result.ok===true?'completed':result.ok===false?'failed':'unknown') as TurnOutcome};
  }
  async stop(): Promise<boolean> {
    const result=await nativeHelper({operation:'stop',executionId:this.executionId,grants:this.grants});
    return result.cleanup_confirmed===true;
  }
  close(): void {this.hooks=undefined;}
}
