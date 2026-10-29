"""Durable, task-owned Codex app-server guardian, independent of Station's UI.

Windows uses atomic Job membership; Linux uses the existing subreaper. A lost
pipe never starts another Agent. Only a proven empty owned tree releases a slot.
"""
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from task_journal import TaskJournal,read_json,write_json
from task_process import WindowsJob,windows_identity,recover
from task_ownership import LinuxTaskTree,linux_identity
from codex_runtime import is_supported

class CodexRpcError(RuntimeError):
    def __init__(self,diagnostic):
        self.diagnostic=diagnostic
        super().__init__(f"Codex RPC {diagnostic['method']} [{diagnostic['code']}]: {diagnostic['message']} (stage={diagnostic['stage']}, thread={diagnostic.get('threadId')}, turn={diagnostic.get('turnId')})")

class Guardian:
    def __init__(self,request,emit,task_tree=None):
        self.request=request;self.emit=emit;self.journal=TaskJournal(str(uuid.UUID(request['executionId'])),'codex')
        self.messages=queue.Queue(maxsize=2048);self.sequence=0;self.replies={};self.thread=None;self.turn=None
        self.summary='';self.delta='';self.approvals={};self.complete=False;self.interrupted=False;self.failed=False
        self.last_save=0;self.proc=None;self.job=None;self.tree=None;self.owned={};self.interrupt_sent=False
        self.stderr=''
        self.native_error='';self.model=None
        self.stop_sent_at=None;self.final_messages=[];self.final_message=None;self.stage='preparation';self.pending_turn_messages=[]
        self.task_tree=task_tree
    def redact(self,text):
        for key,secret in os.environ.items():
            if len(secret)>8 and re.search('TOKEN|KEY|SECRET|PASSWORD',key,re.I):text=text.replace(secret,'[redacted]')
        text=re.sub(r'(?i)(bearer\s+|(?:token|password|api_key)[=:]\s*)[^\s\"\']+',r'\1[redacted]',text)
        return re.sub(r'sk-[A-Za-z0-9_-]{10,}','[redacted]',text)
    def persist(self):
        write_json(self.journal.path/'station-status.json',{'threadId':self.thread,'turnId':self.turn,'summary':self.summary,'model':self.model,
            'approvals':[{k:v for k,v in a.items() if k!='request'} for a in self.approvals.values()]})
    def send(self,value):
        self.proc.stdin.write((json.dumps(value)+'\n').encode());self.proc.stdin.flush()
    def tick(self):
        if self.tree:
            self.owned['tracked']=self.tree.snapshot();write_json(self.journal.path/'containment.json',self.owned)
        if (self.journal.path/'cancel.json').exists() and not self.turn:
            self.interrupted=True;raise InterruptedError('Station task stopped during native preparation')
        if (self.journal.path/'cancel.json').exists() and self.turn and not self.interrupt_sent:
            self.sequence+=1;self.send({'id':self.sequence,'method':'turn/interrupt','params':{'threadId':self.thread,'turnId':self.turn}});self.interrupt_sent=True;self.stop_sent_at=time.monotonic()
        if self.stop_sent_at and time.monotonic()-self.stop_sent_at>min(30,max(.1,float(self.request.get('stopGraceSeconds',30)))):
            self.interrupted=True;raise InterruptedError('原生中断未结束，开始清理本任务独占的执行进程链')
        for identity,approval in list(self.approvals.items()):
            decision=read_json(self.journal.path/('approval-'+identity+'.json'))
            if not decision: continue
            allowed=decision.get('decision')=='allow' and approval['supported']
            method=approval['request']['method']
            result={'decision':'accept' if allowed else 'decline'} if method in ('item/commandExecution/requestApproval','item/fileChange/requestApproval') else None
            if result is None: continue
            self.send({'id':approval['request']['id'],'result':result});self.approvals.pop(identity);self.persist()
            self.emit({'type':'approval-observed','id':identity,'decision':'allow' if allowed else 'deny'})
        if time.monotonic()-self.last_save>.2:
            self.persist();self.last_save=time.monotonic()
            if self.delta:self.emit({'type':'output','text':self.delta[-16000:]});self.delta=''
    def handle(self,message):
        method=message.get('method');params=message.get('params') or {}
        if method in ('item/agentMessage/delta','item/completed','turn/completed'):
            if self.thread and params.get('threadId') not in (None,self.thread):return
            if not self.turn and self.stage in ('thread-resume','thread-start','turn-start'):
                if len(self.pending_turn_messages)>=2048:raise RuntimeError('Native turn identity not yet confirmed; preserve original execution for reconciliation')
                self.pending_turn_messages.append(message);return
            if self.turn and params.get('turnId') not in (None,self.turn):return
        if method and 'id' in message:
            identity=str(uuid.uuid4());supported=method in ('item/commandExecution/requestApproval','item/fileChange/requestApproval') and not params.get('additionalPermissions')
            self.approvals[identity]={'id':identity,'tool':method,'description':str(params.get('reason') or params.get('command') or method)[:12000],'supported':supported,'request':message}
            self.persist();self.emit({'type':'approval',**{k:v for k,v in self.approvals[identity].items() if k!='request'}})
        elif method=='item/agentMessage/delta':
            delta=str(params.get('delta',''));self.summary=self.summary+delta;self.delta=(self.delta+delta)[-16000:]
        elif method=='item/completed' and (params.get('item') or {}).get('type')=='agentMessage':
            item=params['item'];text=item.get('text')
            if isinstance(text,str):
                record={'itemId':item.get('id'),'phase':item.get('phase'),'text':text}
                existing=next((i for i,m in enumerate(self.final_messages) if m.get('itemId')==item.get('id')),None)
                if existing is None:self.final_messages.append(record)
                else:self.final_messages[existing]=record
                final=[m['text'] for m in self.final_messages if m.get('phase')!='commentary']
                if final:self.final_message='\n'.join(final)
        elif method=='turn/completed':
            turn=params.get('turn') or {}
            if self.turn and turn.get('id')!=self.turn:return
            if turn.get('status') not in ('completed','interrupted','failed'):return
            self.complete=True;self.interrupted=turn.get('status')=='interrupted';self.failed=turn.get('status')=='failed'
            if self.failed:self.native_error=self.redact(json.dumps(turn.get('error') or 'Codex native turn failed',ensure_ascii=False))[:1000]
        elif not method and 'id' in message:self.replies[message['id']]=message
    def receive(self,timeout=.1):
        self.tick()
        try:self.handle(self.messages.get(timeout=timeout))
        except queue.Empty:
            if self.proc.poll() is not None:raise RuntimeError('Codex app-server exited before its turn was confirmed')
    def call(self,method,params):
        self.sequence+=1;identity=self.sequence;self.send({'id':identity,'method':method,'params':params});deadline=time.monotonic()+(120 if method=='turn/start' else 30)
        while identity not in self.replies:
            if time.monotonic()>deadline:raise TimeoutError('Codex RPC response timed out: '+method)
            self.receive()
        result=self.replies.pop(identity)
        if result.get('error'):
            error=result['error'];message=self.redact(str(error.get('message','Unknown RPC rejection'))) if hasattr(self,'redact') else str(error.get('message'))
            raise CodexRpcError({
                'method':method,'code':error.get('code'),'message':message[:2000],
                'stage':getattr(self,'stage',method),
                'executionId':getattr(self,'request',{}).get('executionId'),
                'threadId':params.get('threadId',getattr(self,'thread',None)),
                'turnId':params.get('turnId',getattr(self,'turn',None)),
            })
        return result.get('result') or {}
    def run(self):
        request=self.request
        if request['permission'] not in ('read-only','workspace-write'):raise ValueError('New tasks cannot request native full access')
        if self.journal.result():return self.journal.result()
        if not self.journal.launch_once():raise RuntimeError('Original launch already recorded; reconcile without executing again')
        write_json(self.journal.path/'station-request.json',request)
        if (self.journal.path/'cancel.json').exists():
            self.journal.finish({'ok':False,'cancelled':True,'cleanup_confirmed':True,'not_started':True,
                'turnOutcome':'interrupted','error':'停止意图先于执行，未启动模型或验证命令'})
            return self.journal.result()
        result={'ok':False,'cleanup_confirmed':False}
        try:
            if sys.platform=='win32':
                self.job=WindowsJob();self.owned={'version':2,'status':'running','phase':'prepared','containment':'windows-job-list','job':self.job.name,'owner':windows_identity(os.getpid())[0]}
            elif sys.platform.startswith('linux'):
                self.tree=LinuxTaskTree();self.owned={'version':2,'status':'running','phase':'prepared','containment':'linux-subreaper','owner':self.tree.owner,'tracked':[]}
            elif sys.platform=='darwin' and self.task_tree is not None:
                self.tree=self.task_tree;self.owned=self.tree.record()
            else:raise RuntimeError('This guardian platform requires native containment integration before execution')
            write_json(self.journal.path/'containment.json',self.owned)
            spawn=self.job.spawn if self.job else subprocess.Popen
            self.proc=spawn(request['command'],cwd=request['cwd'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                creationflags=4 if self.job else 0,env=os.environ.copy())
            self.owned.update(phase='running',root=windows_identity(self.proc.pid)[0] if self.job else linux_identity(self.proc.pid))
            write_json(self.journal.path/'containment.json',self.owned)
            if self.job:self.job.attach_and_resume(self.proc)
            if request.get('operation')=='worker-check':
                def capture(stream):
                    while True:
                        data=stream.read1(4096)
                        if not data:break
                        self.summary=(self.summary+self.redact(data.decode('utf-8',errors='replace')))[-48000:]
                readers=[threading.Thread(target=capture,args=(stream,),daemon=True) for stream in (self.proc.stdout,self.proc.stderr)]
                for reader in readers:reader.start()
                deadline=time.monotonic()+600
                while self.proc.poll() is None:
                    self.tick()
                    if time.monotonic()>deadline:raise TimeoutError('组合验证命令超过十分钟，保留候选成果')
                    time.sleep(.05)
                result.update(ok=self.proc.returncode==0,exitCode=self.proc.returncode,json={'last_message':self.summary},error='' if self.proc.returncode==0 else '组合验证命令返回非零退出码')
                return result
            def reader():
                for line in self.proc.stdout:
                    if len(line)>2*1024*1024:break
                    try:self.messages.put(json.loads(line),timeout=5)
                    except (ValueError,queue.Full):break
            threading.Thread(target=reader,daemon=True).start()
            def drain_stderr():
                while True:
                    value=self.proc.stderr.read1(4096)
                    if not value:break
                    text=value.decode('utf-8',errors='replace')
                    self.stderr=(self.stderr+self.redact(text))[-8000:]
            threading.Thread(target=drain_stderr,daemon=True).start()
            initialized=self.call('initialize',{'clientInfo':{'name':'ahastation_worker','title':'AhaStation','version':'0.19.0'},'capabilities':{'experimentalApi':False,'requestAttestation':False}})
            version=re.search(r'/(\d+\.\d+\.\d+)(?:\s|\(|$)',initialized.get('userAgent',''))
            if not version or not is_supported(version[1]):raise RuntimeError('Codex app-server protocol version is incompatible; task was not submitted')
            self.send({'method':'initialized'})
            account=self.call('account/read',{'refreshToken':False})
            if account.get('requiresOpenaiAuth') and not account.get('account') and not os.getenv('OPENAI_API_KEY'):raise RuntimeError('Codex login required')
            text_config={'features.shell_tool':False,'features.unified_exec':False,'features.multi_agent':False,'features.view_image_tool':False,'tools.view_image':False,'web_search':'disabled','mcp_servers':{}} if request.get('textOnly') else {}
            if request.get('threadId'):
                self.stage='thread-resume';self.thread=self.call('thread/resume',{'threadId':request['threadId'],'excludeTurns':True,'cwd':request['cwd'],**({'config':text_config} if text_config else {})})['thread']['id']
                if self.thread!=request['threadId']:raise RuntimeError('Native thread identity changed')
            else:
                self.stage='thread-start'
                models=self.call('model/list',{'limit':100,'includeHidden':False}).get('data',[])
                requested=request.get('model')
                if requested and not any(m.get('model')==requested for m in models):raise RuntimeError('所选 Codex 模型不在当前安装组件可用目录，请在 Agent 设置中选择可用模型')
                selected=next((m for m in models if m.get('isDefault')),models[0] if models else {})
                self.model=requested or selected.get('model')
                if not self.model:raise RuntimeError('当前 Codex 组件未返回可用模型，请检查本机登录')
                self.thread=self.call('thread/start',{'cwd':request['cwd'],'sandbox':request['permission'],'approvalPolicy':'untrusted','model':self.model,**({'config':text_config} if text_config else {})})['thread']['id']
            self.persist();self.emit({'type':'identity','threadId':self.thread})
            if (self.journal.path/'cancel.json').exists():self.interrupted=True
            else:
                inputs=[{'type':'text','text':request['objective'],'text_elements':[]}]
                images=request.get('images',[])
                if not isinstance(images,list) or len(images)>8:raise ValueError('Too many selected image inputs')
                root=Path(request['cwd']).resolve()
                for image in images:
                    path=Path(image).resolve()
                    if root not in path.parents or not path.is_file() or path.suffix.lower() not in ('.png','.jpg','.jpeg','.webp') or path.stat().st_size>25*1024*1024:raise ValueError('Image is outside the owned input workspace')
                    inputs.append({'type':'localImage','path':str(path)})
                self.stage='turn-start';self.turn=self.call('turn/start',{'threadId':self.thread,'input':inputs})['turn']['id']
                self.stage='turn-running';pending=self.pending_turn_messages;self.pending_turn_messages=[]
                for message in pending:self.handle(message)
                self.persist();self.emit({'type':'identity','threadId':self.thread,'turnId':self.turn})
                deadline=time.monotonic()+1800
                while not self.complete:
                    if time.monotonic()>deadline:raise TimeoutError('Task execution limit reached')
                    self.receive()
            result.update(ok=not self.failed and not self.interrupted,cancelled=self.interrupted,
                turnOutcome='interrupted' if self.interrupted else 'failed' if self.failed else 'completed',
                json={'last_message':self.final_message if self.final_message is not None else self.summary,'final_messages':self.final_messages},error=self.native_error)
        except Exception as error:
            result.update(error=str(error)[:2000],stderr=self.stderr[-2000:],cancelled=self.interrupted or (self.journal.path/'cancel.json').exists())
            if isinstance(error,CodexRpcError):result['rpcError']=error.diagnostic
        finally:
            try:
                if self.job:
                    self.job.kill();deadline=time.monotonic()+10
                    while not self.job.empty() and time.monotonic()<deadline:time.sleep(.02)
                    if not self.job.empty():raise RuntimeError('Task-owned process chain exit remains unconfirmed')
                elif self.tree:self.tree.cleanup(self.proc,lambda tracked:write_json(self.journal.path/'containment.json',{**self.owned,'tracked':tracked}))
                else:raise RuntimeError('No process containment was established')
                result['cleanup_confirmed']=True
                write_json(self.journal.path/'containment.json',{**self.owned,'status':'idle','phase':'cleaned','exit_proof':True})
            except Exception:result['cleanup_confirmed']=False
            if self.proc:
                try:self.proc.wait(timeout=2)
                except subprocess.TimeoutExpired:pass
            if request.get('operation')=='worker-check':
                for reader in locals().get('readers',[]):reader.join(timeout=2)
                result['json']={'last_message':self.summary}
            if self.job:self.job.close()
            self.persist();self.journal.finish(result)
        return self.journal.result()

def inspect(request):
    journal=TaskJournal(str(uuid.UUID(request['executionId'])),'codex');result=journal.result()
    # Recovery may atomically fence an absent launch. A delayed helper can no
    # longer cross launch_once after this proof; absence alone is not a proof.
    if not result and request.get('sealUnstarted') is True and journal.launch_once():
        journal.finish({'ok':False,'cancelled':True,'cleanup_confirmed':True,'not_started':True,
            'error':'已确认本轮守护执行未启动，原输入保留；修正后可明确重试。'})
        result=journal.result()
    if result:return {'result':result,**read_json(journal.path/'station-status.json',{})}
    owned=read_json(journal.path/'containment.json',{})
    if owned and sys.platform=='win32':
        current,alive=windows_identity(owned['owner']['pid'])
        if current!=owned['owner'] or not alive:
            recover(owned);journal.finish({'ok':False,'cancelled':True,'cleanup_confirmed':True,'error':'原执行守护进程已退出并核验进程链清理'});result=journal.result()
    return {'result':result,**read_json(journal.path/'station-status.json',{})}
