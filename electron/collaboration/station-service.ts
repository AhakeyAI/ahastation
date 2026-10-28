import {textSlice} from './text-slice.js';
import {credentialContext,credentialMetadata,encryptDeviceCredential,decryptDeviceCredential,LocalCredentialError} from './device-credential.js';
import {readFile} from 'node:fs/promises';
import {canonicalJson,deliveryHash,verifiedDelivery} from './delivery-identity.js';
import {rejectedHostPlan} from './host-plan-outcome.js';
import {preserveText,readFullText,uploadText,downloadText} from './text-artifacts.js';
import { app, dialog, ipcMain, safeStorage, webContents } from 'electron';
import { hostname } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { DurableState } from './durable-state.js';
import { CollaborationConnection, CollaborationHttpError } from './connection.js';
import { parseSharedCommand,validateSharedWire } from './production-validation.js';
import { getRemoteControlSettings } from '../remote-control.js';
import { getBackendRegistry } from '../backends/registry.js';
import { getBackendAuth } from '../store.js';
import { LocalProjectAccess, assertExecutableWorkspace } from './local-project-access.js';
import { parseContract } from './validation.js';
import { normalizeGithubRepository } from './repository-identity.js';
import { checkGithub, git, prepareRepository, deliverRepository, trustedDirectory, runFile,executableCommand } from './workspaces.js';
import { CodexExecution, FileTestExecution, executionOutcome, type ExecutionHandle } from './execution.js';
import { nativeHelper, NativeExecution, GuardedCodexExecution } from './native-helper.js';
import { collaborationFetch } from './network.js';
import { SharedCoordinator } from './coordinator.js';
import { UnifiedMeetingHost } from './unified-host.js';
import { boundedMeetingContext } from './unified-policy.js';
import {prepareMeetingInput} from './meeting-input.js';
import {reviewSharedReport} from './delivery-report.js';
import { materializeFiles, publishFiles,pushPublication, fetchDelivery,previewGitFile, type GitFileReference } from './git-files.js';
import { ensurePullRequest } from './github.js';
import { prepareMeetingBranch, integrateDelivery, finalMeetingPullRequest } from './integration.js';
import type { CollaborationProject, DeviceConfig, LocalProjectBinding } from './types.js';
import type { LocalReceipt, SharedCommand, SharedEntity, SharedEvent, SharedSnapshot, StationLocalState, StationView } from './production-types.js';
import {hostInputTerminal,type HostInputStatus,type HostInputFailure} from './production-types.js';
import {dependencyWait,pendingBaseRevisions} from './plan-revision.js';

export class StationService {
  private storage: DurableState<StationLocalState>;
  private connection?: CollaborationConnection;
  private active=new Map<string,ExecutionHandle>();
  private pumping?: Promise<void>;
  private pumpDirty=false;
  private approvals=new Map<string,(decision:'allow'|'deny')=>void>();
  private probes: StationView['probes']=[];
  private connected=false; private closing=false;
  private slots=new Set<string>();
  private startingTasks=new Set<string>();
  private nativeRows=new Map<string,Record<string,unknown>>();
  private nativeCycle?:{id:string;cursor?:unknown;seen:Set<string>};
  private nativeTimer?: ReturnType<typeof setInterval>;
  private syncingNative=false;
  private configQueue:Promise<unknown>=Promise.resolve();
  private hosts=new Map<string,SharedCoordinator|UnifiedMeetingHost>();
  private discussions=new Map<string,ExecutionHandle>();
  private deliveries=new Map<string,Promise<void>>();
  private discussionQueues=new Map<string,Promise<void>>();
  private hostScheduled=new Set<string>();
  private executingInputs=new Set<string>();
  private recoveryTimer?:ReturnType<typeof setInterval>;
  private connectionEpoch=0;
  private messageDeliveries=new Map<string,Promise<SharedEntity>>();
  private objectJobs=new Map<string,Promise<unknown>>();
  private helperCalls=0;
  private helperWaiters:Array<()=>void>=[];
  private accountActions=0;
  private gitCalls=0;private gitWaiters:Array<()=>void>=[];private gitStarting=new Set<string>();
  private integrationScheduled=new Set<string>();
  private integrationQueues=new Map<string,Promise<unknown>>();
  private localReady=false;private loadError?:string;
  constructor(folder=join(app.getPath('userData'),'collaboration')) {
    this.storage=new DurableState(join(folder,'station-v2.json'),{
      version:2,deviceId:randomUUID(),config:{name:hostname(),platform:process.platform==='win32'?'windows':process.platform==='darwin'?'macos':'linux',
        acceptingTasks:false,maxConcurrency:1,agents:[]},allowedAgents:[],bindings:{},directories:{},receipts:{},outbox:[],
      snapshot:{protocol:2,cursor:0,entities:{}},
    });
  }
  async initialize(): Promise<void> {
    await this.storage.load();
    if(this.storage.read().version!==2) throw new Error('本机协作记录版本不兼容');
    this.localReady=true;
    // Persist the identity before any registration attempt.
    await this.storage.update(s=>{for(const command of s.outbox)if(command.action==='message.send'){const previous=s.messageSubmissions?.[command.requestId];(s.messageSubmissions??={})[command.requestId]={requestId:command.requestId,meetingId:String(command.payload.meetingId),text:String(command.payload.text),status:'pending',digest:createHash('sha256').update(JSON.stringify(command.payload)).digest('hex'),...previous,command};}this.reconcileSnapshotSubmissions(s);}); await this.probe();
    for(const receipt of Object.values(this.storage.read().receipts)) {
      if(['starting','running','reconcile','waiting-desktop'].includes(receipt.status)&&receipt.executionInvoked) await this.receipt(receipt.taskId,{status:'reconcile'});
    }
    this.startTimers();
    await this.connect();
  }
  private startTimers() {
    this.nativeTimer??=setInterval(()=>{if(this.connected)this.scheduleNativeSync();if(this.connected&&!this.syncingNative){this.syncingNative=true;void this.syncNative().catch(()=>{}).finally(()=>{this.syncingNative=false;});}},5000);
    this.recoveryTimer??=setInterval(()=>{void this.recoverReceipts().then(()=>{if(this.connected)void this.pump().catch(error=>this.error(error));}).catch(error=>this.error(error));if(this.connected)void this.flush().catch(error=>this.error(error));},2000);
  }
  private changed() {
    for(const wc of webContents.getAllWebContents()) if(!wc.isDestroyed()) wc.send('collaboration:changed');
  }
  view(): StationView {
    const s=this.storage.read();
    for(const message of s.snapshot.entities.message??[]){const failure=s.hostFailures?.[message.id];if(failure&&message.executionStatus!=='stopped'&&s.hostMessages?.[message.id]==='failed')Object.assign(message,{executionStatus:'failed',output:failure.message,notStarted:failure.notStarted,exitConfirmed:true});}
    for (const task of s.snapshot.entities.task??[]) {
      const receipt=s.receipts[task.id];
      if (!receipt) continue;
      if (receipt.attemptId===task.attemptId) {
        Object.assign(task,{
          ...(receipt.turnOutcome?{turnOutcome:receipt.turnOutcome}:{}),
          ...(receipt.stopRequested?{stopRequested:true}:{}),
          ...(receipt.deliveryError?{deliveryError:receipt.deliveryError}:{}),
          ...(receipt.nativeRpcError?{nativeRpcError:{...receipt.nativeRpcError,taskId:task.id,attemptId:receipt.attemptId}}:{}),
        });
      }
      const pendingGit=Object.values(receipt.gitOperations??{}).filter(operation=>!operation.exitConfirmed);
      if (pendingGit.length) task.gitReconciliationReason=pendingGit.map(operation=>
        s.reconciliation?.['git:'+operation.id]?.reason||s.reconciliation?.['git-run:'+operation.id]?.reason||'原 Git 操作仍在途，目录占用保留'
      ).join('；');
    }
    return {accountKey:createHash('sha256').update(JSON.stringify([s.serviceUrl,s.ownerId,s.deviceId])).digest('hex'),reconciliation:s.reconciliation,messageSubmissions:Object.values(s.messageSubmissions??{}).map(({command:_,...submission})=>submission),connected:this.connected,deviceId:s.deviceId,config:s.config,allowedAgents:s.allowedAgents,snapshot:s.snapshot,
      bindings:Object.values(s.bindings),directories:Object.values(s.directories),error:this.loadError??(s.errorScope==='device'?s.error:undefined),errorScope:'device',legacyError:s.errorScope?undefined:s.error,businessErrors:Object.values(s.businessErrors??{}),credentialFailure:s.credentialFailure,credentialReady:!!s.tokenEnc&&!s.credentialFailure&&!s.credentialInvalid,probes:this.probes,sharedFiles:s.sharedFiles};
  }
  async error(error: unknown,entity?:SharedEntity,operation='execution'): Promise<void> {
    const message=error instanceof Error?error.message:'协作操作失败';
    if(!this.localReady)this.loadError=message;
    else try{await this.storage.update(s=>{if(entity){const key=JSON.stringify([entity.meetingId??entity.id,entity.id,entity.attemptId,operation]);const old=s.businessErrors?.[key];(s.businessErrors??={})[key]={key,meetingId:String(entity.meetingId??entity.id),entityId:entity.id,attemptId:entity.attemptId?String(entity.attemptId):undefined,operation,reason:message,history:[...(old?.history??[]),message].slice(-20),active:!(operation==='execution'&&(s.hostMessages?.[entity.id]==='completed'||s.receipts[entity.id]?.attemptId===entity.attemptId&&['executed','delivered'].includes(String(s.receipts[entity.id]?.status))))};}else{s.error=message;s.errorScope='device';}});}catch{this.loadError=message;}
    this.changed();
  }
  requestEntity(action:string,p:Record<string,unknown>={}):{entity?:SharedEntity;operation:string}{
    const raw=(action==='command'?p.payload:p) as Record<string,unknown>|undefined;const operation=action+':'+String(p.action??'')+':'+String(raw?.operation??'');
    const row=raw?.taskId?this.rows('task').find(t=>t.id===raw.taskId):raw?.messageId?this.rows('message').find(t=>t.id===raw.messageId):undefined;
    const entity=row?{...row,...(raw?.attemptId?{attemptId:raw.attemptId}:{})}:raw?.meetingId?{id:String(raw.meetingId),revision:0,meetingId:raw.meetingId}:undefined;return {entity,operation};
  }
  async clearBusinessError(entity:SharedEntity,operation='execution'){
    const key=JSON.stringify([entity.meetingId??entity.id,entity.id,entity.attemptId,operation]);await this.storage.update(s=>{if(s.businessErrors?.[key])s.businessErrors[key].active=false;});this.changed();
  }
  async probe(): Promise<void> {
    const identity=this.identityKey(),epoch=this.connectionEpoch;
    const current=()=>identity===this.identityKey()&&epoch===this.connectionEpoch;
    let native:{installed?:boolean;authenticated?:boolean;linked?:boolean}={};let helperReady=false;
    try {native=await nativeHelper({operation:'detect'});helperReady=true;}catch{}
    const probes=await Promise.all(getBackendRegistry().list().filter(b=>b.id!=='pocket-vibe').map(async backend=>{
      const installed=!!backend.resolveBinary(); let authenticated=false;
      try {authenticated=installed && (await backend.checkAuthStatus?.())?.loggedIn===true;} catch {}
      if(backend.id!=='codex')return {agentId:backend.id,installed,authenticated:authenticated||!!getBackendAuth(backend.id)?.apiKey,executionModes:[] as Array<'worker'|'native-session'>,guide:'保留原本机功能；此 Agent 尚未适配跨设备任务与讨论'};
      const modes:Array<'worker'|'native-session'>=[];if(installed&&authenticated&&(helperReady||process.platform==='darwin'))modes.push('worker');if(native.authenticated&&native.linked)modes.push('native-session');
      return {agentId:backend.id,installed:installed||native.installed===true,authenticated:modes.length>0,executionModes:modes,
        guide:`新任务：${!helperReady&&process.platform!=='darwin'?'内置接收组件缺失，请修复安装':authenticated?'已登录可用':'请在 Agent 设置中登录 Codex'}；原生接续：${native.linked&&native.authenticated?'联动桌面可用':native.installed?'已识别桌面，请使用下方联动入口':'未识别兼容桌面'}`};
    }));
    if(process.env.AHASTATION_ENABLE_TEST_AGENT==='1') probes.push({agentId:'file-test',installed:true,authenticated:true,executionModes:['worker'],guide:'非模型联调适配器'});
    if(!current())return;
    this.probes=probes;
    await this.storage.update(s=>{if(!current())return;s.config.agents=probes.filter(p=>p.executionModes.length>0).map(p=>({agentId:p.agentId,backendId:p.agentId,available:p.installed&&p.authenticated&&s.allowedAgents.includes(p.agentId),executionModes:p.executionModes}));});
  }
  async connect(): Promise<void> {
    if(this.closing) return;
    const epoch=++this.connectionEpoch;
    this.connection?.stop(); this.connected=false;
    let s=this.storage.read();const account=getRemoteControlSettings();
    if(!account.enabled || !account.ownerId || !account.controlToken || !account.serviceUrl || account.credentialInvalid) return;
    const selected=()=>{const now=getRemoteControlSettings();return epoch===this.connectionEpoch&&now.enabled&&now.ownerId===account.ownerId&&now.serviceUrl===account.serviceUrl&&now.controlToken===account.controlToken&&!now.credentialInvalid;};
    if(s.ownerId && (s.ownerId!==account.ownerId || s.serviceUrl!==account.serviceUrl)) {
      if(this.accountActions||this.active.size||this.startingTasks.size||this.deliveries.size||this.executingInputs.size||this.discussions.size||[...this.objectJobs.keys()].some(key=>!key.includes(':submission:'))||Object.values(s.checks??{}).some(c=>!c.exitConfirmed)||Object.values(s.hostMessages??{}).some(status=>!hostInputTerminal(status))||Object.values(s.receipts).some(r=>!r.exitConfirmed&&['running','starting','reconcile'].includes(r.status)||Object.values(r.gitOperations??{}).some(g=>!g.exitConfirmed)))throw new Error('请先停止并核对原账号本机任务，再更换协作账号或服务');
      const archivePath=(owner:string,url:string)=>this.storage.file+'.account-'+createHash('sha256').update(owner+'\n'+url).digest('hex').slice(0,20);
      const archive=new DurableState(archivePath(s.ownerId,s.serviceUrl??''),s);await archive.update(()=>{});if(!selected())return;
      const fresh:StationLocalState={...s,deviceId:randomUUID(),ownerId:account.ownerId,serviceUrl:account.serviceUrl,tokenEnc:undefined,deviceCredential:undefined,credentialFailure:undefined,credentialHistory:[],credentialRecoveryRequestId:undefined,credentialRecoveryConfig:undefined,registrationRequestId:undefined,registrationConfig:undefined,credentialInvalid:false,
        config:{...s.config,acceptingTasks:false,agents:[]},allowedAgents:[],bindings:{},directories:{},receipts:{},outbox:[],snapshot:{protocol:2,cursor:0,entities:{}},gitHistory:{},reconciliation:{},businessErrors:{},hostMessages:{},hostFailures:{},inputContexts:{},hostPlanBases:{},messageSubmissions:{},discussionThreads:{},originalHostSessions:{},hostThreads:{},sharedFiles:[],integrations:{},meetingWorkspaces:{},projectChecks:{},checks:{},nativeHistoryCursors:{},stationNativeTurns:{}};
      const destination=new DurableState(archivePath(account.ownerId,account.serviceUrl),fresh);await destination.load();if(!selected())return;
      await this.storage.update(state=>{if(selected())Object.assign(state,destination.read());});if(!selected())return;s=this.storage.read();this.nativeRows.clear();this.nativeCycle=undefined;this.hosts.clear();this.hostScheduled.clear();this.integrationScheduled.clear();await this.probe();
    }
    if(!selected())return;
    if(!safeStorage.isEncryptionAvailable()) throw new Error('系统凭证安全存储不可用，无法接入设备');
    let token:string|undefined;
    try{token=s.tokenEnc?decryptDeviceCredential(s.tokenEnc,{ownerId:account.ownerId,serviceUrl:account.serviceUrl,deviceId:s.deviceId},s.deviceCredential):undefined;}
    catch(error){if(!selected())return;await this.storage.update(state=>{if(!selected())return;state.credentialFailure=error instanceof LocalCredentialError?{kind:error.kind,diagnostic:error.diagnostic}:{kind:'local-decryption-failed',diagnostic:{exceptionName:(error as Error).name}};});throw error;}
    if(s.credentialInvalid&&!token)throw new Error('原设备凭证不可用，请正常登录并核对设备授权；原任务保留');
    if(!token) {
      const identity=s.registrationRequestId??randomUUID();const config=s.registrationConfig??s.config;await this.storage.update(state=>{if(selected()){state.registrationRequestId=identity;state.registrationConfig=config;}});if(!selected())return;
      const command=parseSharedCommand({protocol:2,requestId:identity,action:'device.register',payload:{deviceId:s.deviceId,config}});
      const response=await collaborationFetch(account.serviceUrl+'/api/collaboration/v2/commands',{method:'POST',headers:{Authorization:'Bearer '+account.controlToken,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(15000)});
      if(!response.ok) throw new Error(response.status===401?'协作账号登录已失效，请正常登录后重新接入':response.status===409?'设备已撤销或接入记录需要核对，请确认清理后使用本机重新授权接入':`设备注册失败 (${response.status})，请检查 Hub 是否部署协议 2`);
      const result=await response.json() as {value:{deviceToken:string}}; token=result.value.deviceToken;
      if(!selected())return;
      await this.saveDeviceCredential(token!,account.ownerId,account.serviceUrl,selected);
    }
    if(!selected())return;
    const identity=this.identityKey();const current=()=>selected()&&identity===this.identityKey();
    const connection=new CollaborationConnection({url:account.serviceUrl,token,deviceId:s.deviceId,
      onSnapshot:async(snapshot,generation=()=>true)=>{if(!current()||!generation())return;if(!snapshot.capabilities?.includes('unified-hardening-v1'))throw new Error('Hub 尚未升级 collaboration.5 停止与确认协议，请先部署匹配 Hub；原任务和身份保留');await this.storage.update(state=>{if(current()&&generation()){state.snapshot=snapshot;this.reconcileSnapshotSubmissions(state);}});if(current()&&generation())this.changed();},
      onEvent:(event,generation=()=>true)=>current()&&generation()?this.event(event,()=>current()&&generation()):Promise.resolve(),
      onStatus:(connected,error,invalid)=>{if(!current())return;this.connected=connected;void this.storage.update(state=>{if(!current())return;state.error=error;state.errorScope='device';if(invalid){state.credentialInvalid=true;state.credentialFailure={kind:state.snapshot.entities.device?.find(d=>d.id===state.deviceId)?.revoked?'device-revoked':'server-auth-invalid',diagnostic:{...credentialContext(),purpose:'station-device',serverAuthentication:true}};}}).then(()=>{if(current())this.changed();}).catch(()=>{});},
      onReady:async()=>{if(!current())return;for(const job of [()=>this.flush(),()=>this.synchronizeReceipts(),()=>this.publishConfig(),()=>this.pump()])void job().catch(error=>{if(current())void this.error(error);});},
    });
    if(s.credentialInvalid||s.tokenEnc&&!s.deviceCredential){
      const snapshot=await connection.validateCredential(s.deviceId,account.ownerId);
      await this.storage.update(state=>{if(!current())return;state.credentialInvalid=false;state.credentialFailure=undefined;if(state.tokenEnc&&!state.deviceCredential)state.deviceCredential=credentialMetadata({ownerId:account.ownerId!,serviceUrl:account.serviceUrl,deviceId:state.deviceId});state.snapshot=snapshot;state.error=undefined;});
    }
    if(!current())return;
    this.connection=connection; connection.start();this.startTimers(); this.changed();
  }
  private async saveDeviceCredential(token:string,ownerId:string,serviceUrl:string,current:()=>boolean,recovery=false){
    const state=this.storage.read();const value=encryptDeviceCredential(token,{ownerId,serviceUrl,deviceId:state.deviceId});
    await this.storage.update(s=>{if(!current())throw new Error('凭据响应属于旧账号或连接，原记录保留');if(recovery&&s.tokenEnc)(s.credentialHistory??=[]).push({cipher:s.tokenEnc,metadata:s.deviceCredential,reason:s.credentialFailure?.kind??'explicit-user-recovery'});s.ownerId=ownerId;s.serviceUrl=serviceUrl;s.tokenEnc=value.cipher;s.deviceCredential=value.metadata;s.credentialFailure=undefined;s.credentialInvalid=false;});
    const disk=JSON.parse(await readFile(this.storage.file,'utf8')) as StationLocalState;if(!current())return;
    if(disk.tokenEnc!==value.cipher||JSON.stringify(disk.deviceCredential)!==JSON.stringify(value.metadata)||decryptDeviceCredential(disk.tokenEnc,{ownerId,serviceUrl,deviceId:state.deviceId},disk.deviceCredential)!==token)throw new Error('设备凭据耐久落盘核对失败；不清理原记录、不启动新任务');
  }
  private async event(event: SharedEvent,current=()=>true): Promise<void> {
    await this.storage.update(s=>{
      if(!current())return;
      if(event.seq<=s.snapshot.cursor) return;
      const rows=s.snapshot.entities[event.kind]??=[]; const previous=rows.find(r=>r.id===event.id);
      if(previous && event.revision<=previous.revision) throw new Error('实体版本冲突，需要刷新快照');
      const updated=event.kind==='device'&&previous?rows.map(r=>r.id===event.id?event.value:r):[...rows.filter(r=>r.id!==event.id),event.value];
      s.snapshot.entities[event.kind]=event.kind==='history'?updated.slice(-200):updated;s.snapshot.cursor=event.seq;
      this.reconcileSnapshotSubmissions(s);
    });
    if(!current())return;
    this.changed();
    if(['task','approval','message','meeting','device','binding'].includes(event.kind)) void this.pump().catch(error=>this.error(error));
  }
  private async send(action: string,payload: Record<string,unknown>,requestId: string=randomUUID(),authorized=()=>true): Promise<SharedEntity> {
    const identity=this.identityKey(),connection=this.connection;
    let command=parseSharedCommand({protocol:2,requestId,action,payload});
    let accepted:SharedEntity|undefined;
    await this.storage.update(s=>{
      if(identity!==this.identityKey()||!authorized())throw new Error('协作身份已变化，原指令不能投到其他账号或服务');
      const sameId=s.outbox.find(c=>c.requestId===command.requestId);
      if(sameId&&JSON.stringify(sameId)!==JSON.stringify(command))throw new Error('提交身份已用于其他内容，请核对原提交');
      if(action==='message.send'){
        const digest=createHash('sha256').update(canonicalJson(payload)).digest('hex');const previous=s.messageSubmissions?.[requestId];
        if(previous?.digest&&previous.digest!==digest)throw new Error('提交身份已用于其他内容，请核对原提交');
        if(previous?.status==='accepted'&&!previous.digest&&!previous.command)throw new Error('原提交已确认，但本机缺少原内容依据；请核对原记录，不复用身份发送其他内容');
        if(previous?.status==='accepted'){accepted=s.snapshot.entities.message?.find(m=>m.id===previous.messageId)??{id:previous.messageId!,revision:0};return;}
        if(previous?.status==='rejected')throw new Error(previous.error??'原提交已被明确拒绝，请修正后重新提交');
        (s.messageSubmissions??={})[requestId]={...previous,requestId,meetingId:String(payload.meetingId),text:String(payload.text),digest,status:'pending',command};
      }
      if(action==='task.event'&&payload.status==='running'&&payload.output&&!payload.nativeThreadId)
        s.outbox=s.outbox.filter(c=>!(c.action===action&&c.payload.taskId===payload.taskId&&c.payload.attemptId===payload.attemptId&&c.payload.status==='running'&&c.payload.output&&!c.payload.nativeThreadId));
      const previous=s.outbox.find(c=>c.action===action&&JSON.stringify(c.payload)===JSON.stringify(payload));
      if(previous&&!['message.send','task.create','task.control'].includes(action))command=previous;
      if(!s.outbox.some(c=>c.requestId===command.requestId)) {
        if(Buffer.byteLength(JSON.stringify(s.outbox),'utf8')>2*1024*1024&&!['task.event','message.event','task.receipt','message.receipt','approval.decide','approval.observed'].includes(action)&&!(action==='task.control'&&payload.operation==='stop'))throw new Error('本机待投递记录已达限额，请先恢复连接并核对原任务');
        s.outbox.push(command);
      }
    });
    this.changed();if(accepted)return accepted;
    if(identity!==this.identityKey()||connection!==this.connection)throw new Error('原连接已变化，请核对原提交');
    if(!this.connection?.connected) throw new Error('请求已保存，等待连接恢复后核对投递');
    return this.deliver(command);
  }
  private identityKey():string {const s=this.storage.read();return JSON.stringify([s.serviceUrl,s.ownerId,s.deviceId]);}
  private acceptSubmission(s:StationLocalState,id:string,value:SharedEntity){
    const submission=s.messageSubmissions?.[id];if(!submission)return;
    submission.status='accepted';submission.messageId=value.id;submission.text='';delete submission.error;
    s.outbox=s.outbox.filter(c=>c.requestId!==id);
  }
  private reconcileSnapshotSubmissions(s:StationLocalState){
    for(const sub of Object.values(s.messageSubmissions??{})){
      const message=s.snapshot.entities.message?.find(m=>m.submissionId===sub.requestId&&m.sourceDeviceId===s.deviceId&&m.meetingId===sub.meetingId);
      if(message)this.acceptSubmission(s,sub.requestId,message);
    }
  }
  private deliver(command:SharedCommand):Promise<SharedEntity>{
    const key=this.identityKey()+':'+command.requestId;const previous=this.messageDeliveries.get(key);if(previous)return previous;
    const job=this.performDeliver(command).finally(()=>{if(this.messageDeliveries.get(key)===job)this.messageDeliveries.delete(key);});
    this.messageDeliveries.set(key,job);return job;
  }
  private async performDeliver(command: SharedCommand): Promise<SharedEntity> {
    const identity=this.identityKey(),connection=this.connection,epoch=this.connectionEpoch;
    const current=()=>identity===this.identityKey()&&connection===this.connection&&epoch===this.connectionEpoch;
    const accepted=()=>{const sub=this.storage.read().messageSubmissions?.[command.requestId];return sub?.status==='accepted'?{id:sub.messageId!,revision:0}:undefined;};
    const previous=accepted();if(previous)return previous;
    let result:{value:SharedEntity};
    try {result=await connection!.command(command) as {value:SharedEntity};if(!result?.value||command.action==='message.send'&&typeof result.value.id!=='string')throw new Error('原提交未返回可核对的消息身份');}
    catch(error) {
      if(!current())throw new Error('原连接已更换，原提交留在原身份核对');
      let rejected=command.action==='plan.propose'
        ?!!rejectedHostPlan(error)
        :error instanceof CollaborationHttpError&&error.status>=400&&error.status<500&&![401,408,429].includes(error.status);
      if(command.action==='message.send'){
        const prior=accepted();if(prior)return prior;
        if(rejected){try{const proof=await this.lookupSubmission(command.requestId,connection!);if(proof){await this.storage.update(s=>{if(current())this.acceptSubmission(s,command.requestId,proof);});if(current())return proof;}const sub=this.storage.read().messageSubmissions?.[command.requestId];rejected=!sub?.uncertain;}catch{rejected=false;}}
      }
      await this.storage.update(s=>{if(!current())return;const submission=s.messageSubmissions?.[command.requestId];if(submission?.status==='accepted')return;if(rejected)s.outbox=s.outbox.filter(c=>c.requestId!==command.requestId);if(submission){submission.status=rejected?'rejected':'pending';submission.uncertain=!rejected;submission.error=String(error instanceof Error?error.message:error);}});if(current())this.changed();
      const confirmed=current()?accepted():undefined;if(confirmed)return confirmed;
      throw error;
    }
    await this.storage.update(s=>{if(!current())return;s.outbox=s.outbox.filter(c=>c.requestId!==command.requestId);this.acceptSubmission(s,command.requestId,result.value);});
    if(!current())throw new Error('原连接已更换，原提交留在原身份核对');this.changed();return result.value;
  }
  private async lookupSubmission(id:string,connection:CollaborationConnection):Promise<SharedEntity|undefined>{
    const proof=await connection.request('/api/collaboration/v2/message-receipts?requestId='+encodeURIComponent(id)) as {protocol:number;requestId:string;found:boolean;value?:SharedEntity};
    validateSharedWire('message-receipt',proof);
    if(proof.protocol!==2||proof.requestId!==id||typeof proof.found!=='boolean')throw new Error('原提交回执协议不兼容，保留原记录待核对');
    const sub=this.storage.read().messageSubmissions?.[id];
    if(proof.found&&(!proof.value?.id||proof.value.sourceDeviceId!==this.storage.read().deviceId||proof.value.meetingId!==sub?.meetingId))throw new Error('原提交回执身份不匹配');
    return proof.found?proof.value:undefined;
  }
  private async reconcileSubmission(id:string):Promise<unknown>{
    const identity=this.identityKey(),connection=this.connection,epoch=this.connectionEpoch,current=()=>identity===this.identityKey()&&connection===this.connection&&epoch===this.connectionEpoch;
    await this.storage.update(s=>{if(current())this.reconcileSnapshotSubmissions(s);});
    let sub=this.storage.read().messageSubmissions?.[id];if(!sub)throw new Error('未找到本机原提交，不能生成替代消息');
    if(sub.status==='accepted'){this.changed();return {id:sub.messageId,revision:0,status:'accepted'};}
    if(sub.status==='rejected')throw new Error(sub.error??'原提交已被明确拒绝');
    const command=this.storage.read().outbox.find(c=>c.requestId===id&&c.action==='message.send')??sub.command;
    if(!connection?.connected)return {pending:true,requestId:id};
    try{
      // Missing commands are never reconstructed from a digest or empty text.
      if(!command){const proof=await this.lookupSubmission(id,connection);if(!current())return {pending:true,requestId:id};if(proof){await this.storage.update(s=>{if(current())this.acceptSubmission(s,id,proof);});this.changed();return proof;}throw new Error('原提交尚无可核对收据；原命令缺失，保留历史等待原服务记录恢复');}
      return await this.deliver(command);
    }catch(error){if(!current())return {pending:true,requestId:id};await this.storage.update(s=>{const saved=s.messageSubmissions?.[id];if(current()&&saved?.status==='pending')saved.error=error instanceof Error?error.message:String(error);});this.changed();sub=this.storage.read().messageSubmissions?.[id];if(sub?.status==='accepted')return {id:sub.messageId,status:'accepted'};if(sub?.status==='rejected')throw error;return {pending:true,requestId:id};}
  }
  private async flush(): Promise<void> {
    for(const submission of Object.values(this.storage.read().messageSubmissions??{}).filter(s=>s.status==='pending'))this.background('submission:'+submission.requestId,()=>this.reconcileSubmission(submission.requestId));
    for(const command of this.storage.read().outbox) {
      if(command.action==='message.send')continue;
      try {await this.deliver(command);}
      catch(error) {
        const scope=this.requestEntity(command.action,command.payload);
        await this.error(error,scope.entity,scope.operation);
        // A request-specific identity conflict still needs reconciliation, but
        // does not prevent delivery of unrelated saved work on this connection.
        if(command.action==='plan.propose'&&error instanceof CollaborationHttpError&&error.code==='REQUEST_ID_CONTENT_CONFLICT')continue;
        if(this.storage.read().outbox.some(c=>c.requestId===command.requestId))break;
      }
    }
  }
  private rows(kind: string): SharedEntity[] {return this.storage.read().snapshot.entities[kind]??[];}
  private publishConfig():Promise<void> {
    const job=this.configQueue.then(async()=>{
      for(let retry=0;retry<3;retry++) {
        const snapshot=await this.connection!.request('/api/collaboration/v2/snapshot') as SharedSnapshot;
        const s=this.storage.read();const device=snapshot.entities.device?.find(d=>d.id===s.deviceId);
        if(!device||device.revoked)return;
        try {await this.send('device.update',{config:s.config,expectedRevision:device.revision});return;}
        catch(error) {if(!(error instanceof CollaborationHttpError&&error.status===409)||retry===2)throw error;}
      }
    });this.configQueue=job.catch(()=>{});return job;
  }
  private receipt(taskId: string,patch: Partial<LocalReceipt>,attemptId?:string): Promise<void> {
    return this.storage.update(s=>{const r=s.receipts[taskId];if(!r) throw new Error('本机持久接单记录缺失');if(attemptId&&r.attemptId!==attemptId)return;
      if(r.exitConfirmed&&patch.status&&['starting','running','waiting-desktop'].includes(patch.status))return;
      if(r.exitConfirmed&&r.turnOutcome&&r.turnOutcome!=='unknown'&&patch.turnOutcome&&patch.turnOutcome!==r.turnOutcome)return;
      if(r.turnOutcome==='completed'&&['stopped','reconcile'].includes(String(patch.status)))return;
      if(r.status==='delivered'&&patch.status&&patch.status!=='delivered')return;
      Object.assign(r,patch);
      if(patch.nativeThreadId&&patch.nativeTurnId){const turns=(s.stationNativeTurns??={})[patch.nativeThreadId]??=[];if(!turns.includes(patch.nativeTurnId))turns.push(patch.nativeTurnId);s.stationNativeTurns[patch.nativeThreadId]=turns;}
    });
  }
  private taskReceipt(task:SharedEntity,patch:Partial<LocalReceipt>):Promise<void> {
    return this.receipt(task.id,patch,String(task.attemptId));
  }
  private access() {
    return new LocalProjectAccess({deviceId:this.storage.read().deviceId,
      getProject:id=>{const p=this.rows('project').find(row=>row.id===id);return p?{schemaVersion:1,projectId:id,name:String(p.name),repository:p.repository,revision:p.revision,...(p.repoSubdirectory?{repoSubdirectory:p.repoSubdirectory}:{})} as CollaborationProject:undefined;},
      getBinding:id=>this.storage.read().bindings[id],getAgent:id=>this.storage.read().config.agents.find(a=>a.agentId===id)});
  }
  private async authorize(task: SharedEntity): Promise<number> {
    const s=this.storage.read();
    for(const ref of (task.inputs??[]) as GitFileReference[]) {
      const project=this.rows('project').find(p=>(p.repository as {canonicalUrl?:string})?.canonicalUrl===ref.repository);
      if(!project||!s.bindings[project.id]?.confirmed||!s.bindings[project.id].allowedAgentIds.includes(String(task.agentId)))throw new Error('本机尚未授权此 Agent 使用这份输入资料的 GitHub 仓库');
    }
    const mode=task.resource==='native'?'native-session':'worker';
    if(!s.allowedAgents.includes(String(task.agentId)) || !s.config.agents.some(a=>a.agentId===task.agentId&&a.available&&a.executionModes.includes(mode))) throw new Error('本机未允许该 Agent 的执行模式，或该模式尚未就绪');
    if(task.resource==='repository') {
      const binding=s.bindings[String(task.projectId)];const project=this.rows('project').find(p=>p.id===task.projectId);
      if(!binding?.confirmed||!project?.repository)throw new Error('项目尚未在本机授权');
      if(normalizeGithubRepository(await git(binding.localRepoRoot,['remote','get-url','origin'])).canonicalUrl!==(project.repository as {canonicalUrl:string}).canonicalUrl)throw new Error('本机仓库已变化，请重新核对项目绑定');
      try{await git(binding.localRepoRoot,['cat-file','-e',String(task.baseCommit)+'^{commit}']);}catch{await git(binding.localRepoRoot,['fetch','origin',String(task.baseCommit)]);}
      const result=await this.access().resolveAuthorizedWorkspace({projectId:String(task.projectId),taskId:task.id,attemptId:String(task.attemptId),agentId:String(task.agentId),baseCommit:String(task.baseCommit),requiredPermission:task.permission as 'read-only'|'workspace-write',executionMode:'worker'});
      if(!result.ok) throw new Error(result.error.message);return result.value.bindingRevision;
    }
    if(task.resource==='text') {
      if(task.permission!=='read-only') throw new Error('纯文字任务不能申请文件写入权限');return 0;
    }
    const grant=s.directories[String(task.projectId)];
    if(!grant?.confirmed || !grant.allowedAgentIds.includes(String(task.agentId))) throw new Error('请在本机确认任务目录及 Agent 授权');
    if(task.permission==='full-access' && grant.permission!=='full-access' || task.permission==='workspace-write' && grant.permission==='read-only') throw new Error('请求超出本机授权上限');
    if(task.resource==='native') {const native=this.nativeRows.get(String(task.nativeSessionId));if(!native||native.available!==true)throw new Error(String(native?.error??'原生对话目录尚未在本机核对，请刷新或在桌面恢复可用状态'));}
    await trustedDirectory(grant.root,grant.root);return grant.revision;
  }
  private pump(): Promise<void> {
    this.pumpDirty=true;
    if(this.pumping) return this.pumping;
    this.pumping=(async()=>{while(this.pumpDirty){this.pumpDirty=false;await this.doPump();}})().finally(()=>{this.pumping=undefined;});return this.pumping;
  }
  // A pending helper keeps its responsibility and resource evidence. The
  // observation deadline never deletes the job or starts a second helper.
  private background(key:string,work:()=>Promise<unknown>):Promise<unknown>{
    const identity=this.identityKey(),scoped=identity+':'+key,previous=this.objectJobs.get(scoped);if(previous)return previous;
    const report=async(reason:string)=>{if(identity!==this.identityKey())return;try{await this.issue(key,reason);}catch{if(identity===this.identityKey()){this.loadError='核对记录未能落盘，原执行与占用保留：'+reason;this.changed();}}};
    const timer=setTimeout(()=>{void report('核对尚未返回，保留原执行与实际占用；后台继续核对');},15000);timer.unref?.();
    const job=Promise.resolve().then(work).catch(error=>report(error instanceof Error?error.message:String(error))).finally(()=>{clearTimeout(timer);if(this.objectJobs.get(scoped)===job)this.objectJobs.delete(scoped);});
    this.objectJobs.set(scoped,job);return job;
  }
  private async settleBackground(jobs:Promise<unknown>[]):Promise<void>{
    if(!jobs.length)return;let timer:ReturnType<typeof setTimeout>|undefined;
    await Promise.race([Promise.allSettled(jobs),new Promise<void>(resolve=>{timer=setTimeout(resolve,30);})]);clearTimeout(timer);
  }
  private async helper(request:Record<string,unknown>):Promise<Record<string,unknown>>{
    return this.controlCall(()=>this.invokeHelper(request));
  }
  private invokeHelper(request:Record<string,unknown>):Promise<Record<string,unknown>>{return nativeHelper(request);}
  private async controlCall<T>(call:()=>Promise<T>):Promise<T>{
    if(this.helperCalls>=8)await new Promise<void>(resolve=>this.helperWaiters.push(resolve));
    else this.helperCalls++;
    try{return await call();}finally{const next=this.helperWaiters.shift();if(next)next();else this.helperCalls--;}
  }
  private async issue(key:string,reason?:string){
    const identity=this.identityKey();await this.storage.update(s=>{if(identity!==this.identityKey())return;const old=s.reconciliation?.[key];if(!reason){if(old)old.reason='';return;}const history=old?.history??[];if(history.at(-1)!==reason)history.push(reason);(s.reconciliation??={})[key]={reason,history:history.slice(-20)};});this.changed();
  }
  private async stopMessage(message:SharedEntity){
    const s=this.storage.read(),key=message.id+':'+message.id,handle=message.route==='agent'?this.discussions.get(message.id):this.active.get(key);
    let confirmed=false;
    if(handle)confirmed=await this.controlCall(()=>handle.stop());
    else if(message.route==='agent'&&s.hostMessages?.[message.id]&&!hostInputTerminal(s.hostMessages[message.id]))confirmed=(await this.helper({operation:'worker-stop',executionId:message.id})).cleanup_confirmed===true;
    else if(s.receipts[message.id]){await this.stopLocal(s.receipts[message.id].taskSnapshot!);return;}
    else confirmed=!s.hostMessages?.[message.id]||hostInputTerminal(s.hostMessages[message.id]);
    // cleanup alone is not a turn outcome. The live owner or original journal
    // supplies completed/interrupted; never publish a guessed stopped result.
    if(!confirmed){await this.issue('input:'+message.id,'停止尚未确认，原输入与上下文保留');if(message.executionStatus!=='reconcile'||message.exitConfirmed!==false)await this.send('message.event',{messageId:message.id,status:'reconcile',exitConfirmed:false},'stop-check:'+message.id);return;}
    if(!s.hostMessages?.[message.id]){await this.send('message.event',{messageId:message.id,status:'stopped',exitConfirmed:true,turnOutcome:'interrupted'});await this.issue('input:'+message.id);}
    else if(!this.executingInputs.has(message.id))await this.recoverInput(message.id,s.hostMessages[message.id]);
  }
  private async doPump(): Promise<void> {
    if(this.closing || !this.connected) return;
    const s=this.storage.read();
    const controlJobs:Promise<unknown>[]=[];
    for(const [id] of this.discussions){const message=this.rows('message').find(m=>m.id===id);if(message&&(!s.allowedAgents.includes(String(message.targetAgentId))||this.rows('device').some(d=>d.id===s.deviceId&&d.revoked)))controlJobs.push(this.background('input:'+id,()=>this.stopMessage(message)));}
    for(const control of this.rows('nativecontrol').filter(c=>c.deviceId===s.deviceId&&c.status==='requested')) {
      const receipt=Object.values(s.receipts).find(r=>r.nativeThreadId===control.sessionId&&r.nativeTurnId===control.turnId);
      controlJobs.push(this.background(receipt?'execution:'+receipt.attemptId:'native:'+control.sessionId+':'+control.turnId,async()=>{
        const result=await this.helper({operation:'stop-turn',sessionId:control.sessionId,turnId:control.turnId,grants:Object.values(s.directories)});const confirmed=result.cleanup_confirmed===true;
        await this.send('native.stop-result',{controlId:control.id,exitConfirmed:confirmed});await this.issue('native:'+control.sessionId+':'+control.turnId,confirmed?undefined:'停止尚未确认');
      }));
    }
    for(const message of this.rows('message').filter(m=>m.targetDeviceId===s.deviceId&&m.stopRequested&&!m.exitConfirmed)) {
      controlJobs.push(this.background(message.route==='native'?'execution:'+message.id:'input:'+message.id,()=>this.stopMessage(message)));
    }
    for(const message of this.rows('message').filter(m=>!m.replyTo&&!m.stopRequested).sort((a,b)=>Number(a.createdAt)-Number(b.createdAt))) {
      const meeting=this.rows('meeting').find(m=>m.id===message.meetingId);if(!meeting)continue;
      if(message.route==='control'&&message.targetDeviceId===s.deviceId&&!message.exitConfirmed&&!this.hostScheduled.has(message.id)) {
        this.hostScheduled.add(message.id);
        controlJobs.push(this.background('host-control:'+meeting.id,async()=>{try{const request=message.request as {operation:string;changes?:Record<string,unknown>};
          if(request.operation==='stop-host'){
            if(this.hosts.has(meeting.id)&&!await this.controlCall(()=>this.hosts.get(meeting.id)!.stop()))throw new Error('Host 退出仍待核对');
            for(const [id,status] of Object.entries(this.storage.read().hostMessages??{}))if(!hostInputTerminal(status)&&!this.executingInputs.has(id)&&this.rows('message').some(m=>m.id===id&&m.meetingId===meeting.id&&m.route==='host')){
              await this.background('input:'+id,async()=>{const stopped=await this.helper({operation:'worker-stop',executionId:id});if(!stopped.cleanup_confirmed)throw new Error('原 Host 轮次仍待核对');await this.recoverInput(id,status);});
              if(!hostInputTerminal(this.storage.read().hostMessages?.[id]??''))throw new Error('原 Host 轮次退出尚未确认');
            }
          }
          else if(request.operation==='configure')await this.send('meeting.update',request.changes!,'mc:'+message.id);
          await this.send('message.event',{messageId:message.id,status:'completed',exitConfirmed:true,output:'会议操作已完成'},'me:'+message.id);await this.issue('host-control:'+meeting.id);
        }catch(error){this.hostScheduled.delete(message.id);throw error;}}));continue;
      }
      if(message.route==='agent'&&message.targetDeviceId===s.deviceId&&!this.hostScheduled.has(message.id)&&!s.hostMessages?.[message.id]) {
        if(this.contextBusy(message))continue;
        this.hostScheduled.add(message.id);this.executingInputs.add(message.id);void this.discuss(meeting,message).catch(error=>this.error(error,message));continue;
      }
      if(message.route==='native'&&message.targetDeviceId===s.deviceId&&(!s.receipts[message.id]||s.receipts[message.id].status==='received'&&!s.receipts[message.id].executionInvoked)&&!this.hostScheduled.has(message.id)) {
        this.hostScheduled.add(message.id);void this.freeNative(message).catch(error=>{if(!this.storage.read().receipts[message.id]?.executionInvoked)this.hostScheduled.delete(message.id);return this.error(error,message);});continue;
      }
      if(message.route!=='host'||meeting.coordinatorDeviceId!==s.deviceId||!meeting.hostAgentId||this.hostScheduled.has(message.id)||s.hostMessages?.[message.id])continue;
      if([...this.hostScheduled].some(id=>this.rows('message').some(m=>m.id===id&&m.route==='host'&&m.meetingId===meeting.id)))continue;
      if(this.contextBusy(message))continue;
      this.hostScheduled.add(message.id);
      this.executingInputs.add(message.id);
      const host=this.coordinator(meeting);
      void host.input(message).catch(error=>this.error(error,message)).finally(()=>{this.executingInputs.delete(message.id);this.hostScheduled.delete(message.id);if(hostInputTerminal(this.storage.read().hostMessages?.[message.id]??''))void this.pump().catch(error=>this.error(error));});
    }
    for(const task of this.rows('task')) {
      try{
      const meeting=this.rows('meeting').find(m=>m.id===task.meetingId);if(meeting?.coordinatorDeviceId!==s.deviceId)continue;
      const continuation=task.continueRequest as {text?:string;followups?:unknown[]}|undefined;
      if(task.stopRequested&&!continuation){controlJobs.push(this.background('task-checks:'+task.id,()=>this.stopChecks(undefined,task.id)));continue;}
      if((task.status==='stopped'||(task.stopRequested||Number(task.scopeVersion??0)>Number((task.delivery as {scopeVersion?:number}|undefined)?.scopeVersion??0))&&task.exitConfirmed)&&continuation)controlJobs.push(this.background('advance:'+task.id,()=>this.send('task.control',{taskId:task.id,attemptId:task.attemptId,operation:'continue',expectedScopeVersion:Number((continuation as {expectedScopeVersion?:number}).expectedScopeVersion??0),text:continuation.text??'',followups:continuation.followups??[],inputs:(continuation as {inputs?:unknown[]}).inputs??[]},'cr:'+createHash('sha256').update(JSON.stringify([task.id,task.attemptId,continuation])).digest('hex'))));
      else if(['delivered','delivery-pending'].includes(String(task.status))&&!task.stopRequested&&Number(task.scopeVersion??0)<=Number((task.delivery as {scopeVersion?:number}|undefined)?.scopeVersion??0)&&(task.pendingFollowups as Array<{delivered:boolean;ignored?:boolean}>).some(f=>!f.delivered&&!f.ignored))
        controlJobs.push(this.background('advance:'+task.id,()=>this.send('task.control',{taskId:task.id,attemptId:task.attemptId,operation:'advance'},'ad:'+createHash('sha256').update(JSON.stringify([task.id,task.attemptId,task.pendingFollowups])).digest('hex'))));
      // A verified flag with a mismatched binding needs explicit recovery;
      // automatic checks must not repeatedly attempt to re-review that history.
      else if(task.resource==='repository'&&task.status==='delivered'&&task.integration!=='verified'&&(s.projectChecks?.[String(task.projectId)]??[]).length) {
        const commit=(task.delivery as {commit?:string})?.commit;const key=task.id+':'+commit+':'+String(task.integration)+':'+this.dependencySignature(task);if(!commit||this.integrationScheduled.has(key))continue;
        this.integrationScheduled.add(key);
        const job=this.enqueueIntegration(task);
        void job.catch(error=>this.error(error,task,'integration'));
      }
      }catch(error){await this.error(error,task);}
    }
    for(const meeting of this.rows('meeting').filter(m=>m.coordinatorDeviceId===s.deviceId&&m.planApproved)) {
      const plan=(meeting.plan??[]) as Array<Record<string,unknown>>;
      for(const proposed of plan) {
        const existing=this.rows('task').find(t=>t.meetingId===meeting.id&&(proposed.planTaskId?t.planTaskId===proposed.planTaskId:t.title===proposed.title&&t.objective===proposed.objective&&t.parentTaskId===proposed.parentTaskId));
        if(existing)continue;
        const eligible=this.rows('device').filter(d=>d.id===proposed.targetDeviceId&&(meeting.members as string[]).includes(d.id)&&d.online&&d.acceptingTasks&&!d.revoked
          &&(d.agents as Array<{agentId:string;available:boolean}>).some(a=>a.agentId===proposed.agentId&&a.available)
          &&((proposed.inputs??[]) as GitFileReference[]).every(ref=>{const project=this.rows('project').find(p=>(p.repository as {canonicalUrl?:string})?.canonicalUrl===ref.repository);return project&&this.rows('binding').some(b=>b.projectId===project.id&&b.deviceId===d.id&&b.state==='ready');})
          &&(!proposed.projectId||this.rows('binding').some(b=>b.projectId===proposed.projectId&&b.deviceId===d.id&&b.state==='ready')));
        if(!eligible.length)continue;
        if(dependencyWait(this.storage.read().snapshot,meeting.id,proposed))continue;
        if(pendingBaseRevisions(this.storage.read().snapshot,meeting).some(r=>r.planTaskId===proposed.planTaskId))continue;
        controlJobs.push(this.background('assignment:'+meeting.id+':'+String(proposed.planTaskId??JSON.stringify(proposed)),async()=>{try{
          await this.prepareAssignment(proposed);
          await this.send('task.create',{...proposed},'dispatch:'+createHash('sha256').update(JSON.stringify([meeting.id,proposed])).digest('hex'));
        }catch(error){throw error;}})); // A waiting preparation owns only its assignment.
      }
    }
    for(const approval of this.rows('approval')) {
      const decide=this.approvals.get(approval.id);
      if(decide && (approval.decision==='allow'||approval.decision==='deny')) {this.approvals.delete(approval.id);decide(approval.decision);}
    }
    for(const task of this.rows('task').filter(t=>t.targetDeviceId===s.deviceId)) {
      controlJobs.push(this.background('admission:'+task.id+':'+String(task.attemptId),async()=>{try{
      const key=task.id+':'+String(task.attemptId); let receipt=this.storage.read().receipts[task.id];
      if(task.stopRequested && this.active.has(key)) {
        for(const approval of this.rows('approval').filter(a=>a.taskId===task.id)) {this.approvals.get(approval.id)?.('deny');this.approvals.delete(approval.id);}
        controlJobs.push(this.background('execution:'+String(task.attemptId),()=>this.stopLocal(task)));
        return;
      }
      if(task.stopRequested && !this.active.has(key) && receipt?.exitConfirmed) {
        if(receipt.turnOutcome==='completed'&&(receipt.status==='executed'||receipt.status==='delivery-pending'&&task.retryDelivery&&task.retryDelivery!==receipt.retryDelivery)){if(task.retryDelivery)await this.taskReceipt(task,{retryDelivery:String(task.retryDelivery)});controlJobs.push(this.background('delivery:'+key,()=>this.deliverTask(task,receipt!)));}
        return;
      }
      if(task.stopRequested && !this.active.has(key) && (!receipt || !receipt.executionInvoked)) {
        if(!receipt) {
          await this.storage.update(state=>{state.receipts[task.id]={taskId:task.id,attemptId:String(task.attemptId),status:'stopped',bindingRevision:0,output:[],exitConfirmed:true};});
          await this.taskEvent(task,'stopped',true);
          // The request was never accepted; its durable local non-execution is
          // reported through receipt only after the Hub's stop boundary.
        } else {await this.taskReceipt(task,{status:'stopped',turnOutcome:'interrupted',exitConfirmed:true}); await this.taskEvent(task,'stopped',true,{turnOutcome:'interrupted'});}
        return;
      }
      if(task.status==='offered' && (!receipt || receipt.attemptId!==task.attemptId)) {
        if(!s.config.acceptingTasks || task.stopRequested) return;
        if(receipt&&(this.deliveries.has(task.id+':'+receipt.attemptId)||Object.values(receipt.gitOperations??{}).some(g=>!g.exitConfirmed)))return;
        try {
          const revision=await this.authorize(task);
          await this.storage.update(state=>{const previous=state.receipts[task.id];if(previous?.gitOperations)(state.gitHistory??={})[previous.attemptId]=previous.gitOperations;state.receipts[task.id]={...previous,gitOperations:undefined,taskId:task.id,attemptId:String(task.attemptId),status:'received',turnOutcome:undefined,stopRequested:false,deliveryError:undefined,bindingRevision:revision,output:[],finalSummary:undefined,finalText:undefined,fullTextVerified:undefined,textArtifact:undefined,nativeRpcError:undefined,exitConfirmed:false,taskSnapshot:task,executionInvoked:false,verification:undefined,delivery:undefined,publication:undefined};});
          receipt=this.storage.read().receipts[task.id];
        } catch(error) {await this.error(error,task);return;}
      }
      if(!receipt || receipt.attemptId!==task.attemptId || this.active.has(key)) return;
      if(receipt.status==='received') {
        await this.send('task.receipt',{taskId:task.id,attemptId:task.attemptId,bindingRevision:receipt.bindingRevision},'r:'+key);
        if(task.resource!=='native' && this.usedSlots()>=s.config.maxConcurrency) return;
        if(task.resource!=='native')this.startingTasks.add(key);
        try{const handle=await this.startTask(task,receipt);if(handle&&!this.storage.read().receipts[task.id]?.exitConfirmed)this.active.set(key,handle);}finally{this.startingTasks.delete(key);}
      } else if(receipt.status==='delivery-pending' && task.retryDelivery && task.retryDelivery!==receipt.retryDelivery) {
        await this.taskReceipt(task,{retryDelivery:String(task.retryDelivery)});controlJobs.push(this.background('delivery:'+key,()=>this.deliverTask(task,receipt!)));
      } else if(receipt.status==='executed'&&receipt.exitConfirmed) {
        controlJobs.push(this.background('delivery:'+key,()=>this.deliverTask(task,receipt!)));
      }
      }catch(error){throw error;}}));
    }
    await this.settleBackground(controlJobs);
  }
  private async taskEvent(task: SharedEntity,status: string,exitConfirmed?: boolean,extra: Record<string,unknown>={}) {
    if(task.freeConversation){const mapped=status==='executed'||status==='delivered'?'completed':status==='stop-unconfirmed'?'reconcile':status;
      const current=this.rows('message').find(m=>m.id===task.id);if(['running','waiting-desktop'].includes(mapped)&&(current?.stopRequested||current?.exitConfirmed))return;
      const {nativeTurnId,output,turnOutcome}=extra;await this.send('message.event',{messageId:task.id,status:mapped,...(exitConfirmed===undefined?{}:{exitConfirmed}),...(turnOutcome?{turnOutcome}:{}),...(nativeTurnId?{nativeTurnId}:{}),...(output?{output}:{})});return;}
    if(status==='running'&&(this.rows('task').find(t=>t.id===task.id)?.stopRequested||this.storage.read().receipts[task.id]?.stopRequested))return;
    const payload={taskId:task.id,attemptId:task.attemptId,status,...(exitConfirmed===undefined?{}:{exitConfirmed}),...extra};
    await this.send('task.event',payload,['stop-unconfirmed','reconcile'].includes(status)?'task-check:'+createHash('sha256').update(JSON.stringify(payload)).digest('hex'):undefined);
  }
  private async startTask(task: SharedEntity,receipt: LocalReceipt,attach=false,alreadyRunning=false): Promise<ExecutionHandle|undefined> {
    const latest=()=>this.rows(task.freeConversation?'message':'task').find(t=>t.id===task.id);
    if(!attach&&(this.closing||latest()?.stopRequested||this.storage.read().receipts[task.id]?.stopRequested))return;
    if(!alreadyRunning)await this.authorize(task);const state=this.storage.read();let cwd: string;
    if(task.resource==='native') {
      const row=this.nativeRows.get(String(task.nativeSessionId));
      if(attach&&receipt.cwd)cwd=receipt.cwd;
      else {if(!row || row.projectId!==task.projectId) throw new Error('原生目录尚未核对，请在执行设备刷新已授权目录');
        cwd=await trustedDirectory(state.directories[String(task.projectId)].root,String(row.cwd));}
    } else if(task.resource==='repository') {
      const binding=state.bindings[String(task.projectId)];
      cwd=await prepareRepository(binding.localRepoRoot,binding.taskWorkspaceRoot,task.id,String(task.baseCommit),receipt.cwd);
      const project=this.rows('project').find(p=>p.id===task.projectId);if(!receipt.cwd&&project?.repoSubdirectory)cwd=join(cwd,String(project.repoSubdirectory));
      const access=this.access();const request={projectId:String(task.projectId),taskId:task.id,attemptId:String(task.attemptId),agentId:String(task.agentId),baseCommit:String(task.baseCommit),requiredPermission:task.permission as 'read-only'|'workspace-write',executionMode:'worker' as const};
      const grant=await access.resolveAuthorizedWorkspace(request);if(!grant.ok) throw new Error(grant.error.message);
      const verified=await access.validateWorkspaceForExecution({authorizationRef:grant.value.authorizationRef,taskId:task.id,attemptId:String(task.attemptId),workspacePath:cwd,baseCommit:String(task.baseCommit),bindingRevision:grant.value.bindingRevision,effectiveAgentPermission:request.requiredPermission});
      if(!verified.ok) throw new Error(verified.error.message);assertExecutableWorkspace(verified.value);
    } else {
      const root=task.resource==='directory'?state.directories[String(task.projectId)].workspaceRoot:join(app.getPath('userData'),'collaboration','text-workspaces');
      await mkdir(root,{recursive:true});cwd=receipt.cwd??join(root,task.id);await mkdir(cwd,{recursive:true});cwd=await trustedDirectory(root,cwd);
    }
    await this.taskReceipt(task,{cwd});
    if(task.resource==='native'&&!attach&&!receipt.nativeBaseline) {
      try{await this.taskReceipt(task,{nativeBaseline:{head:await git(cwd,['rev-parse','HEAD']),status:await git(cwd,['status','--porcelain']),diff:(await git(cwd,['diff','HEAD','--'])).slice(0,64000)}});}catch{}
    }
    const key=task.id+':'+String(task.attemptId);
    if(task.resource!=='native'&&!this.canLease(cwd,key)){await this.taskEvent(task,'waiting-slot');return;}
    let objective=String(task.objective)+(task.attemptInstructions?'\n'+String(task.attemptInstructions):'');
    if(task.agentId==='codex'&&!task.freeConversation)objective='这是已经通过会议业务计划批准、由本设备持久接收的任务。按以下目标在本轮交付完整成果和必要核验。业务计划无需再次申请批准；工具、文件和权限审批仍严格遵守原有策略。若目标要求纯文字，直接交付完整正文。\n任务目标：\n'+objective;
    const inputs=task.inputs as GitFileReference[];
    let inputImages:string[]=[];
    if(task.resource==='text'&&inputs?.length){const prepared=await prepareMeetingInput({id:task.id,revision:task.revision,text:objective,attachments:inputs},state,join(cwd,'inputs',String(task.attemptId)),String(task.agentId));objective=prepared.text;inputImages=prepared.images;}
    for(let index=0;task.resource!=='text'&&index<(inputs??[]).length;index++) {
      const ref=inputs[index];const project=this.rows('project').find(p=>(p.repository as {canonicalUrl?:string})?.canonicalUrl===ref.repository);
      const local=project&&state.bindings[project.id];if(!local?.confirmed||!local.allowedAgentIds.includes(String(task.agentId)))throw new Error('输入资料仓库尚未在本机授权此 Agent');
      const inputRoot=task.resource==='repository'?state.bindings[String(task.projectId)].taskWorkspaceRoot:task.resource==='native'||task.resource==='directory'?state.directories[String(task.projectId)].workspaceRoot:join(app.getPath('userData'),'collaboration','text-workspaces');
      await mkdir(inputRoot,{recursive:true});const physical=await trustedDirectory(inputRoot,inputRoot);
      const files=await materializeFiles(local.localRepoRoot,ref,join(physical,task.id+'-inputs',String(index)),physical);
      objective+='\n准确版本输入（只读参考，不自动混入代码成果）：\n'+files.join('\n');
    }
    const backend=getBackendRegistry().get(String(task.agentId));
    const handle: ExecutionHandle=task.resource==='native'?new NativeExecution(String(task.attemptId),String(task.nativeSessionId),Object.values(state.directories),
      async waiting=>{if(waiting){this.slots.delete(key);await this.taskReceipt(task,{status:'waiting-desktop'});await this.taskEvent(task,'waiting-desktop');}},
      async()=>{await this.authorize(task);if(!this.canLease(cwd,key))return false;this.slots.add(key);await this.taskReceipt(task,{status:'starting'});return true;},attach,alreadyRunning):
      task.agentId==='file-test'&&process.env.AHASTATION_ENABLE_TEST_AGENT==='1'?new FileTestExecution():
      backend?.id==='codex'&&backend.resolveBinary()?(process.platform==='win32'||process.platform==='linux'?
        new GuardedCodexExecution(String(task.attemptId),backend.resolveBinary()!,backend.buildEnv(getBackendAuth('codex')??{authMode:'oauth'}),getBackendAuth('codex')?.model):
        new CodexExecution(backend.resolveBinary()!,backend.buildEnv(getBackendAuth('codex')??{authMode:'oauth'}))):(()=>{throw new Error('该 Agent 尚未声明共享任务执行能力');})();
    // Mark starting BEFORE invoking an Agent. Restart never blindly replays it.
    await this.taskReceipt(task,{status:alreadyRunning?'running':'starting',cwd,...(!attach?{executionInvoked:false}:{}),executorPid:process.pid});
    if(task.resource!=='native'||alreadyRunning) this.slots.add(key);
    this.active.set(key,handle);
    void (async()=>{
      try {
        if(task.resource!=='native') await this.taskEvent(task,'running');
        if(!alreadyRunning)await this.authorize(task);
        if(!attach&&(this.closing||latest()?.stopRequested||this.storage.read().receipts[task.id]?.stopRequested)){await this.taskReceipt(task,{status:'stopped',turnOutcome:'interrupted',exitConfirmed:true});await this.taskEvent(task,'stopped',true,{turnOutcome:'interrupted'});handle.close();this.active.delete(key);return;}
        await this.taskReceipt(task,{executionInvoked:true});
        const result=await handle.run({objective,cwd,continuation:!!task.attemptInstructions,textOnly:task.resource==='text',images:inputImages,permission:task.permission as 'read-only'|'workspace-write',threadId:task.resource==='native'?undefined:receipt.nativeThreadId}, {
          identity:async(thread,turn)=>{await this.taskReceipt(task,{status:'running',nativeThreadId:thread,nativeTurnId:turn});await this.taskEvent(task,'running',undefined,{nativeThreadId:thread,...(turn?{nativeTurnId:turn}:{})});},
          output:async text=>{await this.taskReceipt(task,{output:[...this.storage.read().receipts[task.id].output,textSlice(text,-16000)].slice(-32)});await this.taskEvent(task,'running',undefined,{output:textSlice(text,-16000)});},
          approval:async(id,tool,description,supported)=>{
            const decision=new Promise<'allow'|'deny'>(resolve=>{this.approvals.set(id,resolve);});
            await this.send('approval.request',{taskId:task.id,attemptId:task.attemptId,approvalId:id,tool,description,supported});
            return decision;
          },
          approvalObserved:async(id,decision)=>{await this.send('approval.observed',{approvalId:id,decision});},
        });
        if(!result.exitConfirmed) {await this.taskReceipt(task,{status:'reconcile'});await this.taskEvent(task,'reconcile');return;}
        const turnOutcome=executionOutcome(result);const stopped=turnOutcome!=='completed';
        const complete=!stopped&&result.contentComplete===true;
        const full=task.resource==='text'?await preserveText(join(app.getPath('userData'),'collaboration','text-artifacts',createHash('sha256').update(this.identityKey()).digest('hex')),task.id,String(task.attemptId),result.summary,complete):undefined;
        await this.taskReceipt(task,{status:stopped?'stopped':'executed',turnOutcome,exitConfirmed:true,finalSummary:textSlice(result.summary,0,4000),finalText:full?.reference??result.fullText,fullTextVerified:complete,textArtifact:full?.manifest,nativeRpcError:result.nativeRpcError});
        handle.close();this.active.delete(key);this.slots.delete(key);
        const workspaceCommit=task.resource==='repository'?await git(cwd,['rev-parse','HEAD']):undefined;
        await this.issue('execution:'+String(task.attemptId));
        await this.taskEvent(task,stopped?'stopped':'executed',true,{turnOutcome,output:textSlice(result.summary,-16000),...(workspaceCommit?{workspaceCommit}:{})});
        if(!stopped&&!task.freeConversation) await this.deliverTask(task,this.storage.read().receipts[task.id],result.summary);
      } catch(error) {
        const current=this.storage.read().receipts[task.id];
        if(current.attemptId===task.attemptId&&!current.exitConfirmed)await this.taskReceipt(task,{status:current.executionInvoked?'reconcile':'received'});
        if(current.exitConfirmed||!current.executionInvoked){handle.close();this.active.delete(key);this.slots.delete(key);}await this.error(error,task);
      }
      finally {if(this.storage.read().receipts[task.id]?.exitConfirmed)this.slots.delete(key);this.changed();setTimeout(()=>{void this.pump().catch(error=>this.error(error));},0);}
    })();
    return handle;
  }
  private usedSlots(excluding?:string): number {
    const occupied=new Set([...this.slots,...this.startingTasks]);
    for(const [id,check] of Object.entries(this.storage.read().checks??{}))if(!check.exitConfirmed)occupied.add('check:'+id);
    for(const r of Object.values(this.storage.read().receipts))if(r.status==='reconcile'&&!r.exitConfirmed)occupied.add(r.taskId+':'+r.attemptId);
    if(excluding)occupied.delete(excluding);return occupied.size;
  }
  private inputContext(message:SharedEntity):string{return message.route==='agent'?JSON.stringify(['discussion',message.meetingId,message.targetDeviceId,message.targetAgentId]):JSON.stringify(['host',message.meetingId]);}
  private contextBusy(message:SharedEntity):boolean{
    const state=this.storage.read(),context=this.inputContext(message);
    return Object.entries(state.hostMessages??{}).some(([id,status])=>id!==message.id&&!hostInputTerminal(status)&&(state.inputContexts?.[id]??this.rows('message').filter(m=>m.id===id).map(m=>this.inputContext(m))[0])===context)
      ||[...this.executingInputs].some(id=>id!==message.id&&this.rows('message').some(m=>m.id===id&&this.inputContext(m)===context));
  }
  private async checkpointHost(meetingId:string,id:string,status:HostInputStatus,thread?:string,failure?:HostInputFailure,requirePublished=false){
    const message=this.rows('message').find(m=>m.id===id);
    if(status==='completed')await this.clearBusinessError({id,revision:0,meetingId});
    await this.storage.update(state=>{(state.hostMessages??={})[id]=status;if(message)(state.inputContexts??={})[id]=this.inputContext(message);if(failure)(state.hostFailures??={})[id]=failure;if(thread)(state.hostThreads??={})[meetingId]=thread;
      if(message?.route==='host'&&(status==='preparing'||status==='starting')&&!state.hostPlanBases?.[id]){const meeting=state.snapshot.entities.meeting?.find(m=>m.id===meetingId);(state.hostPlanBases??={})[id]={version:Number(meeting?.planVersion??0),decisionVersion:Number(meeting?.planDecisionVersion??0)};}
    });
    if(message?.executionStatus==='stopped')return;
    try{await this.send('message.event',{messageId:id,status:status==='starting'?'running':status,exitConfirmed:hostInputTerminal(status),...(failure?{output:textSlice(failure.message,0,16000),notStarted:failure.notStarted}:{})},'host-state:'+createHash('sha256').update(JSON.stringify([id,status,failure])).digest('hex'));}catch(error){if(requirePublished)throw error;}finally{this.changed();}
  }
  private discuss(meeting:SharedEntity,message:SharedEntity):Promise<void> {
    this.executingInputs.add(message.id);
    const member=meeting.id+':'+String(message.targetAgentId);
    const job=(this.discussionQueues.get(member)??Promise.resolve()).then(async()=>{
      const agent=String(message.targetAgentId);let invoked=false;let handle:ExecutionHandle|undefined;
      try {
        await this.checkpointHost(meeting.id,message.id,'preparing',undefined,undefined,true);
        this.authorizeDiscussion(message);
        handle=this.discussionExecution(message);this.discussions.set(message.id,handle);
        const cwd=join(app.getPath('userData'),'collaboration','discussion',meeting.id,agent);await this.prepareDiscussionDirectory(cwd);
        const prepared=await this.prepareDiscussionInput(message,cwd,agent);
        this.authorizeDiscussion(message);
        await this.checkpointHost(meeting.id,message.id,'starting',undefined,undefined,true);
        this.authorizeDiscussion(message);invoked=true;
        const result=await handle.run({cwd,permission:'read-only',textOnly:true,images:prepared.images,threadId:this.storage.read().discussionThreads?.[member],objective:'你是被明确点名的会议专家，只讨论，不主持、不派任务、不读取本机项目或执行命令。工作中的 Worker 是独立上下文；这里不代表你知道其完整实时状态。需要文件时请要求明确授权与共享资料。\n会议必要背景：'+JSON.stringify(boundedMeetingContext(this.storage.read().snapshot,meeting.id))+'\n本次点名：'+prepared.text}, {
          identity:async thread=>{await this.storage.update(state=>{(state.discussionThreads??={})[member]=thread;});},output:async()=>{},approval:async()=> 'deny',
        });
        if(!result.exitConfirmed)throw new Error('讨论轮次退出未确认，原输入保留等待核对');
        if(result.turnOutcome==='failed')throw new Error(result.summary||'原生讨论轮次失败，保留原结果待核对');
        await this.discussionReply(meeting,message,result.summary,result.stopped===true);
        await this.storage.update(state=>{state.hostMessages![message.id]='completed';});
      }catch(error){await this.checkpointHost(meeting.id,message.id,invoked?'reconcile':'failed',undefined,{message:error instanceof Error?error.message:String(error),notStarted:!invoked});throw error;}
      finally{handle?.close();this.discussions.delete(message.id);}
    }).finally(()=>{this.hostScheduled.delete(message.id);this.executingInputs.delete(message.id);if(hostInputTerminal(this.storage.read().hostMessages?.[message.id]??''))void this.pump().catch(error=>this.error(error));});this.discussionQueues.set(member,job.catch(()=>{}));return job;
  }
  private authorizeDiscussion(message:SharedEntity){
    const s=this.storage.read();if(this.closing||this.rows('message').find(m=>m.id===message.id)?.stopRequested)throw new Error('本轮讨论已在启动前停止，未创建执行');
    if(message.targetDeviceId!==s.deviceId||!s.allowedAgents.includes(String(message.targetAgentId))||this.rows('device').some(d=>d.id===s.deviceId&&d.revoked))throw new Error('本机尚未授权此 Agent 参与共享讨论，或授权已撤销');
  }
  private discussionExecution(message:SharedEntity):ExecutionHandle{
    const agent=String(message.targetAgentId),backend=getBackendRegistry().get(agent),binary=backend?.resolveBinary();
    if(agent!=='codex'||!binary||!backend)throw new Error('该 Agent 尚未提供跨设备讨论适配');
    return new GuardedCodexExecution(message.id,binary,backend.buildEnv(getBackendAuth(agent)??{authMode:'oauth'}),getBackendAuth(agent)?.model);
  }
  private prepareDiscussionDirectory(cwd:string){return mkdir(cwd,{recursive:true});}
  private prepareDiscussionInput(message:SharedEntity,cwd:string,agent:string){return prepareMeetingInput(message,this.storage.read(),join(cwd,'inputs',message.id),agent);}
  private async discussionReply(meeting:SharedEntity,message:SharedEntity,summary:string,stopped=false){
    await this.send('message.send',{meetingId:meeting.id,text:textSlice(summary,-16000)||'本轮讨论已停止。',replyTo:message.id,targetDeviceId:message.targetDeviceId,targetAgentId:message.targetAgentId},'discussion:'+message.id);
    if(message.consultation&&!stopped)await this.send('message.send',{meetingId:meeting.id,text:'受邀专家咨询结果（只供 Host 统筹，不直接派活）：\n'+textSlice(summary,-12000),consultationId:message.id},'consultation:'+message.id);
    await this.send('message.event',{messageId:message.id,status:stopped?'stopped':'completed',exitConfirmed:true,turnOutcome:stopped?'interrupted':'completed'},'discussion-done:'+message.id);
  }
  private async proposeHostPlan(meeting:SharedEntity,tasks:Array<Record<string,unknown>>,inputId:string,brief?:import('../meeting-tools.js').MeetingPlanBrief){
    const basis=this.storage.read().hostPlanBases?.[inputId];
    if(!basis)throw new Error('HOST_PLAN_BASIS_MISSING：旧轮次未保存计划依据，请基于当前完整计划明确提出新建议');
    const payload={meetingId:meeting.id,tasks,expectedPlanVersion:basis.version,expectedPlanDecisionVersion:basis.decisionVersion,...(brief?{brief}:{})};
    const digest=createHash('sha256').update(canonicalJson(payload)).digest('hex');
    await this.storage.update(state=>{const previous=state.hostPlanProposals?.[inputId];if(previous&&previous!==digest)throw new Error('MULTIPLE_PROPOSALS_FOR_INPUT：同一输入出现不同提案，本轮未重放第二份；请汇总为包含已分发工作的完整计划后明确重提');(state.hostPlanProposals??={})[inputId]=digest;});
    try{await this.send('plan.propose',payload,'hp:'+inputId);}
    catch(error){
      const failure=rejectedHostPlan(error);
      if(failure)await this.storage.update(state=>{(state.hostFailures??={})[inputId]=failure;});
      if(error instanceof CollaborationHttpError&&(failure||[409,426].includes(error.status)))await this.send('message.send',{
        meetingId:meeting.id,
        text:(failure?.message??'本轮提案未确认应用：'+(error.code??'LEGACY_REJECTION')+' · '+error.message)+'。原计划、已接工作与输入保留。',
        replyTo:inputId,
      },'hp-conflict:'+inputId).catch(()=>{});
      throw error;
    }
  }
  private coordinator(meeting:SharedEntity):SharedCoordinator|UnifiedMeetingHost {
    const existing=this.hosts.get(meeting.id);if(existing)return existing;
    if(meeting.hostAuthority==='original-orchestrator') {
      const host=new UnifiedMeetingHost(meeting,()=>boundedMeetingContext(this.storage.read().snapshot,meeting.id),join(app.getPath('userData'),'collaboration','original-hosts',meeting.id),{
        reply:async(text,inputId)=>{await this.send('message.send',{meetingId:meeting.id,text,replyTo:inputId},'hr:'+inputId);},
        plan:(tasks,inputId,brief)=>this.proposeHostPlan(meeting,tasks,inputId,brief),
        checkpoint:(id,status,thread,failure)=>this.checkpointHost(meeting.id,id,status,thread,failure),
        prepareInput:(message,folder)=>prepareMeetingInput(message,this.storage.read(),join(folder,'inputs',message.id),String(meeting.hostAgentId??'codex')),
        session:async value=>{await this.storage.update(s=>{(s.originalHostSessions??={})[meeting.id]=value;});},
        consult:async(id,text,inputId)=>{const member=((this.rows('meeting').find(m=>m.id===meeting.id)?.participants??[]) as Array<{deviceId:string;agentId:string}>).find(m=>'member-'+m.deviceId+'-'+m.agentId===id);if(!member)throw new Error('请选择准确的设备与 Agent');return this.send('message.send',{meetingId:meeting.id,text,targetDeviceId:member.deviceId,targetAgentId:member.agentId,consultation:true},'hc:'+createHash('sha256').update(JSON.stringify([inputId,id,text])).digest('hex'));},
        control:async(id,operation,text,inputId)=>{const task=this.rows('task').find(t=>t.id===id&&t.meetingId===meeting.id);if(!task)throw new Error('任务不属于当前会议');return this.send('task.control',{taskId:id,attemptId:task.attemptId,operation,...(text?{text}:{})},'hctl:'+createHash('sha256').update(JSON.stringify([inputId,id,operation,text])).digest('hex'));},
      },this.storage.read().originalHostSessions?.[meeting.id]);this.hosts.set(meeting.id,host);return host;
    }
    const host=new SharedCoordinator(meeting,()=>{
      const snapshot=this.storage.read().snapshot;const taskIds=new Set((snapshot.entities.task??[]).filter(t=>t.meetingId===meeting.id).map(t=>t.id));
      const shared=this.rows('meeting').find(m=>m.id===meeting.id)??meeting;
      const summarize=(t:SharedEntity):SharedEntity=>({id:t.id,revision:t.revision,...Object.fromEntries(['title','status','agentId','targetDeviceId','projectId','nativeSessionId','resource','permission','dependencies','integration','integrationCommit','baseCommit','parentTaskId'].filter(k=>t[k]!==undefined).map(k=>[k,t[k]]))});
      const entities={...snapshot.entities,meeting:[{...shared,plan:((shared.plan??[]) as SharedEntity[]).map(t=>({...summarize(t),objective:textSlice(String(t.objective),0,400)}))}],history:[],message:(snapshot.entities.message??[]).filter(m=>m.meetingId===meeting.id).slice(-20).map(m=>({...m,text:textSlice(String(m.text),-1000),attachments:[]})),
        task:(snapshot.entities.task??[]).filter(t=>t.meetingId===meeting.id).slice(-48).map(t=>({...summarize(t),objective:textSlice(String(t.objective),0,500),output:[],evidence:[]})),
        native:(snapshot.entities.native??[]).filter(n=>n.meetingId===meeting.id),approval:(snapshot.entities.approval??[]).filter(a=>taskIds.has(String(a.taskId))).map(a=>({id:a.id,revision:a.revision,taskId:a.taskId,tool:a.tool,supported:a.supported,decision:a.decision,effectiveDecision:a.effectiveDecision}))};
      const materials=[...(this.storage.read().sharedFiles??[]),...(snapshot.entities.message??[]).filter(m=>m.meetingId===meeting.id).flatMap(m=>(m.attachments??[]) as GitFileReference[])];
      return {...snapshot,entities,publishedMaterials:materials.slice(-20),olderMaterialsCount:Math.max(0,materials.length-20)};
    },join(app.getPath('userData'),'collaboration','hosts',meeting.id),{
      reply:async(text,inputId)=>{await this.send('message.send',{meetingId:meeting.id,text,replyTo:inputId},'hr:'+inputId);},
      plan:(tasks,inputId)=>this.proposeHostPlan(meeting,tasks,inputId),
      checkpoint:(id,status,thread,failure)=>this.checkpointHost(meeting.id,id,status,thread,failure),
    },this.storage.read().hostThreads?.[meeting.id]);this.hosts.set(meeting.id,host);return host;
  }
  private canLease(cwd:string,key:string):boolean {
    if(this.usedSlots(key)>=this.storage.read().config.maxConcurrency)return false;
    const inside=(a:string,b:string)=>{const rel=relative(a,b);return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);};
    const own=Object.values(this.storage.read().receipts).find(r=>r.taskId+':'+r.attemptId===key)?.taskSnapshot?.nativeSessionId;
    if([...this.nativeRows.values()].some(row=>row.session_id!==own&&row.execution_status==='running'&&typeof row.cwd==='string'&&(inside(row.cwd,cwd)||inside(cwd,row.cwd))))return false;
    return !Object.values(this.storage.read().receipts).some(r=>r.taskId+':'+r.attemptId!==key&&r.cwd&&
      ((!r.exitConfirmed&&(this.slots.has(r.taskId+':'+r.attemptId)||r.status==='reconcile'))||r.status==='executed'&&r.turnOutcome==='completed'&&!r.taskSnapshot?.freeConversation||this.deliveries.has(r.taskId+':'+r.attemptId)||Object.values(r.gitOperations??{}).some(g=>!g.exitConfirmed))&&(inside(r.cwd,cwd)||inside(cwd,r.cwd)))
      &&!Object.values(this.storage.read().checks??{}).some(c=>!c.exitConfirmed&&(inside(c.cwd,cwd)||inside(cwd,c.cwd)))
      &&!Object.values(this.storage.read().receipts).filter(r=>r.taskId+':'+r.attemptId!==key).some(r=>Object.values(r.gitOperations??{}).some(g=>!g.exitConfirmed&&(inside(g.cwd,cwd)||inside(cwd,g.cwd))));
  }
  private async recoverReceipts():Promise<void> {
    const jobs:Promise<unknown>[]=[];
    for(const receipt of Object.values(this.storage.read().receipts))for(const [phase,operation] of Object.entries(receipt.gitOperations??{}))if(!operation.exitConfirmed&&!this.gitStarting.has(operation.id))jobs.push(this.background('git:'+operation.id,async()=>{
      const state=await this.helper({operation:'worker-inspect',executionId:operation.id,sealUnstarted:true});const result=state.result as Record<string,unknown>|undefined;
      if(result?.cleanup_confirmed){await this.recordDeliveryGit(receipt,phase,operation.id,result);await this.issue('git:'+operation.id);}else await this.issue('git:'+operation.id,'在途 Git 退出尚未确认，保留工作目录；不重新发布');
    }));
    for(const [id,check] of Object.entries(this.storage.read().checks??{}))if(!check.exitConfirmed)jobs.push(this.background('execution:'+id,async()=>{
      const state=await this.helper({operation:'worker-inspect',executionId:id});
      if((state.result as {cleanup_confirmed?:boolean})?.cleanup_confirmed){await this.storage.update(s=>{if(s.checks?.[id])s.checks[id].exitConfirmed=true;});await this.issue('execution:'+id);}
      else await this.issue('execution:'+id,'验证进程退出尚未确认，保留目录及名额占用');
    }));
    for(const receipt of Object.values(this.storage.read().receipts).filter(r=>r.status==='reconcile'||!r.turnOutcome&&['executed','delivery-pending'].includes(r.status)))jobs.push(this.background('execution:'+receipt.attemptId,()=>this.recoverReceipt(receipt)));
    if(this.connected)for(const [id,status] of Object.entries(this.storage.read().hostMessages??{}))if(!hostInputTerminal(status)&&!this.executingInputs.has(id))jobs.push(this.background('input:'+id,()=>this.recoverInput(id,status)));
    await this.settleBackground(jobs);
  }
  private async recoverReceipt(receipt:LocalReceipt):Promise<void>{
    const task=this.rows('task').find(t=>t.id===receipt.taskId)??receipt.taskSnapshot;if(!task||task.attemptId!==receipt.attemptId)return;
    if(task.agentId==='file-test'){
      if(!receipt.executorPid)return;
      try{process.kill(receipt.executorPid,0);return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')return;}
      // Process absence proves cleanup, not normal completion or publication.
      await this.taskReceipt(task,{status:'stopped',turnOutcome:'unknown',exitConfirmed:true});if(this.connected)await this.taskEvent(task,'stopped',true,{turnOutcome:'unknown'});return;
    }
    const state=await this.helper({operation:task.resource==='native'?'reconcile':'worker-inspect',executionId:receipt.attemptId,grants:Object.values(this.storage.read().directories)});
    const result=(task.resource==='native'?state:state.result) as {cleanup_confirmed?:boolean;cancelled?:boolean;ok?:boolean;json?:{last_message?:string};fullText?:import('./production-types.js').FullTextReference;contentComplete?:boolean;rpcError?:Record<string,unknown>;executionId?:string;turnOutcome?:unknown}|undefined;
    const key=task.id+':'+receipt.attemptId;
    if(task.resource==='native'&&state.known&&!this.active.has(key)){
      const handle=await this.startTask(task,receipt,true,!!state.turnId);if(handle)this.active.set(key,handle);return;
    }
    if(!result?.cleanup_confirmed){await this.issue('execution:'+receipt.attemptId,'原执行退出尚未确认，不重新执行或释放实际占用');return;}
    if(result.executionId!==receipt.attemptId){await this.issue('execution:'+receipt.attemptId,'原执行证据的 attempt 身份未确认；不恢复完成或释放实际占用');return;}
    const outcome=executionOutcome(result);
    const ended=outcome==='completed'?'executed':'stopped';
    const current=this.storage.read().receipts[task.id];if(current?.attemptId!==receipt.attemptId)return;
    const recoveredText=result.json?.last_message;
    await this.taskReceipt(task,{
      status:ended,turnOutcome:outcome,exitConfirmed:true,
      ...(recoveredText!==undefined?{finalSummary:recoveredText,output:[...current.output,recoveredText].slice(-32)}:{}),
      ...(result.fullText?{finalText:result.fullText}:{}),
      fullTextVerified:result.contentComplete===true,
      nativeRpcError:result.rpcError??current.nativeRpcError,
    });
    this.active.get(key)?.close();this.active.delete(key);this.slots.delete(key);
    await this.issue('execution:'+receipt.attemptId);
    if(this.connected)await this.taskEvent(task,ended,true,{turnOutcome:outcome,output:textSlice(result.json?.last_message??'',-16000)});
    if(outcome==='completed'&&!task.freeConversation&&this.connected)await this.deliverTask(task,this.storage.read().receipts[task.id]);
  }
  private async recoverInput(id:string,status:HostInputStatus):Promise<void>{
    if(this.executingInputs.has(id)||hostInputTerminal(this.storage.read().hostMessages?.[id]??''))return;
    this.hostScheduled.delete(id);
    const message=this.rows('message').find(m=>m.id===id);const meeting=this.rows('meeting').find(m=>m.id===message?.meetingId);if(!meeting||!message)return;
    if(status==='preparing'){await this.checkpointHost(meeting.id,id,'failed',undefined,{message:'Station 在输入准备期间重启；本轮执行尚未开始，原输入保留。修正后可明确重试。',notStarted:true});await this.issue('input:'+id);return;}
    if(message.route!=='agent'&&meeting.hostAgentId!=='codex')return;
    const state=await this.inspectHost(id);const result=state.result as {cleanup_confirmed?:boolean;not_started?:boolean;cancelled?:boolean;ok?:boolean;json?:{last_message?:string};error?:string;fullText?:import('./production-types.js').FullTextReference;contentComplete?:boolean}|undefined;
    if(!result?.cleanup_confirmed){await this.issue('input:'+id,'原轮次退出尚未确认，继续核对原执行');return;}
    if(result.not_started||result.ok===false&&!result.cancelled){await this.checkpointHost(meeting.id,id,'failed',undefined,{message:result.error??'本轮未完成，原输入保留；请核对后继续。',notStarted:result.not_started===true});await this.issue('input:'+id);return;}
    if(result.ok!==true&&!result.cancelled){await this.issue('input:'+id,'退出已清理，但轮次结果缺少可靠证据');return;}
    if(typeof state.threadId==='string')await this.storage.update(s=>{if(message.route==='agent')(s.discussionThreads??={})[meeting.id+':'+String(message.targetAgentId)]=String(state.threadId);else(s.hostThreads??={})[meeting.id]=String(state.threadId);});
    const failure=this.storage.read().hostFailures?.[id];
    if(message.route==='host'&&meeting.coordinatorDeviceId===this.storage.read().deviceId&&failure?.proposalRejected){
      await this.checkpointHost(meeting.id,id,'failed',undefined,failure);
      await this.issue('input:'+id);
      return;
    }
    // Complete output is needed only to replay commands. A proven rejection
    // above can settle without inventing full output from a legacy preview.
    if(!result.cancelled&&(!result.fullText||result.contentComplete!==true||!result.fullText.contentComplete)){await this.issue('input:'+id,'旧轮次仅保留历史预览，完整正文尚未证实；保留原输入和对话，请人工核对，不自动重跑或应用计划');return;}
    const output=result.fullText?(await readFullText(result.fullText)).toString('utf8'):String(result.json?.last_message??result.error??'');
    if(message.route==='agent'){
      if(message.targetDeviceId!==this.storage.read().deviceId)return;
      await this.discussionReply(meeting,message,output,result.cancelled===true);
      await this.storage.update(s=>{s.hostMessages![id]='completed';});
    }else if(meeting.coordinatorDeviceId===this.storage.read().deviceId){
      if(result.cancelled){await this.send('message.event',{messageId:id,status:'stopped',exitConfirmed:true,turnOutcome:'interrupted',output:textSlice(output,-16000)});await this.storage.update(s=>{s.hostMessages![id]='completed';});}
      else if(this.rows('message').some(m=>m.meetingId===meeting.id&&m.route==='control'&&!m.exitConfirmed&&(m.request as {operation?:string})?.operation==='stop-host')){await this.send('message.event',{messageId:id,status:'completed',exitConfirmed:true,turnOutcome:'completed',output:textSlice(output,-16000)});await this.storage.update(s=>{s.hostMessages![id]='completed';});}
      else await this.coordinator(meeting).finish(id,output);
    }
    await this.issue('input:'+id);
  }
  private inspectHost(id:string):Promise<Record<string,unknown>>{return this.helper({operation:'worker-inspect',executionId:id,sealUnstarted:true});}
  private async synchronizeReceipts():Promise<void> {
    const jobs:Promise<unknown>[]=[];
    for(const [id,status] of Object.entries(this.storage.read().hostMessages??{}))if(status==='failed'){
      const message=this.rows('message').find(m=>m.id===id);if(message)jobs.push(this.background('input:'+id,()=>this.checkpointHost(String(message.meetingId),id,status,undefined,this.storage.read().hostFailures?.[id])));
    }
    for(const receipt of Object.values(this.storage.read().receipts).filter(r=>r.exitConfirmed))jobs.push(this.background('receipt:'+receipt.attemptId,async()=>{
      const task=this.rows('task').find(t=>t.id===receipt.taskId);if(!task||task.attemptId!==receipt.attemptId||task.status==='accepted')return;
      if(task.status==='delivered'&&task.delivery){await this.taskReceipt(task,{status:'delivered',delivery:task.delivery as Record<string,unknown>});return;}
      const status=receipt.status==='stopped'?'stopped':receipt.status==='delivered'?'delivered':receipt.status==='delivery-pending'?'delivery-pending':'executed';
      await this.send('task.event',{taskId:task.id,attemptId:task.attemptId,status,exitConfirmed:true,...(receipt.turnOutcome?{turnOutcome:receipt.turnOutcome}:{}),...(receipt.delivery?{delivery:receipt.delivery}:{})},
        'ls:'+createHash('sha256').update(JSON.stringify([task.id,task.attemptId,status,receipt.delivery,receipt.turnOutcome])).digest('hex'));
    }));
    await this.settleBackground(jobs);
  }
  private async freeNative(message: SharedEntity):Promise<void> {
    const row=this.nativeRows.get(String(message.nativeSessionId));if(!row)throw new Error('该原生对话的本机目录尚未核对');
    const grant=this.storage.read().directories[String(row.projectId)];if(!grant?.confirmed)throw new Error('原生目录授权已撤销');
    const synthetic:SharedEntity={id:message.id,revision:1,agentId:'codex',resource:'native',projectId:row.projectId,permission:grant.permission,attemptId:message.id,targetDeviceId:this.storage.read().deviceId,objective:message.text,meetingId:message.meetingId,nativeSessionId:message.nativeSessionId,freeConversation:true,inputs:message.attachments??[]};
    const revision=await this.authorize(synthetic);
    const key=message.id+':'+message.id;
    const cwd=await trustedDirectory(grant.root,String(row.cwd));
    await this.storage.update(s=>{s.receipts[message.id]={taskId:message.id,attemptId:message.id,status:'received',bindingRevision:revision,cwd,output:[],taskSnapshot:synthetic};});
    await this.send('message.receipt',{messageId:message.id,nativeSessionId:message.nativeSessionId,bindingRevision:revision},'mr:'+message.id);
    const handle=await this.startTask(synthetic,this.storage.read().receipts[message.id]);if(handle)this.active.set(key,handle);
  }
  private async syncNative(): Promise<void> {
    this.scheduleNativeSync();const grants=Object.values(this.storage.read().directories).filter(g=>g.confirmed);if(!grants.length)return;
    const cycle=this.nativeCycle??={id:randomUUID(),seen:new Set<string>()};
    let result:Record<string,unknown>;
    try{result=await this.helper({operation:'scan',grants,paged:true,cursor:cycle.cursor});}catch(error){this.nativeCycle=undefined;throw error;}
    const rows=result.sessions as Array<Record<string,unknown>>;
    for(const row of rows){const id=String(row.session_id);this.nativeRows.set(id,row);cycle.seen.add(id);}
    const complete=!result.nextCursor;
    if(complete){for(const id of this.nativeRows.keys())if(!cycle.seen.has(id))this.nativeRows.delete(id);this.nativeCycle=undefined;}else cycle.cursor=result.nextCursor;
    const sessions=rows.map(row=>({sessionId:String(row.session_id),title:String(row.title??''),projectId:String(row.projectId),
      status:row.available!==true?'unavailable':row.execution_status==='running'?'busy':row.execution_status==='idle'?'idle':'unknown',executionStatus:String(row.execution_status??'unknown'),reason:String(row.error??''),
      ...(row.native_turn_id?{nativeTurnId:String(row.native_turn_id)}:{}),permission:row.permission??grants.find(g=>g.projectId===row.projectId)?.permission??'read-only'}));
    await this.send('native.catalog',{sessions,catalogId:cycle.id,complete});
    this.scheduleNativeSync();
  }
  private scheduleNativeSync(){for(const session of this.rows('native').filter(n=>n.deviceId===this.storage.read().deviceId&&n.meetingId))this.background('native-sync:'+String(session.sessionId),()=>this.syncNativeSession(session));}
  private async syncNativeSession(session:SharedEntity){
    const grants=Object.values(this.storage.read().directories).filter(g=>g.confirmed);if(!grants.length)return;
      const state=this.storage.read();const sessionId=String(session.sessionId);
      if(!this.nativeRows.has(sessionId))return;
      const turns=[...(state.stationNativeTurns?.[sessionId]??[]),...Object.values(state.receipts).filter(r=>r.nativeThreadId===sessionId&&r.nativeTurnId).map(r=>r.nativeTurnId!)];
      const saved=state.nativeHistoryCursors?.[sessionId]??{checkpoint:null};let cursor=saved.inProgress??saved.checkpoint;
      for(let page=0;page<4;page++) {
        const history=await this.helper({operation:'history',sessionId,stationTurns:turns,grants,cursor});
        const messages=history.messages as Array<Record<string,unknown>>;let batch:Array<Record<string,unknown>>=[];
        const size=(value:unknown)=>JSON.stringify(value).replace(/[^\x00-\x7f]/g,'xxxxxx').length;
        const sendBatch=async()=>{if(!batch.length)return;const payload={sessionId,messages:batch};await this.send('native.history',payload,'nh:'+createHash('sha256').update(JSON.stringify(payload)).digest('hex'));batch=[];};
        for(const message of messages) {if(batch.length>=100||size([...batch,message])>45000)await sendBatch();batch.push(message);}await sendBatch();
        const next=typeof history.nextCursor==='string'?history.nextCursor:null;
        if(next===cursor&&next!==null)throw new Error('原生历史分页游标没有前进，保留已同步内容等待核对');
        const checkpoint=cursor;
        await this.storage.update(s=>{(s.nativeHistoryCursors??={})[sessionId]=next?{checkpoint:saved.checkpoint,inProgress:next}:{checkpoint};});
        if(!next)break;cursor=next;
      }
      const task=this.rows('task').find(t=>t.nativeSessionId===session.sessionId&&t.targetDeviceId===this.storage.read().deviceId&&['running','approval'].includes(String(t.status)));
      const message=this.rows('message').find(m=>m.nativeSessionId===session.sessionId&&m.targetDeviceId===this.storage.read().deviceId&&m.executionStatus==='running'&&!m.exitConfirmed);
      if(task||message) {
        const result=await this.helper({operation:'approval-list',sessionId:session.sessionId,grants});
        for(const approval of result.approvals as Array<{id:string;tool:string;description:string;supported:boolean;turnId?:string;decided?:boolean;decision?:string}>) {
          if(approval.turnId&&approval.turnId!==(task??message)!.nativeTurnId)continue;
          let existing=this.rows('approval').find(a=>a.id===approval.id);
          if(!existing)existing=await this.send('approval.request',{...(task?{taskId:task.id,attemptId:task.attemptId}:{messageId:message!.id}),approvalId:approval.id,tool:approval.tool,description:approval.description,supported:approval.supported&&!!approval.turnId});
          if(approval.decided&&approval.decision&&!existing.effectiveDecision)await this.send('approval.observed',{approvalId:approval.id,decision:approval.decision});
          else if(!approval.decided&&existing.decision) {
            const applied=await this.helper({operation:'approval-decide',sessionId,approvalId:approval.id,decision:existing.decision,grants});
            if(applied.decided&&(applied.decision==='allow'||applied.decision==='deny'))await this.send('approval.observed',{approvalId:approval.id,decision:applied.decision});
          }
        }
      }
  }
  private async verifyDelivery(task:SharedEntity,receipt:LocalReceipt):Promise<NonNullable<LocalReceipt['verification']>> {
    const tests:NonNullable<LocalReceipt['verification']>['tests']=[];const unresolved:string[]=[];
    const criteria=(task.acceptanceCriteria??[]) as Array<{verification:{kind:string;argv?:string[]}}>;const commands=criteria.filter(c=>c.verification.kind==='command').map(c=>c.verification.argv!);
    if(!commands.length)unresolved.push('未提供可执行验收命令，需要明确人工检查；执行摘要不代表测试通过');
    if(commands.length>32)throw new Error('单项交付最多核验 32 条明确验收命令，请修订计划');
    for(const argv of commands){
      const current=this.rows('task').find(t=>t.id===task.id);if(!current||current.attemptId!==task.attemptId)throw new Error('此尝试已被替代，保留已有成果');
      if(current.stopRequested||this.storage.read().receipts[task.id]?.stopRequested){tests.push({argv,exitCode:null,output:'未运行：用户已要求停止，不启动新的测试',source:'station-verifier'});unresolved.push('停止后未启动原验收命令，不能视为测试通过');continue;}
      if(task.resource==='text'){tests.push({argv,exitCode:null,output:'纯文字任务不执行本机命令；请明确绑定项目并授权后安排文件任务',source:'station-verifier'});continue;}
      await this.authorize(task);const command=await executableCommand(argv[0],argv.slice(1));const id=randomUUID();
      if(this.rows('task').find(t=>t.id===task.id)?.stopRequested||this.storage.read().receipts[task.id]?.stopRequested){tests.push({argv,exitCode:null,output:'未运行：停止意图已保存',source:'station-verifier'});unresolved.push('验收命令未运行');continue;}
      await this.storage.update(s=>{(s.checks??={})[id]={projectId:String(task.projectId),taskId:task.id,cwd:receipt.cwd!,exitConfirmed:false};});
      if(this.rows('task').find(t=>t.id===task.id)?.stopRequested||this.storage.read().receipts[task.id]?.stopRequested){await this.storage.update(s=>{s.checks![id].exitConfirmed=true;});tests.push({argv,exitCode:null,output:'未运行：停止意图先于调用',source:'station-verifier'});unresolved.push('验收命令未运行');continue;}
      const result=await nativeHelper({operation:'worker-check',executionId:id,command,cwd:receipt.cwd,permission:task.permission});
      if(result.cleanup_confirmed)await this.storage.update(s=>{s.checks![id].exitConfirmed=true;});
      tests.push({argv,exitCode:result.cleanup_confirmed&&typeof result.exitCode==='number'?result.exitCode:null,output:textSlice(String((result.json as {last_message?:string})?.last_message??result.error??''),-Math.floor(16000/Math.max(1,commands.length))),source:'station-verifier'});
      if(!result.cleanup_confirmed)unresolved.push('验收命令真实退出待核对，保留资源占用');
    }
    const verification={tests,unresolved};await this.taskReceipt(task,{verification});return verification;
  }
  private deliverTask(task:SharedEntity,receipt:LocalReceipt,summary=receipt.finalSummary??receipt.output.join('').slice(-24000)):Promise<void>{
    const key=task.id+':'+String(task.attemptId);const existing=this.deliveries.get(key);if(existing)return existing;
    if(receipt.status==='delivered'&&receipt.delivery)return Promise.resolve();
    const job=this.performDelivery(task,receipt,summary).finally(()=>this.deliveries.delete(key));this.deliveries.set(key,job);return job;
  }
  private async performDelivery(task: SharedEntity,receipt: LocalReceipt,summary:string) {
    try {
      await this.authorizeDelivery(task,receipt);
      for(const [phase,operation] of Object.entries(this.storage.read().receipts[task.id].gitOperations??{}))if(!operation.exitConfirmed){await this.background('git:'+operation.id,async()=>{const state=await this.helper({operation:'worker-inspect',executionId:operation.id,sealUnstarted:true});const result=state.result as Record<string,unknown>|undefined;if(result?.cleanup_confirmed)await this.recordDeliveryGit(receipt,phase,operation.id,result);});}
      if(Object.values(this.storage.read().receipts[task.id].gitOperations??{}).some(g=>!g.exitConfirmed))throw new Error('在途 Git 退出尚未确认，继续核对原操作；本次不新增发布');
      const verification=receipt.verification??await this.verifyDelivery(task,receipt);
      let delivery:Record<string,unknown>;
      if(task.resource==='repository')delivery=await this.repositoryDelivery(task,receipt,summary);
      else if(receipt.publication){
        const publication=receipt.publication;const binding=this.storage.read().bindings[publication.projectId];if(!binding?.confirmed)throw new Error('资料仓库授权已撤销');
        await trustedDirectory(binding.taskWorkspaceRoot,publication.cwd);await this.authorizeDelivery(task,receipt);const ref=await pushPublication(publication,args=>this.runDeliveryGit(task,receipt,publication.cwd,args,'materials-push'));
        await this.authorizeDelivery(task,receipt);
        const prUrl=await ensurePullRequest(ref.repository,publication.branch,publication.targetBranch,
          'Station selected delivery '+task.id,summary,ref.commit,undefined,()=>this.authorizeDelivery(task,receipt));
        delivery={summary,tests:'执行详情及选定成果内的验证记录',files:ref.paths,commit:ref.commit,prUrl,branch:publication.branch,repository:ref.repository};
      }else if(task.resource==='text'){
        if(!receipt.finalText||!receipt.fullTextVerified)throw new Error('旧执行记录只有预览，完整正文尚未证明；保留原成果并在执行设备核对，不重跑Agent补正文');
        const bytes=await readFullText(receipt.finalText);const local=await preserveText(join(app.getPath('userData'),'collaboration','text-artifacts',createHash('sha256').update(this.identityKey()).digest('hex')),task.id,String(task.attemptId),bytes.toString('utf8'),receipt.finalText.contentComplete);
        await this.taskReceipt(task,{finalText:local.reference,textArtifact:local.manifest});
        if(!this.storage.read().snapshot.capabilities?.includes('text-artifacts-v1'))throw new Error('Hub尚未部署完整文字协议；本机全文保留，等待匹配升级');
        const identity=this.identityKey(),epoch=this.connectionEpoch,connection=this.connection;if(!connection)throw new Error('完整正文保留本机，等待原账号重连');
        const manifest=await uploadText(connection,local.manifest,local.reference,()=>identity===this.identityKey()&&epoch===this.connectionEpoch&&this.storage.read().receipts[task.id]?.attemptId===task.attemptId);
        summary=textSlice(bytes.toString('utf8'),0,4000);delivery={summary,summaryKind:'preview',textArtifact:manifest,tests:'实际测试见结构化报告；全文通过字节数与SHA核对',files:[],commit:'',prUrl:'',branch:''};
      }else if(task.agentId==='file-test')delivery={summary:textSlice(summary,0,4000),tests:'非文字测试适配器输出',files:[],commit:'',prUrl:'',branch:''};
      else throw new Error('执行已退出。请在执行设备检查成果范围，选择文件及已授权资料仓库后发布；原生目录已有修改将保留。');
      await this.authorizeDelivery(task,receipt);
      delivery.scopeVersion=Number(receipt.taskSnapshot?.scopeVersion??0);
      delivery.report={version:1,taskId:task.id,attemptId:task.attemptId,summary:textSlice(summary,-8000),exitConfirmed:receipt.exitConfirmed===true,files:delivery.files,commit:delivery.commit,...verification};
      await this.taskReceipt(task,{status:'delivered',delivery,deliveryError:undefined});
      await this.authorizeDelivery(task,receipt);
      await this.taskEvent(task,'delivered',true,{delivery,turnOutcome:receipt.turnOutcome});
      await this.clearBusinessError(task,'delivery');await this.clearBusinessError(task);
      await this.issue('delivery:'+task.id+':'+String(task.attemptId));
    } catch(error) {
      let workspaceCommit:string|undefined;
      if (task.resource==='repository' && this.deliveryAttemptCurrent(task,receipt)) {
        try {workspaceCommit=await git(receipt.cwd!,['rev-parse','HEAD']);} catch {}
      }
      if (!this.deliveryAttemptCurrent(task,receipt)) {
        await this.error(error,task,'delivery');
        return;
      }
      const stopped=this.storage.read().receipts[task.id].status==='stopped';
      const reason=error instanceof Error?error.message:String(error);
      await this.taskReceipt(task,{status:stopped?'stopped':'delivery-pending',deliveryError:reason});
      if (this.deliveryAttemptCurrent(task,receipt)) {
        await this.taskEvent(task,stopped?'stopped':'delivery-pending',true,{
          ...(workspaceCommit?{workspaceCommit}:{}),
          ...(receipt.turnOutcome?{turnOutcome:receipt.turnOutcome}:{}),
        });
      }
      await this.issue('delivery:'+task.id+':'+String(task.attemptId),reason);
    }
  }
  private repositoryDelivery(task:SharedEntity,receipt:LocalReceipt,summary:string){
    const authorize=()=>this.authorizeDelivery(task,receipt);
    return deliverRepository(receipt.cwd!,task.id,String(task.meetingId),summary,String(task.baseCommit),
      (repository,head,base,title,body,commit)=>ensurePullRequest(repository,head,base,title,body,commit,undefined,authorize),
      authorize,(args,phase)=>this.runDeliveryGit(task,receipt,receipt.cwd!,args,phase));
  }
  private async recordDeliveryGit(receipt:LocalReceipt,phase:string,id:string,result:Record<string,unknown>){
    await this.storage.update(s=>{const current=s.receipts[receipt.taskId];if(current?.attemptId!==receipt.attemptId)return;const saved=current.gitOperations?.[phase];if(saved?.id!==id)return;Object.assign(saved,{exitConfirmed:result.cleanup_confirmed===true,...(typeof result.exitCode==='number'?{exitCode:result.exitCode}:result.not_started?{exitCode:-1}:{})});});
    if(this.connected)void this.pump().catch(error=>this.error(error));
  }
  private async runDeliveryGit(task:SharedEntity,receipt:LocalReceipt,cwd:string,args:string[],phase:string):Promise<string>{
    await this.authorizeDelivery(task,receipt);
    let saved=this.storage.read().receipts[task.id].gitOperations?.[phase];
    if(saved&&!saved.exitConfirmed){
      await this.background('git:'+saved.id,async()=>{const state=await this.helper({operation:'worker-inspect',executionId:saved!.id,sealUnstarted:true});const result=state.result as Record<string,unknown>|undefined;if(result?.cleanup_confirmed)await this.recordDeliveryGit(receipt,phase,saved!.id,result);});
      saved=this.storage.read().receipts[task.id].gitOperations?.[phase];if(!saved?.exitConfirmed)throw new Error('原 Git 操作退出尚未确认，保留目录并核对，不重复发布');
    }
    if(saved?.exitConfirmed&&saved.exitCode===0)return '';
    const id=randomUUID(),current=this.storage.read().receipts[task.id];
    const operation={id,cwd,argv:['git','-C',cwd,...args],exitConfirmed:false,previous:saved?[...(saved.previous??[]),saved.id].slice(-20):[]};
    this.gitStarting.add(id);
    try{await this.taskReceipt(task,{gitOperations:{...current.gitOperations,[phase]:operation}});
    await this.background('git-run:'+id,async()=>{
      await this.authorizeDelivery(task,receipt);
      if(this.gitCalls>=4)await new Promise<void>(resolve=>this.gitWaiters.push(resolve));else this.gitCalls++;
      let result:Record<string,unknown>;
      try {
        await this.authorizeDelivery(task,receipt);
        result=await nativeHelper({operation:'worker-check',executionId:id,command:operation.argv,cwd,permission:'workspace-write'});
      } finally {
        const next=this.gitWaiters.shift();
        if(next)next();else this.gitCalls--;
      }
      await this.recordDeliveryGit(receipt,phase,id,result);
      if(!result.cleanup_confirmed||result.exitCode!==0)throw new Error(String(result.error??'原 Git 操作未成功或退出未知，保留成果'));
      await this.issue('git:'+id);await this.issue('git-run:'+id);
    });}finally{this.gitStarting.delete(id);}
    const result=this.storage.read().receipts[task.id].gitOperations?.[phase];if(!result?.exitConfirmed||result.exitCode!==0)throw new Error(this.storage.read().reconciliation?.['git-run:'+id]?.reason??this.storage.read().reconciliation?.['git:'+id]?.reason??'Git 交付待核对');return '';
  }
  private deliveryAttemptCurrent(task:SharedEntity,receipt:LocalReceipt):boolean {
    const state=this.storage.read();
    const current=state.snapshot.entities.task?.find(row=>row.id===task.id);
    const local=state.receipts[task.id];
    return !!task.id && typeof task.attemptId==='string' && !!task.attemptId
      && current?.attemptId===task.attemptId && !!local
      && [local,receipt].every(row=>row.taskId===task.id && row.attemptId===task.attemptId
        && (!row.taskSnapshot || row.taskSnapshot.id===task.id && row.taskSnapshot.attemptId===task.attemptId));
  }
  private async authorizeDelivery(task:SharedEntity,receipt:LocalReceipt){
    const checkEvidence=()=>{
      if (!this.deliveryAttemptCurrent(task,receipt)) {
        throw new Error('当前任务与完成收据的任务／尝试身份不一致，保留原成果；不会新增发布');
      }
      const current=this.rows('task').find(row=>row.id===task.id)!;
      const local=this.storage.read().receipts[task.id];
      if(Number(current.scopeVersion??task.scopeVersion??0)!==Number(receipt.taskSnapshot?.scopeVersion??0)) {
        throw new Error('原成果属于旧范围版本；保留原成果，明确继续当前范围后再交付，不重跑原尝试');
      }
      if (!local.exitConfirmed || local.turnOutcome!=='completed'
        || !receipt.exitConfirmed || receipt.turnOutcome!=='completed') {
        throw new Error('原轮次未证明正常结束，保留本机部分成果；不会新增发布');
      }
      if (current.stopRequested || local.stopRequested) {
        throw new Error('用户已要求停止，保留已完成结果；明确继续前不会新增发布');
      }
    };
    checkEvidence();
    if(this.rows('device').some(d=>d.id===this.storage.read().deviceId&&d.revoked))throw new Error('本机设备授权已撤销，成果保留');
    const s=this.storage.read();if(!s.allowedAgents.includes(String(task.agentId)))throw new Error('原 Agent 本机授权已撤销，成果保留');
    if(task.resource==='repository'){
      const binding=s.bindings[String(task.projectId)],project=this.rows('project').find(p=>p.id===task.projectId);
      if(!binding?.confirmed||!binding.allowedAgentIds.includes(String(task.agentId))||binding.revision!==receipt.bindingRevision)throw new Error('原成果项目授权已变化，请在原设备核对');
      await trustedDirectory(binding.taskWorkspaceRoot,receipt.cwd!);
      if(normalizeGithubRepository(await git(receipt.cwd!,['remote','get-url','origin'])).canonicalUrl!==(project?.repository as {canonicalUrl?:string})?.canonicalUrl)throw new Error('原成果仓库身份已变化，保留文件');
    }else if(task.resource==='directory'||task.resource==='native'){
      const grant=s.directories[String(task.projectId)];if(!grant?.confirmed||!grant.allowedAgentIds.includes(String(task.agentId))||grant.revision!==receipt.bindingRevision)throw new Error('原成果目录授权已变化');
      await trustedDirectory(task.resource==='native'?grant.root:grant.workspaceRoot,receipt.cwd!);
    }
    // Directory and Git identity checks yield; the attempt may change meanwhile.
    checkEvidence();
  }
  async action(action: string,p: Record<string,unknown>={}): Promise<unknown> {
    if(action==='status') return this.view();
    if(!this.localReady)throw new Error(this.loadError??'本机协作记录尚未安全加载，请保留原文件并稍后重试');
    if(action==='github.status') {
      try{const result=await runFile('git',['credential-manager','github','list']);return {available:true,message:result.trim()?'GitHub 本机已有身份：'+result.trim():'尚未检测到 GitHub 身份，可在文件协作时登录'};}
      catch{try{await runFile('gh',['auth','status']);return {available:true,message:'GitHub CLI 本机已登录'};}catch{return {available:false,message:'尚未检测到本机 GitHub 登录；可使用 Git for Windows 凭证管理器或 GitHub CLI'};}}
    }
    if(action==='github.login') {
      try{await runFile('git',['credential-manager','github','login','--browser']);return {message:'GitHub 本机登录已完成，请核验所选仓库访问权限'};}
      catch{throw new Error('本机浏览器登录尚未完成。请在执行设备使用 Git for Windows 凭证管理器登录后重新检测；纯文字参会无需此步骤');}
    }
    if(action==='connect') {
      this.closing=false;
      await this.connect();return this.view();
    }
    const account=getRemoteControlSettings(),stored=this.storage.read();
    if(account.enabled&&stored.ownerId&&(stored.ownerId!==account.ownerId||stored.serviceUrl!==account.serviceUrl))throw new Error('协作账号或服务正在切换，请连接当前账号后重试；原输入草稿保留');
    if(action==='meeting.migrate') {
      const meeting=this.rows('meeting').find(m=>m.id===p.meetingId);if(!meeting||meeting.coordinatorDeviceId!==this.storage.read().deviceId)throw new Error('请在原协调设备核验旧 Host 恢复点');
      if(this.rows('task').some(t=>t.meetingId===meeting.id&&!['stopped','delivered','accepted'].includes(String(t.status))))throw new Error('原在途任务须先完成或停止核对，不能重建任务代替迁移');
      if(!await this.hosts.get(meeting.id)?.stop()&&this.hosts.has(meeting.id))throw new Error('原 Host 实际退出未确认');
      for(const [id,status] of Object.entries(this.storage.read().hostMessages??{}))if(!hostInputTerminal(status)&&this.rows('message').some(m=>m.id===id&&m.meetingId===meeting.id)){
        const result=await nativeHelper({operation:'worker-stop',executionId:id});if(!result.cleanup_confirmed)throw new Error('原 Host 轮次仍待核对，保留恢复记录');
        await this.storage.update(s=>{s.hostMessages![id]='completed';});
      }
      const result=await this.send('meeting.migrate',{meetingId:meeting.id,expectedRevision:meeting.revision});this.hosts.get(meeting.id)?.close();this.hosts.delete(meeting.id);return result;
    }
    if(action==='device.reactivate') {
      const confirm=await dialog.showMessageBox({type:'question',buttons:['重新接入本机','返回'],defaultId:1,cancelId:1,message:'正常登录后恢复本机设备凭据／授权',detail:'这是明确的凭据恢复操作。保留原设备身份、任务、对话、成果和旧密文。接收会关闭，Agent与项目授权需在本机重新确认；不会恢复遗失的旧加密键。'});
      if(confirm.response!==0)return {cancelled:true};
      const state=this.storage.read();const account=getRemoteControlSettings(),identity=this.identityKey(),epoch=this.connectionEpoch;
      const current=()=>identity===this.identityKey()&&epoch===this.connectionEpoch&&getRemoteControlSettings().ownerId===account.ownerId&&getRemoteControlSettings().serviceUrl===account.serviceUrl;
      if(!account.controlToken||!account.serviceUrl||!account.ownerId||account.credentialInvalid)throw new Error('请先正常登录协作账号');
      if(this.active.size||this.discussions.size||this.executingInputs.size||Object.values(state.receipts).some(r=>r.executionInvoked&&!r.exitConfirmed||Object.values(r.gitOperations??{}).some(g=>!g.exitConfirmed)))throw new Error('请先在本机核对旧执行与Git实际退出，再明确恢复凭据；不自动停止或丢弃任务');
      await this.storage.update(s=>{s.config.acceptingTasks=false;s.allowedAgents=[];for(const grant of Object.values(s.bindings))grant.confirmed=false;for(const grant of Object.values(s.directories))grant.confirmed=false;});await this.probe();
      await this.storage.update(s=>{s.credentialRecoveryRequestId??=randomUUID();s.credentialRecoveryConfig??=s.config;});const recovery=this.storage.read();
      const response=await collaborationFetch(account.serviceUrl+'/api/collaboration/v2/commands',{method:'POST',headers:{Authorization:'Bearer '+account.controlToken,'Content-Type':'application/json'},body:JSON.stringify(parseSharedCommand({protocol:2,requestId:recovery.credentialRecoveryRequestId!,action:'device.register',payload:{deviceId:state.deviceId,config:recovery.credentialRecoveryConfig!,reactivate:true}})),signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error('原执行尚未完成清理或账号不可用，暂不能重新接入');
      const result=await response.json() as {value:{deviceToken:string}};if(!current())throw new Error('协作身份已变化，请在原账号核对设备接入');await this.saveDeviceCredential(result.value.deviceToken,account.ownerId,account.serviceUrl,current,true);await this.storage.update(s=>{if(!current())return;s.registrationRequestId=undefined;s.registrationConfig=undefined;s.credentialRecoveryRequestId=undefined;s.credentialRecoveryConfig=undefined;});
      this.closing=false;await this.connect();return this.view();
    }
    if(action==='probe') {await this.probe();if(this.connected) await this.publishConfig();return this.view();}
    if(action==='configure') {
      const config=parseContract('deviceConfig',p.config);const allowed=p.allowedAgents;
      if(!Array.isArray(allowed)||!allowed.every(id=>typeof id==='string'&&this.probes.some(probe=>probe.agentId===id))) throw new Error('请选择实际检测到的 Agent');
      const removed=this.storage.read().allowedAgents.filter(id=>!allowed.includes(id));
      await this.storage.update(s=>{s.config=config;s.allowedAgents=allowed;});for(const [id] of this.discussions)if(removed.includes(String(this.rows('message').find(m=>m.id===id)?.targetAgentId))){const message=this.rows('message').find(m=>m.id===id);if(message)this.background('input:'+id,()=>this.stopMessage(message));}
      if(removed.length){for(const task of this.localTasks().filter(t=>removed.includes(String(t.agentId)))){this.background('execution:'+String(task.attemptId),()=>this.stopLocal(task));void this.stopChecks(undefined,task.id);}this.stopDeliveryGit(undefined,removed);}
      await this.probe();if(this.connected) await this.publishConfig();this.changed();await this.pump();return this.view();
    }
    if(action==='project.create') {
      if(p.resourceKind==='directory'||p.resourceKind==='text') return this.send('project.create',{config:{name:p.name,resourceKind:p.resourceKind}});
      const config=parseContract('projectConfig',{name:p.name,repository:normalizeGithubRepository(String(p.repository)),...(p.repoSubdirectory?{repoSubdirectory:p.repoSubdirectory}:{})});
      return this.send('project.create',{config});
    }
    if(action==='project.clone') {
      const project=this.rows('project').find(row=>row.id===p.projectId);if(!project?.repository)throw new Error('请选择用户指定的 GitHub 项目');
      const parent=await dialog.showOpenDialog({title:'确认仓库克隆位置的父目录',properties:['openDirectory','createDirectory']});if(parent.canceled)return {cancelled:true};
      const repository=(project.repository as {canonicalUrl:string}).canonicalUrl;const destination=join(parent.filePaths[0],new URL(repository).pathname.split('/').pop()!);
      const confirmation=await dialog.showMessageBox({type:'question',buttons:['克隆到此位置','返回'],defaultId:1,cancelId:1,message:'克隆用户指定的仓库',detail:repository+'\n'+destination});
      if(confirmation.response!==0)return {cancelled:true};await runFile('git',['clone','--origin','origin',repository,destination]);
      return {directory:destination,message:'克隆完成，请绑定此副本并确认本机工作区授权'};
    }
    if(action==='files.share') {
      const identity=this.identityKey();this.accountActions++;try{
      const binding=this.storage.read().bindings[String(p.projectId)];if(!binding?.confirmed)throw new Error('资料仓库尚未在本机授权');
      const selected=await dialog.showOpenDialog({title:'只选择需要跨设备共享的文件',properties:['openFile','multiSelections']});if(selected.canceled)return {cancelled:true};
      const ref=await publishFiles(binding.localRepoRoot,binding.taskWorkspaceRoot,selected.filePaths,String(p.baseCommit));
      await this.storage.update(s=>{if(identity!==this.identityKey())throw new Error('协作身份已变化，成果保留原账户核对');(s.sharedFiles??=[]).push(ref);});
      if(p.meetingId)await this.send('message.send',{meetingId:p.meetingId,text:'已发布输入资料，请将准确版本加入本轮上下文；等待用户给出任务目标。',attachments:[ref]});return ref;

      }finally{this.accountActions--;}
    }
    if(action==='files.stage') {
      const identity=this.identityKey();this.accountActions++;try{
      const binding=this.storage.read().bindings[String(p.projectId)];if(!binding?.confirmed)throw new Error('请先选择并授权用户指定的资料仓库');
      const files=p.files as Array<{name:string;dataBase64:string;sizeBytes:number}>;
      if(!Array.isArray(files)||files.length<1||files.length>10||files.some(f=>!f||typeof f.name!=='string'||!f.name||/[\\/\x00]/.test(f.name)||f.name==='..'||f.name==='.'||typeof f.dataBase64!=='string'||f.sizeBytes>25*1024*1024)||files.reduce((n,f)=>n+f.sizeBytes,0)>50*1024*1024)throw new Error('附件范围或大小无效');
      const base=await git(binding.localRepoRoot,['rev-parse','HEAD']);
      const confirm=await dialog.showMessageBox({type:'question',buttons:['发布选定附件','返回'],defaultId:1,cancelId:1,message:'只共享本次选定附件',detail:files.map(f=>f.name).join('\n')+'\n资料仓库基线：'+base});if(confirm.response!==0)return {cancelled:true};
      const staging=join(app.getPath('userData'),'collaboration','attachments',randomUUID());await mkdir(staging,{recursive:true});const paths:string[]=[];
      for(const file of files){const bytes=Buffer.from(file.dataBase64,'base64');if(bytes.length!==file.sizeBytes)throw new Error('附件长度校验失败');const path=join(staging,file.name);await writeFile(path,bytes,{flag:'wx'});paths.push(path);}
      const ref=await publishFiles(binding.localRepoRoot,binding.taskWorkspaceRoot,paths,base);await this.storage.update(s=>{if(identity!==this.identityKey())throw new Error('协作身份已变化，成果保留原账户核对');(s.sharedFiles??=[]).push(ref);});return ref;

      }finally{this.accountActions--;}
    }
    if(action==='project.inspect') {
      const binding=this.storage.read().bindings[String(p.projectId)];if(!binding?.confirmed)return {authorized:false};
      return {authorized:true,commit:await git(binding.localRepoRoot,['rev-parse','HEAD']),root:binding.localRepoRoot};
    }
    if(action==='delivery.preview') {
      const task=this.rows('task').find(t=>t.id===p.taskId);const delivery=task?.delivery as {commit?:string;files?:string[];repository?:string}|undefined;
      if(!task||task.attemptId!==p.attemptId||delivery?.commit!==p.commit||!delivery?.files?.includes(String(p.path))||typeof p.path!=='string'||p.path.startsWith('-')||p.path.startsWith('/')||p.path.split('/').some(part=>part==='..'||part==='.'||part==='')||p.path.includes('\\')||p.path.includes('\0')||!/^([a-f0-9]{40})$/.test(String(p.commit)))throw new Error('成果版本已改变或文件不在准确交付范围');
      const project=delivery.repository?this.rows('project').find(pr=>(pr.repository as {canonicalUrl?:string})?.canonicalUrl===delivery.repository):this.rows('project').find(pr=>pr.id===task.projectId);
      const binding=project&&this.storage.read().bindings[project.id];if(!binding?.confirmed)throw new Error('此设备需先授权相同成果仓库，才能读取准确版本');
      await git(binding.localRepoRoot,['fetch','--no-tags','origin',String(p.commit)]);
      return p.diff?{text:(await git(binding.localRepoRoot,['diff',String(task.baseCommit),String(p.commit),'--',p.path])).slice(0,128000)}:previewGitFile(binding.localRepoRoot,String(p.commit),p.path);
    }
    if(action==='delivery.inspect') {
      const receipt=this.storage.read().receipts[String(p.taskId)];if(!receipt?.cwd)throw new Error('请在原执行设备核对本机成果范围');
      let current:unknown;try{current={head:await git(receipt.cwd,['rev-parse','HEAD']),status:await git(receipt.cwd,['status','--porcelain']),diff:(await git(receipt.cwd,['diff','HEAD','--'])).slice(0,64000)};}catch{current={message:'普通非 Git 任务目录，请明确选择成果文件'};}
      return {baseline:receipt.nativeBaseline,current};
    }
    if(action==='delivery.select') {
      this.accountActions++;try{
      const task=this.rows('task').find(t=>t.id===p.taskId);const receipt=task&&this.storage.read().receipts[task.id];
      if(!task||task.targetDeviceId!==this.storage.read().deviceId||!receipt?.cwd||!receipt.exitConfirmed)throw new Error('只能在原执行设备、实际退出后选择成果文件');
      const binding=this.storage.read().bindings[String(p.projectId)];if(!binding?.confirmed)throw new Error('请选择已在本机授权的资料仓库');
      await this.authorizeDelivery(task,receipt);
      if(typeof p.targetBranch!=='string'||!p.targetBranch||p.targetBranch.startsWith('-'))throw new Error('请明确指定资料仓库的成果 PR 目标分支');
      const chosen=await dialog.showOpenDialog({title:'确认成果范围：只选本次需要共享的文件',defaultPath:receipt.cwd,properties:['openFile','multiSelections']});if(chosen.canceled)return {cancelled:true};
      for(const file of chosen.filePaths)await trustedDirectory(receipt.cwd,join(file,'..'));
      const confirmed=await dialog.showMessageBox({type:'question',buttons:['确认这些文件并发布','返回'],defaultId:1,cancelId:1,message:'确认本次成果文件范围',detail:chosen.filePaths.join('\n')+'\n原有文件和修改会保留；只发布这里选定的内容。'});if(confirmed.response!==0)return {cancelled:true};
      let publication=receipt.publication;
      try {
        await publishFiles(binding.localRepoRoot,binding.taskWorkspaceRoot,chosen.filePaths,String(p.baseCommit),
          async draft=>{
            await this.authorizeDelivery(task,receipt);
            const prepared={...draft,projectId:String(p.projectId),targetBranch:String(p.targetBranch)};
            await this.taskReceipt(task,{publication:prepared});
            await this.authorizeDelivery(task,receipt);
            publication=prepared;
          },()=>this.authorizeDelivery(task,receipt));
      }
      catch(error){
        if(this.deliveryAttemptCurrent(task,receipt))await this.taskReceipt(task,{status:'delivery-pending'});
        await this.error(error,task,'delivery');
        return this.view();
      }
      // Keep the selected attempt's receipt; a fresh lookup could belong to its successor.
      await this.deliverTask(task,{...receipt,publication});
      return this.view();

      }finally{this.accountActions--;}
    }
    if(action==='delivery.fetch') {
      const task=this.rows('task').find(row=>row.id===p.taskId);const delivery=task?.delivery as {commit?:string}|undefined;
      const repository=(task?.delivery as {repository?:string})?.repository;
      const project=repository?this.rows('project').find(pr=>(pr.repository as {canonicalUrl?:string})?.canonicalUrl===repository):undefined;
      const binding=task&&this.storage.read().bindings[project?.id??String(task.projectId)];if(!binding?.confirmed||!delivery?.commit)throw new Error('成果缺少可获取的提交或本机仓库授权');
      const selected=await dialog.showOpenDialog({title:'选择成果副本父目录',properties:['openDirectory','createDirectory']});if(selected.canceled)return {cancelled:true};
      return {directory:await fetchDelivery(binding.localRepoRoot,delivery.commit,selected.filePaths[0],task!.id)};
    }
    if(action==='delivery.integrate') {
      const task=this.rows('task').find(row=>row.id===p.taskId);if(!task)throw new Error('任务不存在');
      return this.enqueueIntegration(task);
    }
    if(action==='delivery.text'){
      const task=this.rows('task').find(t=>t.id===p.taskId);const delivery=task?.delivery as {textArtifact?:import('./production-types.js').TextArtifactManifest}|undefined;
      if(!task||task.meetingId!==p.meetingId||task.attemptId!==p.attemptId||delivery?.textArtifact?.artifactId!==p.artifactId)throw new Error('所选全文不是当前会议／任务／执行尝试的准确成果');
      const manifest=delivery?.textArtifact;if(!manifest||!this.connection)throw new Error('完整文字成果尚不可获取');
      const identity=this.identityKey(),epoch=this.connectionEpoch;const value=await downloadText(this.connection,manifest,()=>identity===this.identityKey()&&epoch===this.connectionEpoch&&this.rows('task').find(t=>t.id===task.id)?.attemptId===task.attemptId,join(app.getPath('userData'),'collaboration','text-download-parts',createHash('sha256').update(identity).digest('hex')));
      await preserveText(join(app.getPath('userData'),'collaboration','downloaded-text',createHash('sha256').update(identity).digest('hex')),task.id,String(task.attemptId),value.text,true);
      return {text:value.text,byteLength:manifest.byteLength,sha256:manifest.sha256,artifactId:manifest.artifactId};
    }
    if(action==='delivery.review') {
      const task=this.rows('task').find(t=>t.id===p.taskId);if(!task||task.resource==='repository')throw new Error('代码成果需通过准确提交的组合验证流程');
      const waiting=dependencyWait(this.storage.read().snapshot,String(task.meetingId),task);
      if(waiting)throw new Error(waiting);
      const hash=deliveryHash(task);
      if(task.meetingId!==p.meetingId||task.attemptId!==p.attemptId||hash!==p.deliveryHash)throw new Error('验收弹窗对应的会议／attempt／成果已变化，原检查意见保留，请重新检查当前成果');
      if(this.rows('meeting').find(m=>m.id===task.meetingId)?.coordinatorDeviceId!==this.storage.read().deviceId)throw new Error('请在原协调设备检查成果；本机仍可提交成果和查看状态');
      const manifest=(task.delivery as {textArtifact?:import('./production-types.js').TextArtifactManifest})?.textArtifact;
      if(task.resource==='text'){if(!manifest)throw new Error('历史预览无法证明完整正文，请在原执行设备核对');await this.action('delivery.text',{taskId:task.id,meetingId:task.meetingId,attemptId:task.attemptId,artifactId:manifest.artifactId});}
      const verdict=await reviewSharedReport(task,true);if(!verdict.passed)throw new Error('结构化成果检查未通过：'+JSON.stringify(verdict.findings));
      if(typeof p.evidence!=='string'||!p.evidence.trim())throw new Error('请记录对成果内容的实际人工检查');
      if(deliveryHash(this.rows('task').find(t=>t.id===task.id)!)!==hash)throw new Error('检查期间成果变化，未应用旧验收');
      const base={taskId:task.id,attemptId:task.attemptId,evidence:p.evidence.trim(),deliveryHash:hash};const key=createHash('sha256').update(JSON.stringify(base)).digest('hex');
      await this.send('task.control',{...base,operation:'review'},'dr:'+key);return this.send('task.control',{...base,operation:'integrate'},'di:'+key);
    }
    if(action==='meeting.final-pr') {
      const cwd=this.storage.read().meetingWorkspaces?.[String(p.meetingId)];if(!cwd)throw new Error('会议集成尚未完成');
      const tasks=this.rows('task').filter(t=>t.meetingId===p.meetingId&&t.resource==='repository');
      if(tasks.some(t=>!verifiedDelivery(t)||dependencyWait(this.storage.read().snapshot,String(p.meetingId),t)))throw new Error('请先完成全部代码成果的会议集成与组合验证');
      const prUrl=await finalMeetingPullRequest(cwd,String(p.meetingId),String(p.targetBranch),String(p.summary??'会议成果，等待用户最终审查与合并'));
      await this.send('meeting.result',{meetingId:p.meetingId,prUrl,commit:await git(cwd,['rev-parse','HEAD'])});return {prUrl};
    }
    if(action==='native.launch') return nativeHelper({operation:'launch'});
    if(action==='native.refresh') {await this.syncNative();await this.probe();if(this.connected)await this.publishConfig();return this.view();}
    if(action==='native.history')return this.connection?.request('/api/collaboration/v2/history?device='+encodeURIComponent(String(p.deviceId))+'&session='+encodeURIComponent(String(p.sessionId))+'&after='+Number(p.after??0));
    if(action==='native.stop') {
      const session=this.nativeRows.get(String(p.sessionId));if(!session)throw new Error('该对话不在本机授权目录内');
      const receipt=Object.values(this.storage.read().receipts).find(r=>r.nativeThreadId===p.sessionId&&r.nativeTurnId===p.turnId);
      return await this.background(receipt?'execution:'+receipt.attemptId:'native:'+p.sessionId+':'+p.turnId,()=>this.helper({operation:'stop-turn',sessionId:p.sessionId,turnId:p.turnId,grants:Object.values(this.storage.read().directories)}))??{cleanup_confirmed:false,reason:'原停止操作仍需核对，保留实际占用'};
    }
    if(action==='directory.grant') {
      const project=this.rows('project').find(row=>row.id===p.projectId);if(!project)throw new Error('请选择共享项目');
      const selected=await dialog.showOpenDialog({title:'授权任务及 Codex 对话发现目录',properties:['openDirectory']});if(selected.canceled)return {cancelled:true};
      const workspace=await dialog.showOpenDialog({title:'选择独立普通任务工作区父目录',properties:['openDirectory','createDirectory']});if(workspace.canceled)return {cancelled:true};
      const full=p.permission==='full-access';const permission=full?'full-access':p.permission==='read-only'?'read-only':'workspace-write';
      const confirmed=await dialog.showMessageBox({type:full?'warning':'question',buttons:['明确授权本机目录','返回'],defaultId:1,cancelId:1,
        message:full?'允许接续原本完全访问的 Codex 对话':'授权本机普通目录与原生对话发现',
        detail:`目录：${selected.filePaths[0]}\n权限上限：${permission}\n${full?'完全访问可操作沙箱外文件。远端不能替你开启此授权。':'执行时保持原生会话权限，不从远端提权。'}`});
      if(confirmed.response!==0)return {cancelled:true};
      const state=this.storage.read();const revision=(state.directories[project.id]?.revision??0)+1;
      await this.storage.update(s=>{s.directories[project.id]={projectId:project.id,root:selected.filePaths[0],workspaceRoot:workspace.filePaths[0],permission,allowedAgentIds:s.allowedAgents,confirmed:true,revision,fullAccessConfirmed:full};});
      await this.send('binding.report',{schemaVersion:1,projectId:project.id,deviceId:state.deviceId,state:'ready',bindingRevision:revision});
      this.changed();return this.view();
    }
    if(action==='project.bind') {
      const project=this.rows('project').find(row=>row.id===p.projectId);if(!project) throw new Error('请选择共享项目');
      const selected=await dialog.showOpenDialog({title:'选择该 GitHub 仓库的本机副本',properties:['openDirectory']});
      if(selected.canceled) return {cancelled:true};
      const root=selected.filePaths[0];await checkGithub(root,(project.repository as {canonicalUrl:string}).canonicalUrl);
      const workspace=await dialog.showOpenDialog({title:'选择独立任务工作区父目录',properties:['openDirectory','createDirectory']});
      if(workspace.canceled) return {cancelled:true};
      const permission=p.permission==='read-only'?'read-only':'workspace-write';
      const confirm=await dialog.showMessageBox({type:'question',buttons:['保存本机授权','返回'],defaultId:1,cancelId:1,
        message:'允许本机已选 Agent 使用此项目',detail:`副本：${root}\n任务工作区：${workspace.filePaths[0]}\n权限上限：${permission}`});
      if(confirm.response!==0) return {cancelled:true};
      const state=this.storage.read();const binding: LocalProjectBinding={schemaVersion:1,projectId:project.id,deviceId:state.deviceId,
        localRepoRoot:root,taskWorkspaceRoot:workspace.filePaths[0],permissionCeiling:permission,allowedAgentIds:state.allowedAgents,confirmed:true,
        revision:(state.bindings[project.id]?.revision??0)+1};parseContract('localBinding',binding);
      await this.storage.update(s=>{s.bindings[project.id]=binding;});
      if(p.validationCommands!==undefined||p.validationCommandText!==undefined) {
        const commands=p.validationCommands??String(p.validationCommandText).split(/\r?\n/).filter(line=>line.trim()).map(line=>Array.from(line.matchAll(/"([^"]*)"|'([^']*)'|([^\s"']+)/g),m=>m[1]??m[2]??m[3]));
        if(!Array.isArray(commands)||!commands.every(c=>Array.isArray(c)&&c.length>0&&c.length<=100&&c.every(v=>typeof v==='string'&&v.length<=2000)))throw new Error('组合验证命令须为可执行文件及参数的 JSON 数组');
        await this.storage.update(s=>{(s.projectChecks??={})[project.id]=commands;});
      }
      await this.send('binding.report',{schemaVersion:1,projectId:project.id,deviceId:state.deviceId,state:'ready',bindingRevision:binding.revision});
      this.changed();return this.view();
    }
    if(action==='project.revoke') {
      const id=String(p.projectId);const state=this.storage.read();const old=state.bindings[id]??state.directories[id];if(!old) throw new Error('没有该项目的本机授权');
      await this.storage.update(s=>{if(s.bindings[id])s.bindings[id].confirmed=false;if(s.directories[id])s.directories[id].confirmed=false;
        if(s.bindings[id])s.bindings[id].revision=old.revision+1;if(s.directories[id])s.directories[id].revision=old.revision+1;});
      for(const task of this.localTasks().filter(t=>this.usesProject(t,id))) {this.background('execution:'+String(task.attemptId),()=>this.stopLocal(task));await this.stopChecks(undefined,task.id);}
      await this.stopChecks(id);this.stopDeliveryGit(id);
      await this.send('binding.report',{schemaVersion:1,projectId:id,deviceId:this.storage.read().deviceId,state:'unbound',bindingRevision:old.revision+1,reasonCode:'REVOKED'});
      this.changed();return this.view();
    }
    if(action==='device.revoke') {
      await this.storage.update(s=>{s.config.acceptingTasks=false;});
      const result=await this.send('device.revoke',{deviceId:this.storage.read().deviceId});
      for(const task of this.localTasks())this.background('execution:'+String(task.attemptId),()=>this.stopLocal(task));
      this.stopDeliveryGit();
      await this.stopChecks();
      if(!result.draining)this.connection?.stop();this.changed();return result;
    }
    if(action==='execution.reconcile'){
      if(p.taskId){const receipt=this.storage.read().receipts[String(p.taskId)];if(receipt)for(const [phase,operation] of Object.entries(receipt.gitOperations??{}))if(!operation.exitConfirmed)this.background('git:'+operation.id,async()=>{const state=await this.helper({operation:'worker-inspect',executionId:operation.id,sealUnstarted:!this.gitStarting.has(operation.id)});const result=state.result as Record<string,unknown>|undefined;if(result?.cleanup_confirmed){await this.recordDeliveryGit(receipt,phase,operation.id,result);await this.issue('git:'+operation.id);await this.issue('git-run:'+operation.id);}});}
      const task=this.rows('task').find(t=>t.id===p.taskId);if(task){if(task.targetDeviceId!==this.storage.read().deviceId)throw new Error('请在原执行设备重新核对');const receipt=this.storage.read().receipts[task.id];if(!receipt||receipt.attemptId!==task.attemptId){if(receipt&&Object.values(receipt.gitOperations??{}).some(g=>!g.exitConfirmed))return this.view();throw new Error('原执行记录尚未接收');}const key='execution:'+receipt.attemptId;await this.settleBackground([this.background(key,()=>task.stopRequested||receipt.stopRequested?this.stopLocal(task):this.recoverReceipt(receipt))]);}
      else if(p.messageId){const id=String(p.messageId),message=this.rows('message').find(m=>m.id===id);if(!message||message.targetDeviceId!==this.storage.read().deviceId&&this.rows('meeting').find(m=>m.id===message.meetingId)?.coordinatorDeviceId!==this.storage.read().deviceId)throw new Error('请在原输入执行设备核对');const status=this.storage.read().hostMessages?.[id];if(message.route==='control'){await this.pump();return this.view();}await this.settleBackground([this.background('input:'+id,()=>message.stopRequested?this.stopMessage(message):status?this.recoverInput(id,status):Promise.resolve())]);}
      else throw new Error('需要原输入或任务身份');this.changed();return this.view();
    }
    if(action==='message.reconcile'){
      return this.reconcileSubmission(String(p.requestId));
    }
    if(action==='command') {
      const allowed=['meeting.create','meeting.update','meeting.request','plan.review','message.send','message.retry','message.stop','plan.propose','plan.decide','task.create','task.control','approval.decide','native.bind','native.stop'];
      if(!allowed.includes(String(p.action)) || !p.payload || typeof p.payload!=='object' || Array.isArray(p.payload)) throw new Error('该操作不允许从界面调用');
      const control=p.payload as Record<string,unknown>;
      if(p.action==='meeting.create'&&control.hostAuthority==='original-orchestrator'&&!this.storage.read().snapshot.capabilities?.includes('unified-meeting-v1'))throw new Error('Hub 尚未支持统一会议，请先部署同版兼容升级包；原会议与单机功能仍可使用');
      if(p.action==='meeting.update'&&this.rows('meeting').find(m=>m.id===control.meetingId)?.coordinatorDeviceId!==this.storage.read().deviceId)return this.send('meeting.request',{meetingId:control.meetingId,operation:'configure',changes:control});
      if(p.action==='task.control'&&control.operation==='stop'){const task=this.rows('task').find(t=>t.id===control.taskId);if(task&&task.targetDeviceId===this.storage.read().deviceId&&this.storage.read().receipts[task.id])await this.taskReceipt(task,{stopRequested:true});const result=await this.send('task.control',control);if(task){this.background('execution:'+String(task.attemptId),()=>this.stopLocal(task));void this.stopChecks(undefined,task.id);}return result;}
      if(p.action==='task.create')await this.prepareAssignment(p.payload as Record<string,unknown>);
      if(p.action==='message.send'){
        const id=p.requestId===undefined?randomUUID():p.requestId;if(typeof id!=='string')throw new Error('无效的消息提交身份');
        const identity=this.identityKey();
        const authorized=()=>{const now=getRemoteControlSettings();return identity===this.identityKey()&&(!account.enabled||(now.enabled&&now.ownerId===account.ownerId&&now.serviceUrl===account.serviceUrl));};
        try{return await this.send('message.send',control,id,authorized);}catch(error){if(this.storage.read().outbox.some(c=>c.requestId===id&&c.action==='message.send'&&JSON.stringify(c.payload)===JSON.stringify(control)))return {pending:true,requestId:id};throw error;}
      }
      return this.send(String(p.action),p.payload as Record<string,unknown>);
    }
    throw new Error('未知的协作操作');
  }
  private async prepareAssignment(task:Record<string,unknown>):Promise<void> {
    if(task.resource!=='repository')return;
    const binding=this.storage.read().bindings[String(task.projectId)];if(!binding?.confirmed)throw new Error('协调设备也需绑定主要代码项目');
    const meeting=String(task.meetingId);const existing=this.storage.read().meetingWorkspaces?.[meeting];
    const shared=this.rows('meeting').find(m=>m.id===meeting);
    if((task.dependencies as unknown[]).length&&shared?.verifiedCommit&&task.baseCommit!==shared.verifiedCommit)throw new Error('前序成果已改变基线，请在计划中展示准确提交并重新批准');
    if(existing)return;
    const cwd=await prepareMeetingBranch(binding.localRepoRoot,binding.taskWorkspaceRoot,meeting,String(task.baseCommit));
    await this.storage.update(s=>{(s.meetingWorkspaces??={})[meeting]=cwd;});
  }
  private dependencySignature(task:SharedEntity):string {
    const dependencies=(task.dependencies as string[]).map(id=>{
      const dep=this.rows('task').find(t=>t.id===id);
      return [id,dep?.attemptId,dep?.integrationCommit,dep?.integration,dep&&deliveryHash(dep)];
    });
    return JSON.stringify(dependencies);
  }
  private enqueueIntegration(task:SharedEntity):Promise<unknown> {
    const meeting=String(task.meetingId);const previous=this.integrationQueues.get(meeting)??Promise.resolve();
    const job=previous.catch(()=>{}).then(()=>this.integrateTask(this.rows('task').find(t=>t.id===task.id)??task));this.integrationQueues.set(meeting,job);return job;
  }
  private async integrateTask(task:SharedEntity):Promise<unknown> {
    const meeting=this.rows('meeting').find(m=>m.id===task.meetingId);
    if(meeting?.coordinatorDeviceId!==this.storage.read().deviceId)throw new Error('请在原协调设备检查并集成成果');
    if(task.stopRequested||task.status!=='delivered')throw new Error('请先核对当前任务是否仍为可集成的已交付状态');
    if(task.integration==='verified'&&!verifiedDelivery(task)){
      throw new Error('当前成果的核验绑定不匹配，请明确修订或继续，产生新 attempt 后再集成');
    }
    const waiting=dependencyWait(this.storage.read().snapshot,meeting.id,task);
    if(waiting)throw new Error(waiting);
    const delivery=task.delivery as {commit?:string;summary?:string}|undefined;
    const cwd=this.storage.read().meetingWorkspaces?.[String(task.meetingId)];if(!cwd||!delivery?.commit)throw new Error('需要已上传的代码成果和会议集成工作区');
    const binding=this.storage.read().bindings[String(task.projectId)];if(!binding?.confirmed)throw new Error('本机主要代码项目授权已撤销');
    await trustedDirectory(binding.taskWorkspaceRoot,cwd);
    if(await git(cwd,['status','--porcelain']))throw new Error('会议工作区已有修改，保留内容等待核对');
    if(meeting.hostAuthority==='original-orchestrator'){const review=await reviewSharedReport(task,true);if(!review.passed)throw new Error('原交付规则检查未通过：'+JSON.stringify(review.findings));}
    const saved=this.storage.read().integrations?.[task.id];
    const dependencies=this.dependencySignature(task);
    const result=saved?.sourceCommit===delivery.commit&&saved.dependencies===dependencies&&task.integration!=='revalidation-required'?saved:{...await integrateDelivery(cwd,delivery.commit,this.storage.read().projectChecks?.[String(task.projectId)]??[],(binary,args,directory)=>this.runCheck(String(task.projectId),task.id,binary,args,directory)),sourceCommit:delivery.commit,dependencies};
    await this.storage.update(s=>{(s.integrations??={})[task.id]=result;});
    const hash=deliveryHash(task);const identity=createHash('sha256').update(task.id+':'+String(task.attemptId)+':'+result.commit+':'+hash).digest('hex');
    await this.send('task.control',{taskId:task.id,attemptId:task.attemptId,deliveryHash:hash,operation:'review',evidence:'已核验 Git 成果对象、清单及组合测试。\n'+(delivery.summary??'').slice(-8000)},'rv:'+identity);
    await this.send('task.control',{taskId:task.id,attemptId:task.attemptId,deliveryHash:hash,operation:'integrate',commit:result.commit,evidence:JSON.stringify({commit:result.commit,checks:result.checks.map(c=>c.slice(-600))})},'in:'+identity);return result;
  }
  private async runCheck(projectId:string,taskId:string,binary:string,args:string[],cwd:string):Promise<string> {
    const binding=this.storage.read().bindings[projectId];if(!binding?.confirmed||this.closing)throw new Error('本机授权已撤销或 Station 正在退出');
    await trustedDirectory(binding.taskWorkspaceRoot,cwd);const command=await executableCommand(binary,args);const executionId=randomUUID();
    if(this.rows('task').find(t=>t.id===taskId)?.stopRequested||this.storage.read().receipts[taskId]?.stopRequested)throw new Error('停止意图已保存，不启动新的测试');
    await this.storage.update(s=>{(s.checks??={})[executionId]={projectId,taskId,cwd,exitConfirmed:false};});
    if(this.rows('task').find(t=>t.id===taskId)?.stopRequested||this.storage.read().receipts[taskId]?.stopRequested){await this.storage.update(s=>{s.checks![executionId].exitConfirmed=true;});throw new Error('停止意图先于验证调用，本次未运行');}
    const result=await nativeHelper({operation:'worker-check',executionId,command,cwd,permission:'workspace-write'});
    if(result.cleanup_confirmed)await this.storage.update(s=>{s.checks![executionId].exitConfirmed=true;});
    if(!this.storage.read().bindings[projectId]?.confirmed||this.rows('task').find(t=>t.id===taskId)?.stopRequested)throw new Error('任务已停止或本机授权已撤销，候选成果已保留');
    if(!result.ok||!result.cleanup_confirmed)throw new Error('组合验证未通过或进程退出未确认，候选成果已保留');
    return String((result.json as {last_message?:string})?.last_message??'');
  }
  private async stopChecks(projectId?:string,taskId?:string):Promise<boolean> {
    const selected=Object.entries(this.storage.read().checks??{}).filter(([,c])=>!c.exitConfirmed&&(!projectId||c.projectId===projectId)&&(!taskId||c.taskId===taskId));
    const jobs=selected.map(([id])=>this.background('execution:'+id,async()=>{const result=await this.helper({operation:'worker-stop',executionId:id,sealUnstarted:true});if(result.cleanup_confirmed){await this.storage.update(s=>{if(s.checks?.[id])s.checks[id].exitConfirmed=true;});await this.issue('execution:'+id);}else await this.issue('execution:'+id,'验证进程停止尚未确认，保留实际占用');}));
    await this.settleBackground(jobs);return selected.every(([id])=>this.storage.read().checks?.[id]?.exitConfirmed===true);
  }
  private stopDeliveryGit(projectId?:string,agentIds?:string[]){
    for(const receipt of Object.values(this.storage.read().receipts))if((!agentIds||agentIds.includes(String(receipt.taskSnapshot?.agentId)))&&(!projectId||receipt.publication?.projectId===projectId||receipt.taskSnapshot&&this.usesProject(receipt.taskSnapshot,projectId)))for(const [phase,operation] of Object.entries(receipt.gitOperations??{}))if(!operation.exitConfirmed)this.background('git:'+operation.id,async()=>{const result=await this.helper({operation:'worker-stop',executionId:operation.id,sealUnstarted:true});if(result.cleanup_confirmed)await this.recordDeliveryGit(receipt,phase,operation.id,result);else await this.issue('git:'+operation.id,'授权已撤销；原 Git 停止尚未确认，保留目录占用与已有发布事实');});
  }
  private async stopLocal(task:SharedEntity):Promise<void>{
    if(task.targetDeviceId!==this.storage.read().deviceId)return;
    const receipt=this.storage.read().receipts[task.id];if(!receipt||receipt.attemptId!==task.attemptId)return;
    await this.taskReceipt(task,{stopRequested:true});
    if(receipt.exitConfirmed){await this.issue('execution:'+receipt.attemptId);return;}
    for(const approval of this.rows('approval').filter(a=>a.taskId===task.id||a.messageId===task.id)){this.approvals.get(approval.id)?.('deny');this.approvals.delete(approval.id);}
    const key=task.id+':'+String(task.attemptId),handle=this.active.get(key);
    let confirmed=false;
    if(handle)confirmed=await this.controlCall(()=>handle.stop());
    else if(receipt.executionInvoked){const result=await this.helper({operation:task.resource==='native'?'stop':'worker-stop',executionId:receipt.attemptId,grants:Object.values(this.storage.read().directories)});confirmed=result.cleanup_confirmed===true;}
    else {await this.taskReceipt(task,{status:'stopped',turnOutcome:'interrupted',exitConfirmed:true});await this.taskEvent(task,'stopped',true,{turnOutcome:'interrupted'});return;}
    const latest=this.storage.read().receipts[task.id];if(latest?.attemptId!==receipt.attemptId||latest.exitConfirmed){await this.issue('execution:'+receipt.attemptId);return;}
    await this.taskReceipt(task,{status:'reconcile'});
    if(confirmed&&task.agentId!=='file-test')await this.recoverReceipt(this.storage.read().receipts[task.id]);
    else {await this.issue('execution:'+receipt.attemptId,'停止尚未确认，继续核对原轮次与实际退出');try{await this.taskEvent(task,'stop-unconfirmed',false);}catch{}}
  }
  private localTasks():SharedEntity[] {return [...this.rows('task'),...Object.values(this.storage.read().receipts).filter(r=>r.taskSnapshot?.freeConversation).map(r=>r.taskSnapshot!)];}
  private usesProject(task:SharedEntity,id:string):boolean {const project=this.rows('project').find(p=>p.id===id);return task.projectId===id||!!project?.repository&&((task.inputs??[]) as GitFileReference[]).some(ref=>ref.repository===(project.repository as {canonicalUrl:string}).canonicalUrl);}
  hasExecution(): boolean {return this.active.size>0;}
  hasBackgroundResponsibility():boolean {
    const s=this.storage.read();return s.config.acceptingTasks||this.active.size>0||this.discussions.size>0||this.deliveries.size>0||Object.values(s.checks??{}).some(c=>!c.exitConfirmed)||Object.values(s.receipts).some(r=>r.executionInvoked&&!r.exitConfirmed||Object.values(r.gitOperations??{}).some(g=>!g.exitConfirmed))||this.rows('meeting').some(m=>m.coordinatorDeviceId===s.deviceId&&!m.accepted);
  }
  async shutdown():Promise<boolean>{
    if(!this.localReady)return false;this.closing=true;
    const jobs:Promise<unknown>[]=[];
    for(const task of this.localTasks())jobs.push(this.background('execution:'+String(task.attemptId),()=>this.stopLocal(task)));
    for(const [id,status] of Object.entries(this.storage.read().hostMessages??{}))if(!hostInputTerminal(status)){
      const message=this.rows('message').find(m=>m.id===id);
      if(message?.route==='agent')jobs.push(this.background('input:'+id,()=>this.stopMessage(message)));
      else jobs.push(this.background('input:'+id,async()=>{const meeting=this.rows('meeting').find(m=>m.id===message?.meetingId);const host=meeting&&this.hosts.get(meeting.id);if(host)await this.controlCall(()=>host.stop());else await this.helper({operation:'worker-stop',executionId:id});if(!this.executingInputs.has(id))await this.recoverInput(id,status);}));
    }
    const checksStopped=await this.stopChecks();await this.settleBackground(jobs);
    const state=this.storage.read();
    const confirmed=checksStopped&&this.active.size===0&&this.discussions.size===0&&this.deliveries.size===0&&!Object.values(state.receipts).some(r=>!r.exitConfirmed&&r.executionInvoked||Object.values(r.gitOperations??{}).some(g=>!g.exitConfirmed))&&!Object.values(state.hostMessages??{}).some(s=>!hostInputTerminal(s));
    if(confirmed){clearInterval(this.nativeTimer);clearInterval(this.recoveryTimer);this.nativeTimer=undefined;this.recoveryTimer=undefined;this.connection?.stop();this.connected=false;++this.connectionEpoch;for(const host of this.hosts.values())host.close();}
    else this.closing=false;
    return confirmed;
  }

}

let instance: StationService|undefined;
export function stationService(): StationService|undefined {return instance;}
export async function initializeStationCollaboration(): Promise<void> {
  instance=new StationService();
  ipcMain.handle('collaboration:request',async(event,action: unknown,payload: unknown)=>{
    const sender=event.senderFrame?.url??'';
    const fileUrl=new URL('../..',import.meta.url).href;
    const dev=process.env.VITE_DEV_SERVER_URL;
    if(!sender.startsWith('app://bundle/')&&!sender.startsWith(fileUrl)&&!(dev&&sender.startsWith(dev)))return {ok:false,error:'不允许此页面操作本机协作'};
    if(typeof action!=='string'||(payload!==undefined&&(!payload||typeof payload!=='object'||Array.isArray(payload)))) return {ok:false,error:'无效的本机操作'};
    const account=instance!.view().accountKey;const scope=instance!.requestEntity(action,payload as Record<string,unknown>|undefined);
    try {const value=await instance!.action(action,payload as Record<string,unknown>|undefined);if(scope.entity&&account===instance!.view().accountKey)await instance!.clearBusinessError(scope.entity,scope.operation);return {ok:true,value};}
    catch(error) {if(scope.entity&&account===instance!.view().accountKey)await instance!.error(error,scope.entity,scope.operation);return {ok:false,error:error instanceof Error?error.message:'协作操作失败'};}
  });
  void instance.initialize().catch(error=>instance!.error(error));
}
