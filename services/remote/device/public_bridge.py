"""Paired transport/journal on the existing scanner, queue and task guardian."""
from __future__ import annotations
import asyncio
import json
import time
from pathlib import Path
from urllib.parse import urlsplit
import websockets
from websockets.asyncio.client import connect
from desktop_agent import DesktopBridge
from protocol import envelope, ack
from project_policy import authorized_cwd
from task_journal import TaskJournal, read_json, feedback
from session_runtime import SessionLock

class BoundConnect(connect):
    def process_redirect(self,exc): return exc  # Never forward a device credential to a redirect destination.

def service_url(value, *, allow_local=False):
    url=urlsplit(value)
    if url.scheme!='https' and not (allow_local and url.scheme=='http' and url.hostname in {'127.0.0.1','localhost','::1'}):
        raise ValueError('Public remote control requires HTTPS/WSS; loopback HTTP is test-only')
    if not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('Service URL cannot contain credentials, query parameters or fragments')
    return value.rstrip('/')

class PublicBridge(DesktopBridge):
    def __init__(self,base_url,token,provider,config,status=lambda _:None,*,allow_local=False,owner_id=None):
        self.base_url=service_url(base_url,allow_local=allow_local)
        self.provider=provider; self.status=status; self.watchers={}; self.current_ws=None
        self.owner_id=owner_id; self.binding={'service_url':self.base_url,'owner_id':owner_id}
        scheme='wss' if self.base_url.startswith('https:') else 'ws'
        super().__init__(scheme+self.base_url[self.base_url.index(':'):]+'/ws/desktop',token,local_agent_config=str(config))
        self.agent_id=f'{self.device_id}-{provider}'
        if not self.local_agent.config.get('project_policy',{}).get('confirmed'):
            raise ValueError('Public Bridge requires local project authorization')

    async def run_forever(self):
        delay=1
        while not self.stop_event.is_set():
            try: await self._connect_once(); delay=1
            except Exception as exc:
                response=getattr(exc,'response',None)
                if (getattr(getattr(exc,'rcvd',None),'code',None) in {4401,4406}
                    or (getattr(response,'status_code',None) in {401,403}
                        and response.headers.get('X-AhaStation-Auth-Error')=='invalid-credential')):
                    for journal in self.journals():
                        if not journal.result() and not read_json(journal.path/'ack.json'): journal.request_cancel()
                    self.stop_event.set(); self.status(f'{self.provider}: 配对失效或协议需更新，请打开本机设置'); break
                self.status(f'{self.provider}: disconnected ({type(exc).__name__}); retrying')
            try: await asyncio.wait_for(self.stop_event.wait(),timeout=delay)
            except asyncio.TimeoutError: pass
            delay=min(delay*1.8,60)

    def _hello_payload(self):
        payload={**super()._hello_payload(),'protocol':2}
        error=self._support_error() or self._cli_error()
        if error: payload.update(execution_available=False,execution_error=error)
        return payload

    def _support_error(self):
        if self.local_agent.config.get('codex_access')=='desktop':
            from codex_shared import support_error
            return support_error()
        cached=getattr(self,'_support_cache',None)
        if cached is not None: return cached
        import subprocess,sys
        from runtime_entry import python_command
        try:
            probe=subprocess.run(python_command(Path(__file__).with_name('task_process.py'))+['--probe'],
                capture_output=True,timeout=20,creationflags=0x08000000 if sys.platform=='win32' else 0)
            if probe.returncode or not json.loads(probe.stdout.decode().splitlines()[-1]).get('ok'): raise RuntimeError('Task containment probe failed')
            self._support_cache=''
        except Exception: self._support_cache='当前系统未通过任务监管能力检查；请查看 Bridge 更新及本机环境要求'
        return self._support_cache

    def _cli_error(self):
        if self.local_agent.config.get('codex_access')=='desktop':
            from bridge_settings import desktop_runtime
            cached=getattr(self,'_desktop_cache',None)
            binary=(cached or (None,{}))[1].get('binary','')
            if not cached or time.monotonic()-cached[0]>60 or not Path(binary).is_file():
                try:
                    info=desktop_runtime(self.local_agent.config.get('desktop_manual_binary',''))
                    self.local_agent.config.update(cli_binary=info['binary'],runtime_info=info)
                    self._desktop_cache=(time.monotonic(),info)
                except Exception as exc: return str(exc)[:300]
            return ''
        binary=self.local_agent.config.get('cli_binary')
        if not binary: return ''  # Engine fixtures/custom configured runners have no provider-login probe.
        from bridge_settings import cli_status
        cached=getattr(self,'_login_cache',None)
        if not cached or time.monotonic()-cached[0]>60:
            self._login_cache=(time.monotonic(),cli_status(binary,self.provider))
        return self._login_cache[1].get('error','')

    def _scan_sessions(self):
        catalog=super()._scan_sessions(); allowed=[]
        error=self._support_error() or self._cli_error()
        for row in catalog['sessions']:
            if self.local_agent.config.get('codex_access')=='desktop' and not row.get('cwd') and not row.get('available'):
                # No project can be authorized. Expose the unavailable reference
                # with its reason, not private unscoped project/title metadata.
                allowed.append({**row,'title':'不可恢复引用 · Codex 桌面版'})
                continue
            try: authorized_cwd(row['cwd'],self.local_agent.config.get('project_policy'))
            except (ValueError,OSError): continue
            if error: row.update(available=False,error=error)
            allowed.append(row)
        catalog['sessions']=allowed
        if catalog['status'] in {'ready','empty'}: catalog['status']='ready' if allowed else 'empty'
        return catalog

    async def _connect_once(self):
        async with BoundConnect(self.hub+'?provider='+self.provider,
                additional_headers={'Authorization':'Bearer '+self.token},max_size=128*1024,max_queue=8,
                ping_interval=10,ping_timeout=10,close_timeout=3) as ws:
            self.current_ws=ws
            welcome=json.loads(await asyncio.wait_for(ws.recv(),timeout=10))
            if welcome.get('type')!='welcome': raise ValueError('Hub did not confirm device binding')
            await self._handle_message(ws,welcome)
            await ws.send(json.dumps(envelope('hello',self._hello_payload())))
            await self._publish_sessions(ws)
            for journal in self.journals():
                journal.purge_feedback()
                if journal.result() and not read_json(journal.path/'ack.json'):
                    await self._report(ws,journal,journal.result())
            try:
                async for raw in ws: await self._handle_message(ws,json.loads(raw))
            finally: self.current_ws=None

    def journals(self): return TaskJournal.all(self.provider,self.binding) if self.owner_id else []

    def owns(self,journal):
        return read_json(journal.path/'receipt.json',{}).get('binding')==self.binding

    async def _handle_message(self,ws,msg):
        kind=msg.get('type')
        if kind=='welcome':
            owner=msg['payload'].get('owner_id')
            if (not owner or (self.owner_id and owner!=self.owner_id) or msg['payload'].get('protocol')!=2
                or msg['payload'].get('device_id')!=self.device_id):
                raise ValueError('Hub protocol or device binding mismatch')
            self.owner_id=owner; self.binding={'service_url':self.base_url,'owner_id':owner}
            self.status(f'{self.provider}: online'); return
        if kind=='task':
            journal=TaskJournal(msg['task_id'],self.provider)
            if not self.owner_id: raise ValueError('Device binding has not been confirmed')
            journal.receive(msg,self.binding)  # Durable receipt before ACK or launch.
            await ws.send(json.dumps(ack(msg,{'protocol':2})))
            if journal.result(): return await self._report(ws,journal,journal.result())
            if read_json(journal.path/'ack.json'): return  # Retained tombstone: never rerun.
            if msg['task_id'] in self.watchers: return
            msg={**msg,'_journal_dir':str(journal.path)}
            coroutine=self._observe(journal) if (journal.path/'launch-intent').exists() else self._execute_and_report(ws,msg)
            task=asyncio.create_task(coroutine); self.watchers[msg['task_id']]=task
            task.add_done_callback(lambda _,key=msg['task_id']:self.watchers.pop(key,None))
            self.pending_tasks.add(task); task.add_done_callback(self.pending_tasks.discard)
            return
        if kind=='cancel':
            journal=TaskJournal(msg['task_id'],self.provider)
            if not self.owns(journal):
                return await self._report(ws,journal,{'ok':False,'cleanup_confirmed':False,'error':'Task receipt missing; execution outcome unknown'})
            journal.request_cancel()
            if not (journal.path/'launch-intent').exists() and not journal.result():
                journal.finish({'ok':False,'cancelled':True,'cleanup_confirmed':True,'error':'Cancelled while queued, before launch'})
            if journal.result() and journal.result().get('cleanup_confirmed') is False: await self._observe(journal,wait=False)
            if journal.result(): await self._report(ws,journal,journal.result())
            return
        if kind=='result_ack':
            journal=TaskJournal(msg['task_id'],self.provider)
            if self.owns(journal): journal.ack()
            return
        if kind=='reconcile_request':
            for item in msg['payload'].get('tasks',[]):
                if item.get('target_agent')!=self.agent_id: continue
                journal=TaskJournal(item['task_id'],self.provider)
                known=self.owns(journal)
                await ws.send(json.dumps(envelope('reconcile',{'known':known},task_id=item['task_id'])))
                if not known: continue
                if item.get('cancel_requested'): journal.request_cancel()
                if journal.result() and journal.result().get('cleanup_confirmed') is False: await self._observe(journal,wait=False)
                if journal.result(): await self._report(ws,journal,journal.result())
                elif journal.payload(): await self._handle_message(ws,journal.payload())
            return
        if kind in {'heartbeat','refresh_sessions','ack'}: await super()._handle_message(ws,msg)
        else: raise ValueError('Unsupported Hub protocol message')

    async def _execute_task(self,msg,on_state=None):
        journal=TaskJournal(msg['task_id'],self.provider)
        if journal.result(): return journal.result()
        if (journal.path/'cancel.json').exists(): return {'ok':False,'cancelled':True,'cleanup_confirmed':True}
        target=msg['payload']['remote_target']
        authorized_cwd(target['cwd'],self.local_agent.config.get('project_policy'))
        for old in TaskJournal.all(self.provider):  # Also block unresolved ownership from another pairing.
            payload=old.payload()
            if old.task_id!=journal.task_id and (old.path/'launch-intent').exists() and not old.result() and not read_json(old.path/'ack.json'):
                if payload and payload['payload'].get('session_id')==target['session_id']:
                    raise RuntimeError('Previous native turn has no exit confirmation; recovery required')
        if not journal.launch_once(): raise RuntimeError('Task already launched; reconcile without re-execution')
        return await super()._execute_task(msg,on_state)

    async def _send_or_spool(self,ws,msg):
        if msg.get('type')=='result':
            journal=TaskJournal(msg['task_id'],self.provider); result=msg['payload']
            if not (journal.path/'launch-intent').exists(): result={**result,'cleanup_confirmed':True}
            journal.finish(result)
            try: await self._report(self.current_ws or ws,journal,result)
            except Exception: pass  # Retain result until a durable Hub ACK.
        else: await super()._send_or_spool(ws,msg)

    async def _report(self,ws,journal,result):
        await ws.send(json.dumps(envelope('result',feedback(result),task_id=journal.task_id),ensure_ascii=False))

    async def _observe(self,journal,wait=True):
        if (journal.path/'shared.json').exists() or self.local_agent.config.get('codex_access')=='desktop':
            # The resident service owns its native turn and durable result.
            # Never kill its backend or pass it to independent CLI recovery.
            if not journal.result():
                saved=journal.payload()
                try:
                    from codex_shared import run_task
                    if saved and wait: await run_task(self.local_agent.config,saved)
                except Exception as exc:
                    journal.finish({'ok':False,'cleanup_confirmed':False,'error':'共享任务恢复未确认：'+str(exc)})
            elif journal.result().get('cleanup_confirmed') is False:
                try:
                    from codex_shared import reconcile_task
                    await reconcile_task(journal)
                except Exception: pass  # Keep the original blocking record/proof.
            if self.current_ws and journal.result():
                try: await self._report(self.current_ws,journal,journal.result())
                except Exception: pass
            return
        deadline=time.monotonic()+self.local_agent.timeout_seconds+25
        while wait and not journal.result() and time.monotonic()<deadline: await asyncio.sleep(.2)
        if not journal.result() or journal.result().get('cleanup_confirmed') is False:
            saved=journal.payload()
            if not saved: return
            payload=saved['payload']; lock=SessionLock(self.provider,payload['session_id'])
            try:
                if not lock.try_acquire(): return  # Still running: next reconciliation observes; never rerun.
                previous=lock.read(); state=read_json(journal.path/'status.json',{})
                if state.get('status')=='idle' or (previous.get('exit_proof') and previous.get('last_task_id')==journal.task_id):
                    result={'ok':False,'cleanup_confirmed':True,'error':'Exit confirmed, feedback lost; do not rerun automatically'}
                elif previous.get('task_id')==journal.task_id:
                    from task_process import recover
                    recover(previous)
                    lock.write({'version':2,'status':'idle','phase':'cleaned','exit_proof':True,'last_task_id':journal.task_id})
                    result={'ok':False,'cancelled':(journal.path/'cancel.json').exists(),'cleanup_confirmed':True,'error':'Previous guardian recovered; feedback unavailable'}
                else: raise RuntimeError('No verified task ownership record')
            except Exception:
                result={'ok':False,'cleanup_confirmed':False,'error':'Guardian outcome unconfirmed; native session remains blocked'}
            finally: lock.close()
            journal.finish(result)
        if self.current_ws:
            try: await self._report(self.current_ws,journal,journal.result())
            except Exception: pass

    async def exit_gracefully(self):
        self.stop_event.set()
        for journal in self.journals():
            if not journal.result() and not read_json(journal.path/'ack.json'): journal.request_cancel()
        if self.pending_tasks: await asyncio.gather(*self.pending_tasks,return_exceptions=True)
        if self.current_ws: await self.current_ws.close(code=1000,reason='Bridge exit after cleanup')
