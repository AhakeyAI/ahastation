"""User-local shared Codex transport and native-turn admission.

Desktop and Bridge MUST use this gateway to the same native server. The
gateway serializes turn/start (which otherwise steers an active native turn).
It owns neither the Desktop process nor its UI. No exec resume fallback.
"""
from __future__ import annotations
import asyncio
import contextlib
import json
import os
import secrets
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from codex_shared_rpc import RPC
from session_runtime import SessionLock
from task_journal import read_json, write_json


class Admission:
    def __init__(self,record=None,generation=None):
        self.condition=asyncio.Condition(); self.active={}; self.waiting={}; self.failed=False
        self.record=record;self.generation=generation
        self.desktop_results=read_json(record.with_name('desktop-exits.json'),{}) if record else {}
        self.retired={(thread,value['turn_id']) for thread,value in self.desktop_results.items()
            if value.get('generation')==generation and value.get('cleanup_confirmed') and value.get('turn_id')}
        for thread,value in (read_json(record,{}) if record else {}).items():
            self.active[thread]={**value,'done':asyncio.Event(),'finished':False,'blocked':True}

    def persist(self):
        if self.record:
            write_json(self.record,{thread:{key:active.get(key) for key in ('owner','turn','blocked','generation','commands',
                'needs_reconcile','reconcile_error','identity_unconfirmed')}
                for thread,active in self.active.items()})

    async def reserve(self, thread, owner, cancel=None, ready=None):
        async with self.condition:
            self.waiting[thread]=self.waiting.get(thread,0)+1
            try:
                while thread in self.active or (ready and not ready()):
                    if self.failed: raise RuntimeError('共享服务状态丢失，执行退出未确认')
                    active=self.active.get(thread)
                    recoverable=active and active['owner']=='desktop' and active.get('needs_reconcile') and \
                        active.get('generation')==self.generation and active.get('turn') and not active.get('identity_unconfirmed')
                    if active and active.get('blocked') and not recoverable:
                        raise RuntimeError(active.get('reconcile_error') or '该原生会话停止未确认，不能启动下一任务')
                    if cancel and cancel(): raise InterruptedError('等待项已取消，未发送原生指令')
                    try: await asyncio.wait_for(self.condition.wait(),.2)
                    except asyncio.TimeoutError: pass
                if self.failed: raise RuntimeError('共享服务状态丢失，执行退出未确认')
                if cancel and cancel(): raise InterruptedError('等待项已取消，未发送原生指令')
                reservation={'owner':owner,'turn':None,'done':asyncio.Event(),'finished':False,'generation':self.generation}
                self.active[thread]=reservation
                self.persist()  # Delivery intent survives service crash, before native send.
                return reservation
            finally:
                self.waiting[thread]-=1

    async def abandon(self, thread, reservation, *, expected_turn=None, expected_generation=None, desktop_result=None):
        async with self.condition:
            if self.active.get(thread) is reservation and (expected_turn is None or reservation.get('turn')==expected_turn) and \
                    (expected_generation is None or reservation.get('generation')==self.generation==expected_generation):
                if desktop_result and self.record:
                    self.desktop_results[thread]=desktop_result
                    write_json(self.record.with_name('desktop-exits.json'),self.desktop_results)
                if reservation.get('turn'): self.retired.add((thread,reservation['turn']))
                self.active.pop(thread); reservation['finished']=True; reservation['done'].set()
                self.persist()
                self.condition.notify_all()
                return True
            return False

    async def observe(self, message, connection=None):
        method=message.get('method'); params=message.get('params') or {}
        thread=params.get('threadId'); turn=params.get('turn') or {}
        native=turn.get('id') or params.get('turnId')
        if (thread,native) in self.retired: return  # A late old event cannot recreate occupancy.
        if method in ('item/started','item/completed'):
            item=params.get('item') or {};active=self.active.get(thread)
            if item.get('type')=='commandExecution' and active and active.get('turn')==native:
                active.setdefault('commands',{})[item['id']]={key:item.get(key) for key in ('id','type','status','processId','exitCode')}
                self.persist()
        if method=='turn/started':
            async with self.condition:
                reservation=self.active.get(thread)
                if reservation:
                    if reservation['turn'] not in (None,native):
                        reservation.update(blocked=True,identity_unconfirmed=True,reconcile_error='原生任务身份冲突，保留占用')
                    else: reservation['turn']=native
                else:
                    # Internal/native work that didn't pass admission is busy,
                    # never evidence for idle or permission to steer it.
                    self.active[thread]={'owner':'desktop','turn':native,'done':asyncio.Event(),'finished':False,
                        'generation':self.generation,'connection':connection}
                self.persist()
        elif method=='turn/completed':
            async with self.condition:
                reservation=self.active.get(thread)
                if reservation and reservation['turn']==native and turn.get('status') in ('completed','interrupted','failed'):
                    reservation['outcome']=turn; reservation['finished']=True; reservation['done'].set()
                    # Gateway releases Desktop and Bridge only after native
                    # command items and owned background terminals are checked.

    def authorize_control(self, thread, turn, owner):
        active=self.active.get(thread)
        if not active or active['turn']!=turn or active['owner']!=owner:
            raise RuntimeError('此原生任务属于另一端或已经结束；未中断、合并或覆盖其输入')

    def status(self, thread):
        active=self.active.get(thread)
        if self.failed: return 'cleanup-unconfirmed','共享执行服务状态未确认'
        if active:
            if active.get('blocked'): return 'cleanup-unconfirmed',active.get('reconcile_error') or '停止未确认，需要核对原生执行状态'
            if active.get('needs_reconcile'): return 'waiting',active.get('reconcile_error') or '正在核对断联前的桌面任务，Station 保留等待项'
            if not active.get('turn'): return 'waiting','等待执行'
            return 'running','Station 执行中' if active['owner'].startswith('bridge:') else '桌面执行中'
        if self.waiting.get(thread): return 'waiting','等待执行'
        return 'idle','已结束 / 可直接接续'


class Gateway:
    def __init__(self, native_url, native_token, capability, generation):
        self.native_url=native_url; self.native_token=native_token; self.capability=capability
        from codex_shared import directory
        self.generation=generation; self.admission=Admission(directory()/'active-turns.json',generation)
        self.desktop_peers=0; self.tasks={}; self.desktop_connections={}; self.thread_connections={}; self.settings={}; self.reconciling={}
        self.reconcile_interval=2.;self.reconcile_timeout=3.;self.next_desktop_check={}
        self.station_approvals={}

    def native_rpc(self, name='ahastation_shared_bridge'):
        return RPC(self.native_url,name,{'Authorization':'Bearer '+self.native_token})

    def desktop_connection(self,thread=None):
        if not self.desktop_connections: return None
        connection=self.thread_connections.get(thread) if thread else None
        if connection and connection not in self.desktop_connections.values(): return None
        return connection or next(iter(self.desktop_connections.values()))

    def desktop_rpc(self,thread=None):
        connection=self.desktop_connection(thread)
        if not connection: raise RuntimeError('原会话的桌面共享连接尚未恢复；不会另起执行进程')
        return BrokerRPC(connection)

    def recovery_rpc(self,thread):
        # Same native service and generation, never another execution process.
        # Only recovery readers/exact owned cancellation use this connection;
        # they never resume a thread, change settings, or start a model turn.
        connection=self.thread_connections.get(thread)
        if connection and connection in self.desktop_connections.values(): return BrokerRPC(connection)
        return self.native_rpc('ahastation_bridge_recovery')

    def desktop_matches(self,thread,reservation,native,generation,instance):
        return self.admission.active.get(thread) is reservation and reservation['owner']=='desktop' and \
            reservation.get('turn')==native and reservation.get('generation')==self.generation==self.admission.generation==generation and \
            (self.native_url,self.native_token)==instance and not reservation.get('identity_unconfirmed')

    def schedule_desktop_check(self,thread):
        reservation=self.admission.active.get(thread)
        if not reservation or reservation['owner']!='desktop': return
        if reservation.get('generation')!=self.generation:
            reservation.update(blocked=True,reconcile_error='共享执行实例已换代，旧任务退出无法确认；不会重新执行')
            self.admission.persist();return
        if not reservation.get('turn') or reservation.get('identity_unconfirmed'): return
        task=self.reconciling.get(thread)
        if task and not task.done(): return
        self.reconciling[thread]=asyncio.create_task(self.watch_desktop(thread,reservation))

    async def watch_desktop(self,thread,reservation):
        native=reservation['turn'];generation=self.generation;instance=(self.native_url,self.native_token)
        try:
            while self.desktop_matches(thread,reservation,native,generation,instance):
                await asyncio.sleep(max(0,self.next_desktop_check.get(thread,0)-time.monotonic()))
                if not self.desktop_matches(thread,reservation,native,generation,instance): return
                if await self.confirm_desktop(thread,reservation): return
                self.next_desktop_check[thread]=time.monotonic()+self.reconcile_interval
        finally:
            if self.reconciling.get(thread) is asyncio.current_task(): self.reconciling.pop(thread,None)

    async def confirm_desktop(self,thread,reservation):
        native=reservation.get('turn');generation=self.generation;instance=(self.native_url,self.native_token)
        if not native or not self.desktop_matches(thread,reservation,native,generation,instance): return False
        try:
            async with asyncio.timeout(self.reconcile_timeout), self.recovery_rpc(thread) as rpc:
                saved=await read_native_turn(rpc,thread,native)
                if saved and saved.get('status')=='inProgress':
                    if self.desktop_matches(thread,reservation,native,generation,instance):
                        reservation.update(blocked=False,needs_reconcile=self.desktop_connection(thread) is not reservation.get('connection'),
                            reconcile_error='桌面原生任务仍在执行，Station 保留等待项')
                        self.admission.persist()
                    return False
                await verify_exit(rpc,thread,saved,reservation.get('commands',{}))
                configuration=self.settings.get(thread,{})
                if configuration.get('_policy_turn')==native and not configuration.get('sandbox'):
                    metadata=(await rpc.call('thread/read',{'threadId':thread,'includeTurns':False}))['thread']
                    policy=await asyncio.to_thread(policy_context,metadata,rpc.info.get('codexHome'),native)
                    if self.desktop_matches(thread,reservation,native,generation,instance) and \
                            self.settings.get(thread) is configuration and configuration.get('_policy_turn')==native:
                        configuration.update(policy)
            if not self.desktop_matches(thread,reservation,native,generation,instance): return False
            return await self.admission.abandon(thread,reservation,expected_turn=native,expected_generation=generation,
                desktop_result={'generation':generation,'thread_id':thread,'turn_id':native,
                    'status':saved['status'],'cleanup_confirmed':True})
        except Exception as exc:
            if self.desktop_matches(thread,reservation,native,generation,instance):
                reason='原生状态核对超时' if isinstance(exc,TimeoutError) else '原生退出尚未确认：'+str(exc)[:180]
                reservation.update(blocked=True,needs_reconcile=True,reconcile_error=reason+'；保留占用，将自动重试')
                self.admission.persist()
            return False

    async def handler(self, client):
        if client.request.path!='/'+self.capability or client.request.headers.get('Origin'):
            await client.close(1008,'Unauthorized local connection'); return
        desktop=False; pending={}; configurations={}; dispatch=set()
        async with connect(self.native_url,additional_headers={'Authorization':'Bearer '+self.native_token},max_size=16*1024*1024) as backend:
            connection={'ws':backend,'pending':{},'listeners':set(),'ready':False}
            async def request(message):
                nonlocal desktop
                method=message.get('method'); params=message.get('params') or {}; request_id=message.get('id')
                if method=='initialize':
                    info=params.get('clientInfo') or {}
                    if not desktop and 'desktop' in str(info.get('name','')).lower():
                        desktop=True; self.desktop_peers+=1;connection['client_info']=info
                if method and method.startswith('bridge/'):
                    try:
                        result=await self.local_call(method,params)
                        await client.send(json.dumps({'id':request_id,'result':result}))
                    except Exception as exc:
                        await client.send(json.dumps({'id':request_id,'error':{'code':-32001,'message':str(exc)}}))
                    return
                owner='desktop' if desktop else 'external:'+str(id(client))
                if not method and 'id' in message:
                    match=next((a for a in self.station_approvals.values() if a['connection'] is connection and a['native_id']==request_id),None)
                    if match:
                        if match.get('decided'): return
                        choice=(message.get('result') or {}).get('decision')
                        match.update(decided=True,decision='allow' if choice in ('accept','approved','acceptForSession') else 'deny')
                reservation=None; thread=params.get('threadId')
                try:
                    active=self.admission.active.get(thread)
                    if method in ('thread/resume','thread/settings/update') and active and active['owner']!=owner:
                        raise RuntimeError('此会话正在由另一端执行；原生配置暂不能改写，请等待该任务结束')
                    if method in ('turn/start','thread/queue/start'):
                        # Preserve Desktop's own steering; another endpoint's
                        # input always waits and becomes a separate native turn.
                        if not (method=='turn/start' and active and active['owner']==owner and owner=='desktop' and
                                active.get('connection') is connection and not active.get('blocked') and
                                not active.get('needs_reconcile') and not active.get('finished')):
                            reservation=await self.admission.reserve(thread,owner)
                            if desktop:
                                reservation['connection']=connection;self.thread_connections[thread]=connection
                            pending[request_id]=(thread,reservation)
                    elif method in ('turn/interrupt','turn/steer'):
                        # The original local Desktop may stop the exact Station
                        # turn running through its own connection. This never
                        # permits steering or a different Desktop connection.
                        desktop_stop=(method=='turn/interrupt' and desktop and active and
                            active['owner'].startswith('bridge:') and active.get('turn')==params.get('turnId') and
                            active.get('generation')==self.generation and not active.get('identity_unconfirmed') and
                            not active.get('finished') and self.thread_connections.get(thread) is connection)
                        if not desktop_stop:
                            self.admission.authorize_control(thread,params.get('turnId') or params.get('expectedTurnId'),owner)
                        if method=='turn/interrupt' and owner=='desktop':
                            # Preserve the Desktop's own stop action, while
                            # preventing this build's foreground-shell detach.
                            async with BrokerRPC(connection) as rpc:
                                try: await stop_owned_terminals(rpc,thread,params['turnId'],active.get('commands',{}))
                                except Exception: pass  # Native interrupt still runs; proof remains strict.
                    if desktop and method in ('thread/start','thread/resume','thread/settings/update','turn/start'):
                        configurations[request_id]=(method,params)
                    await backend.send(json.dumps(message))
                except Exception as exc:
                    if reservation: await self.admission.abandon(thread,reservation)
                    await client.send(json.dumps({'id':request_id,'error':{'code':-32001,'message':str(exc)}}))
            async def upstream():
                async for raw in client:
                    message=json.loads(raw)
                    # Don't block the reader while a turn waits: Desktop stop
                    # and other threads must still reach the native server.
                    task=asyncio.create_task(request(message)); dispatch.add(task); task.add_done_callback(dispatch.discard)
            async def downstream():
                async for raw in backend:
                    message=json.loads(raw); await self.admission.observe(message,connection if desktop else None)
                    if message.get('method')=='turn/started':
                        thread=(message.get('params') or {}).get('threadId');active=self.admission.active.get(thread)
                        if active and active['owner'].startswith('bridge:'):
                            from task_journal import TaskJournal
                            journal=TaskJournal(active['owner'].split(':',1)[1],'codex')
                            mapping=read_json(journal.path/'shared.json') or {}
                            if mapping.get('generation')==self.generation and mapping.get('phase')=='submitting':
                                mapping.update(turn_id=active['turn']);write_json(journal.path/'shared.json',mapping)
                    if message.get('method')=='turn/completed':
                        thread=(message.get('params') or {}).get('threadId')
                        active=self.admission.active.get(thread)
                        if active and active['owner']=='desktop' and active.get('finished'):
                            self.schedule_desktop_check(thread)
                    configuration=configurations.pop(message.get('id'),None) if 'method' not in message else None
                    if configuration and not message.get('error'):
                        method,params=configuration; result=message.get('result') or {}
                        thread=(result.get('thread') or {}).get('id') or params.get('threadId')
                        if method in ('thread/start','thread/resume'):
                            self.settings[thread]=result
                            self.thread_connections[thread]=connection
                        else:
                            saved=self.settings.get(thread)
                            if saved:
                                for key in ('model','approvalPolicy'):
                                    if params.get(key) is not None: saved[key]=params[key]
                                if params.get('sandboxPolicy') is not None: saved['sandbox']=params['sandboxPolicy']
                                if params.get('permissions') is not None:
                                    # Named/custom profiles can't be derived by
                                    # guessing roots; require a native response.
                                    saved['sandbox']=None
                                    saved['_policy_turn']=(result.get('turn') or {}).get('id') if method=='turn/start' else None
                    broker=connection['pending'].pop(message.get('id'),None) if 'method' not in message else None
                    if broker:
                        if not broker.done():
                            if message.get('error'): broker.set_exception(RuntimeError(str(message['error'])))
                            else: broker.set_result(message.get('result'))
                        continue  # Private response; GUI still receives native turn events below.
                    if 'method' not in message and str(message.get('id','')).startswith('ahastation-bridge:'):
                        continue  # A timed-out private query's late reply isn't a Desktop request.
                    if desktop and not connection['ready'] and 'result' in message:
                        connection['ready']=True;connection['info']=message['result'];self.desktop_connections[id(client)]=connection
                        for thread,previous in list(self.thread_connections.items()):
                            if previous not in self.desktop_connections.values() and \
                                    previous.get('client_info',{}).get('name')==connection['client_info'].get('name'):
                                self.thread_connections[thread]=connection
                        for thread in list(self.admission.active): self.schedule_desktop_check(thread)
                        async with self.admission.condition: self.admission.condition.notify_all()
                    if 'method' in message:
                        if desktop and 'id' in message:
                            params=message.get('params') or {}
                            existing=next((a for a in self.station_approvals.values() if a['connection'] is connection and a['native_id']==message['id']),None)
                            if not existing:
                                identity=str(uuid.uuid4())
                                self.station_approvals[identity]={'id':identity,'native_id':message['id'],'method':message['method'],
                                    'params':params,'threadId':params.get('threadId'),'turnId':params.get('turnId'),
                                    'connection':connection,'decided':False}
                        for listener in list(connection['listeners']): await listener.put(message)
                    entry=pending.pop(message.get('id'),None) if 'method' not in message else None
                    if entry:
                        thread,reservation=entry
                        if message.get('error'):
                            if reservation.get('turn'): reservation['blocked']=True;self.admission.persist()
                            else: await self.admission.abandon(thread,reservation)
                        else:
                            turn=(message.get('result') or {}).get('turn') or {}
                            if reservation['turn'] not in (None,turn.get('id')): reservation['blocked']=True;self.admission.persist()
                            else: reservation['turn']=turn.get('id')
                            self.admission.persist()
                    await client.send(raw)
            readers=[asyncio.create_task(upstream()),asyncio.create_task(downstream())]
            try: await asyncio.wait(readers,return_when=asyncio.FIRST_COMPLETED)
            finally:
                if desktop: self.desktop_peers-=1
                self.desktop_connections.pop(id(client),None)
                for future in connection['pending'].values():
                    if not future.done(): future.set_exception(ConnectionError('桌面共享连接丢失，任务状态未确认'))
                for listener in list(connection['listeners']): await listener.put({'method':'bridge/connectionLost'})
                for task in readers+list(dispatch): task.cancel()
                await asyncio.gather(*readers,*list(dispatch),return_exceptions=True)
                # A client disconnect is not cancellation or exit proof. A
                # reservation with uncertain delivery blocks this generation.
                for thread,reservation in pending.values():
                    if self.admission.active.get(thread) is reservation: reservation['blocked']=True
                if desktop:
                    for thread,reservation in list(self.admission.active.items()):
                        if reservation['owner']=='desktop' and (reservation.get('connection') is connection or
                                self.thread_connections.get(thread) is connection):
                            reservation['needs_reconcile']=True
                            if not reservation.get('blocked') or not reservation.get('reconcile_error'):
                                reservation['reconcile_error']='桌面连接中断，正在核对原生任务；未取消任务，将自动重试'
                            if not reservation.get('turn'): reservation['blocked']=True
                            self.schedule_desktop_check(thread)
                self.admission.persist()

    async def local_call(self, method, params):
        if method in ('bridge/approvals','bridge/approval/decide','bridge/native/stop'):
            from project_policy import authorized_cwd
            config=params['config']
            if method=='bridge/approval/decide':
                approval=self.station_approvals.get(params['approvalId'])
                if not approval: raise ValueError('审批已处理或过期')
                thread=approval['threadId']
            else: thread=params['threadId']
            async with self.recovery_rpc(thread) as rpc:
                metadata=(await rpc.call('thread/read',{'threadId':thread,'includeTurns':False}))['thread']
                cwd=authorized_cwd(metadata['cwd'],config.get('project_policy'))
                check_permissions(self.settings.get(thread) or {},config,cwd)
                if method=='bridge/native/stop':
                    native=params['turnId'];active=self.admission.active.get(thread)
                    if not active:
                        saved=await read_native_turn(rpc,thread,native);await verify_exit(rpc,thread,saved)
                        return {'cleanup_confirmed':True}
                    if active.get('turn')!=native: raise ValueError('精确原生轮次已变化，请刷新后核对')
                    await stop_owned_terminals(rpc,thread,native,active.get('commands',{}))
                    await rpc.call('turn/interrupt',{'threadId':thread,'turnId':native})
                    saved=await read_native_turn(rpc,thread,native);await verify_exit(rpc,thread,saved,active.get('commands',{}))
                    return {'cleanup_confirmed':True}
            if method=='bridge/approvals':
                return {'approvals':[{'id':a['id'],'tool':a['method'],'turnId':a['turnId'],'decided':a['decided'],'decision':a.get('decision'),
                    'description':str(a['params'].get('reason') or a['params'].get('command') or a['method'])[:12000],
                    'supported':a['method'] in ('item/commandExecution/requestApproval','item/fileChange/requestApproval') and not a['params'].get('additionalPermissions')}
                    for a in self.station_approvals.values() if a['threadId']==thread]}
            # Metadata verification above yields to the Desktop connection.
            # Recheck the single decision gate after that await, before send.
            if approval['decided']:return {'decided':True,'decision':approval['decision']}
            if params['decision'] not in ('allow','deny'): raise ValueError('无效审批决定')
            if approval['method'] not in ('item/commandExecution/requestApproval','item/fileChange/requestApproval') or approval['params'].get('additionalPermissions'):
                raise ValueError('此原生交互或权限扩展需在桌面本机处理')
            for key in ('cwd','grantRoot'):
                if approval['params'].get(key): authorized_cwd(approval['params'][key],config.get('project_policy'))
            active=self.admission.active.get(thread)
            if not active or approval.get('turnId') and active.get('turn')!=approval['turnId']: raise ValueError('审批属于旧轮次')
            approval.update(decided=True,decision=params['decision'])
            await approval['connection']['ws'].send(json.dumps({'id':approval['native_id'],'result':{'decision':'accept' if params['decision']=='allow' else 'decline'}}))
            return {'decided':True,'decision':params['decision']}
        if method=='bridge/status':
            thread=params.get('threadId')
            self.schedule_desktop_check(thread)
            return {'generation':self.generation,'desktop_connected':bool(self.desktop_connections),
                'native_turn_id':(self.admission.active.get(thread) or {}).get('turn'),
                'reservation_owner':(self.admission.active.get(thread) or {}).get('owner'),
                'execution_status':self.admission.status(params.get('threadId'))[0],
                'detail':self.admission.status(params.get('threadId'))[1],
                'configuration':{key:value for key,value in self.settings.get(params.get('threadId'),{}).items()
                    if key in ('sandbox','approvalPolicy','model')}}
        if method=='bridge/task/submit':
            # Journal path isn't supplied by a remote peer. It is derived from
            # a validated UUID and the current local provider's durable receipt.
            from task_journal import TaskJournal
            journal=TaskJournal(str(uuid.UUID(params['taskId'])),'codex')
            if not journal.payload(): raise ValueError('No locally acknowledged task receipt')
            if journal.result(): return {'accepted':True}
            mapping=read_json(journal.path/'shared.json')
            if mapping and mapping.get('generation')!=self.generation:
                raise RuntimeError('服务已重启，原任务退出未确认；不能重新执行')
            if journal.task_id not in self.tasks:
                if mapping: raise RuntimeError('原提交交付状态未确认，不能重新执行')
                if not self.desktop_connections: raise RuntimeError('桌面尚未通过联动入口连接共享服务')
                self.tasks[journal.task_id]=asyncio.create_task(self.execute(journal,params['config']))
            return {'accepted':True}
        if method=='bridge/task/state':
            from task_journal import TaskJournal
            journal=TaskJournal(str(uuid.UUID(params['taskId'])),'codex')
            task=self.tasks.get(journal.task_id)
            mapping=read_json(journal.path/'shared.json') or {}
            return {'known':bool(task and not task.done()),'generation':self.generation,
                'status':read_json(journal.path/'status.json',{}).get('status','unknown'),
                'threadId':mapping.get('thread_id'),'turnId':mapping.get('turn_id'),'result':journal.result()}
        if method=='bridge/task/reconcile':
            from task_journal import TaskJournal
            journal=TaskJournal(str(uuid.UUID(params['taskId'])),'codex')
            mapping=read_json(journal.path/'shared.json') or {}
            result=journal.result()
            if result and result.get('cleanup_confirmed'): return {'confirmed':True}
            task=self.tasks.get(journal.task_id)
            if task and not task.done(): return {'confirmed':False,'known':True}
            if mapping.get('generation')!=self.generation or not mapping.get('turn_id'):
                raise RuntimeError('原生实例或 turn ID 无法核对，停止未确认；本次未重新执行')
            thread=mapping['thread_id']; native=mapping['turn_id']
            async with self.recovery_rpc(thread) as rpc:
                if (journal.path/'cancel.json').exists():
                    active=self.admission.active.get(thread)
                    self.admission.authorize_control(thread,native,'bridge:'+journal.task_id)
                    try: await stop_owned_terminals(rpc,thread,native,(active or {}).get('commands',{}))
                    except Exception: pass
                    try: await rpc.call('turn/interrupt',{'threadId':thread,'turnId':native})
                    except Exception: pass  # Already ended / delivery uncertain; verify, never assume.
                saved=await read_native_turn(rpc,thread,native)
                await verify_exit(rpc,thread,saved,(self.admission.active.get(thread) or {}).get('commands',{}))
            lock=SessionLock('codex',thread)
            try:
                if not lock.try_acquire(): return {'confirmed':False}
                old=lock.read()
                if old.get('task_id')!=journal.task_id: raise RuntimeError('恢复记录已属于另一任务，不能清除')
                lock.write({**old,'status':'idle','exit_proof':True,'last_task_id':journal.task_id})
            finally: lock.close()
            active=self.admission.active.get(thread)
            if active and active['owner']=='bridge:'+journal.task_id:
                await self.admission.abandon(thread,active)
            text='\n'.join(item.get('text','') for item in saved.get('items',[]) if item.get('type')=='agentMessage')
            stopped=saved['status']=='interrupted'
            journal.finish({'ok':saved['status']=='completed' and not stopped,'cancelled':stopped,
                'turnOutcome':saved['status'],'cleanup_confirmed':True,'json':{'last_message':text},
                'error':str(saved.get('error') or '') if saved['status']=='failed' else ('' if not stopped else '原生任务已中断')})
            return {'confirmed':True}
        raise ValueError('Unsupported local method')

    async def execute(self, journal, config):
        """Resident task survives Bridge/Hub loss; exact native identity persisted."""
        from project_policy import authorized_cwd
        payload=journal.payload()['payload']; thread=payload.get('session_id')
        cancel=lambda:(journal.path/'cancel.json').exists()
        lock=SessionLock('codex',thread or '')
        reservation=None; acquired=False; mapping=None; prior={};previous_verified=False
        result={'ok':False,'cleanup_confirmed':True}
        try:
            if not thread: raise ValueError('桌面联动仅支持明确的原生会话 ID，不会新建替代会话')
            cwd=authorized_cwd(payload['cwd'],config.get('project_policy'))
            while not lock.try_acquire():
                if cancel(): raise InterruptedError('等待项已取消，未发送原生指令')
                await asyncio.sleep(.2)
            acquired=True
            result['cleanup_confirmed']=False
            prior=lock.read()
            if prior and prior.get('status')!='idle':
                result['cleanup_confirmed']=False
                raise RuntimeError('原会话任务退出未确认，不能接续')
            previous_verified=True;result['cleanup_confirmed']=True
            write_json(journal.path/'status.json',{'status':'waiting'})
            reservation=await self.admission.reserve(thread,'bridge:'+journal.task_id,cancel,
                ready=lambda:self.desktop_connection(thread) is not None)
            if config.get('station_slot_file'):
                write_json(journal.path/'status.json',{'status':'waiting-slot'})
                while not (journal.path/'slot.json').exists():
                    if cancel():raise InterruptedError('等待名额的接续已停止，未发送原生指令')
                    await asyncio.sleep(.1)
            async with self.desktop_rpc(thread) as rpc:
                metadata=(await rpc.call('thread/read',{'threadId':thread,'includeTurns':False}))['thread']
                if metadata['id']!=thread or not Path(metadata['cwd']).samefile(cwd): raise ValueError('原生会话或项目目录不匹配')
                if metadata.get('status',{}).get('type')=='notLoaded':
                    resume={'threadId':thread,'excludeTurns':True}
                    if metadata.get('model'): resume['model']=metadata['model']
                    resumed=await rpc.call('thread/resume',resume)
                    if resumed['thread']['id']!=thread: raise RuntimeError('原生服务返回不同会话，未执行')
                    if not Path(resumed.get('cwd') or resumed['thread']['cwd']).samefile(cwd): raise RuntimeError('恢复的原生项目目录不匹配，未执行')
                    self.settings[thread]=resumed
                # On a loaded Desktop thread resume can reset effective
                # permissions to CLI defaults. Keep the settings acknowledged
                # on the Desktop socket, rather than resuming it again.
                resumed=self.settings.get(thread)
                if not resumed: raise RuntimeError('原生会话配置尚未由联动桌面确认，请在桌面打开此原会话一次；不会回退独立执行')
                # Keep the original model and policy; reject a permission
                # ceiling mismatch rather than changing Desktop settings.
                check_permissions(resumed, config, cwd)
                if cancel(): raise InterruptedError('等待项已取消，未发送原生指令')
                mapping={'generation':self.generation,'thread_id':thread,'cwd':str(cwd),
                    'task_id':journal.task_id,'phase':'submitting','turn_id':None}
                write_json(journal.path/'shared.json',mapping)
                lock.write({'status':'running','containment':'shared-native-turn','task_id':journal.task_id,'generation':self.generation})
                result['cleanup_confirmed']=False
                reply=await rpc.call('turn/start',{'threadId':thread,'input':[{'type':'text','text':payload['objective']}],
                    'clientUserMessageId':journal.task_id})
                native=reply['turn']['id']
                if reservation['turn'] not in (None,native): raise RuntimeError('原生任务准入身份不一致，执行状态未确认')
                reservation['turn']=native
                mapping.update(turn_id=native,phase='running'); write_json(journal.path/'shared.json',mapping)
                write_json(journal.path/'status.json',{'status':'running'})
                deadline=asyncio.get_running_loop().time()+float(config.get('timeout_seconds',300)); interrupted=False
                while not reservation['done'].is_set():
                    if (cancel() or asyncio.get_running_loop().time()>=deadline) and not interrupted:
                        self.admission.authorize_control(thread,native,'bridge:'+journal.task_id)
                        # Interrupting a turn can detach a unified-exec shell
                        # in this Desktop version. Stop only native terminals
                        # whose item IDs belong to THIS turn, never all of the
                        # thread's terminals or the shared backend.
                        try: await stop_owned_terminals(rpc,thread,native,reservation.get('commands',{}))
                        except Exception: pass  # Still request the exact turn interrupt; keep proof strict.
                        await rpc.call('turn/interrupt',{'threadId':thread,'turnId':native})
                        interrupted=True; deadline=asyncio.get_running_loop().time()+30
                    if interrupted and asyncio.get_running_loop().time()>=deadline: raise RuntimeError('停止未确认：未收到原生任务结束事件')
                    try: event=await asyncio.wait_for(rpc.events.get(),.2)
                    except asyncio.TimeoutError: continue
                    if event.get('method')=='bridge/connectionLost': raise RuntimeError('共享服务连接丢失，停止未确认')
                    await self.admission.observe(event)
                turn=reservation.get('outcome') or {}
                # Terminal notification alone is not a subprocess exit proof.
                # Require native command items and owned background terminals.
                saved=await read_native_turn(rpc,thread,native)
                await verify_exit(rpc,thread,saved,reservation.get('commands',{}))
                text='\n'.join(item.get('text','') for item in saved.get('items',[]) if item.get('type')=='agentMessage')
                result={'ok':saved['status']=='completed','cancelled':saved['status']=='interrupted',
                    'turnOutcome':saved['status'],'cleanup_confirmed':True,'json':{'last_message':text},
                    'error':str(saved.get('error') or '') if saved['status']=='failed' else ('' if not interrupted else '原生任务已中断')}
                mapping.update(phase='finished'); write_json(journal.path/'shared.json',mapping)
        except InterruptedError as exc:
            result={'ok':False,'cancelled':True,'cleanup_confirmed':True,'error':str(exc)}
        except Exception as exc: result.update(ok=False,error=str(exc))
        finally:
            if acquired and previous_verified:
                lock.write({'status':'idle' if result.get('cleanup_confirmed') else 'cleanup-unconfirmed',
                    'containment':'shared-native-turn','task_id':journal.task_id,'last_task_id':journal.task_id,
                    'generation':self.generation,'exit_proof':result.get('cleanup_confirmed') is True})
            lock.close()
            if reservation:
                if result.get('cleanup_confirmed'): await self.admission.abandon(thread,reservation)
                else: reservation['blocked']=True;self.admission.persist()
            journal.finish(result)


class BrokerRPC:
    """RPC on the actual Desktop socket, without owning/closing that socket."""
    def __init__(self,connection): self.connection=connection; self.events=asyncio.Queue(); self.requests=set();self.info=connection.get('info',{})
    async def __aenter__(self): self.connection['listeners'].add(self.events); return self
    async def call(self,method,params=None,timeout=30):
        request='ahastation-bridge:'+str(uuid.uuid4());future=asyncio.get_running_loop().create_future()
        self.connection['pending'][request]=future;self.requests.add(request)
        try:
            await self.connection['ws'].send(json.dumps({'id':request,'method':method,'params':params or {}}))
            return await asyncio.wait_for(asyncio.shield(future),timeout)
        finally:
            self.connection['pending'].pop(request,None); self.requests.discard(request)
            if not future.done(): future.cancel()
    async def __aexit__(self,*args): self.connection['listeners'].discard(self.events)


def policy_context(thread,home,turn):
    """Only verified local execution metadata for a native named profile.

    The API acknowledges named profiles without returning their effective
    sandbox. Read the matching turn_context locally, never upload history.
    """
    from codex_desktop import local_path
    path=local_path(thread['path']);base=local_path(home)
    if not path.is_relative_to(base/'sessions'): raise ValueError('执行权限记录不在本地会话目录')
    found=None
    with path.open(encoding='utf-8') as stream:
        meta=json.loads(stream.readline(2*1024*1024)).get('payload',{})
        if meta.get('id')!=thread['id']: raise ValueError('执行权限记录会话身份不匹配')
        for line in stream:
            value=json.loads(line)
            if value.get('type')=='turn_context' and value.get('payload',{}).get('turn_id')==turn: found=value['payload']
    if not found or not Path(found['cwd']).samefile(thread['cwd']): raise ValueError('原生任务执行权限及项目无法确认')
    sandbox=found.get('sandbox_policy') or {};kind={'read-only':'readOnly','workspace-write':'workspaceWrite','danger-full-access':'dangerFullAccess'}.get(sandbox.get('type'))
    if not kind: raise ValueError('当前原生权限格式未支持，不能猜测授权')
    policy={'type':kind,**{new:sandbox[old] for old,new in [('writable_roots','writableRoots'),('network_access','networkAccess')]
        if old in sandbox}}
    return {'sandbox':policy,'approvalPolicy':found.get('approval_policy'),'model':found.get('model')}


def check_permissions(resumed, config, cwd):
    """Use the original thread policy; reject a ceiling mismatch, don't mutate it."""
    sandbox=resumed.get('sandbox') or {}
    kind=sandbox.get('type')
    allowed=config.get('desktop_permission','read-only')
    full=allowed=='full-access' and config.get('full_access_confirmed') is True
    if kind not in ('readOnly','workspaceWrite','dangerFullAccess') or (kind=='dangerFullAccess' and not full) or (allowed=='read-only' and kind!='readOnly'):
        raise ValueError('原桌面会话执行权限超过 Bridge 授权，请在桌面调整会话权限或在 Bridge 确认相应授权；本次未执行')
    if kind=='workspaceWrite':
        from project_policy import authorized_cwd
        for path in sandbox.get('writableRoots',[]): authorized_cwd(path,config.get('project_policy'))
    # Requests needing UI approval stay with the Desktop client. Bridge never
    # answers those approvals on the user's behalf or raises permissions.


async def read_native_turn(rpc,thread,native):
    cursor=None; seen=set()
    while True:
        page=await rpc.call('thread/turns/list',{'threadId':thread,'limit':20,'itemsView':'full','sortDirection':'desc','cursor':cursor})
        match=next((turn for turn in page.get('data',[]) if turn.get('id')==native),None)
        if match:
            if match.get('itemsView')!='full': raise RuntimeError('原生接口未提供完整任务项，执行命令退出未确认')
            return match
        cursor=page.get('nextCursor')
        if not cursor: return None
        if cursor in seen: raise RuntimeError('原生任务目录游标循环，状态未确认')
        seen.add(cursor)


async def read_backgrounds(rpc,thread):
    cursor=None; seen=set(); rows=[]
    while True:
        page=await rpc.call('thread/backgroundTerminals/list',{'threadId':thread,'cursor':cursor})
        if 'data' not in page: raise RuntimeError('原生后台命令状态不可验证')
        rows.extend(page['data']);cursor=page.get('nextCursor')
        if not cursor: return rows
        if cursor in seen: raise RuntimeError('后台命令目录游标循环，状态未确认')
        seen.add(cursor)


async def verify_exit(rpc,thread,saved,observed=None,seen=None):
    if not saved or saved.get('status') not in ('completed','interrupted','failed'):
        raise RuntimeError('原生结束事件与持久化任务状态尚未一致，停止未确认')
    commands=dict(observed or {})
    commands.update({item['id']:item for item in saved.get('items',[]) if item.get('type')=='commandExecution'})
    if any(item.get('status') not in ('completed','failed','declined') or (
        item.get('status')!='declined' and type(item.get('exitCode')) is not int) for item in commands.values()):
        raise RuntimeError('原生执行命令退出未确认')
    backgrounds=await read_backgrounds(rpc,thread)
    owned_ids={item['id'] for item in saved.get('items',[]) if item.get('id')}|set(commands)
    if backgrounds:
        # In-flight items can be absent from persisted history in this build.
        # An unassociated terminal is NOT evidence that our commands exited.
        raise RuntimeError('原会话后台命令仍未退出或归属未确认；不会清理桌面其他任务')
    seen=set(seen or ())
    if thread in seen or len(seen)>=32: raise RuntimeError('原生子会话退出链无法确认')
    seen.add(thread)
    for item in saved.get('items',[]):
        if item.get('type')!='collabAgentToolCall': continue
        for child in item.get('receiverThreadIds',[]):
            metadata=(await rpc.call('thread/read',{'threadId':child,'includeTurns':False}))['thread']
            if metadata.get('parentThreadId')!=thread or metadata.get('status',{}).get('type')!='idle':
                raise RuntimeError('原生子会话仍在执行或归属未确认；不会中断其他会话')
            page=await rpc.call('thread/turns/list',{'threadId':child,'limit':1,'itemsView':'full','sortDirection':'desc'})
            turns=page.get('data',[])
            if not turns or turns[0].get('itemsView')!='full': raise RuntimeError('原生子会话执行项未确认')
            await verify_exit(rpc,child,turns[0],seen=seen)


async def stop_owned_terminals(rpc,thread,native,observed=None):
    saved=await read_native_turn(rpc,thread,native)
    if not saved: return
    owned={item['id'] for item in saved.get('items',[]) if item.get('type')=='commandExecution'}|set(observed or {})
    for terminal in await read_backgrounds(rpc,thread):
        if terminal.get('itemId') in owned:
            await rpc.call('thread/backgroundTerminals/terminate',{'threadId':thread,'processId':terminal['processId']})
    # A successful request/terminated flag is NOT used as an exit proof.


async def run(binary, directory):
    directory=Path(directory); directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    from codex_shared import save_endpoint, private_file
    singleton=SessionLock('codex-shared-service','current-os-user')
    if not singleton.try_acquire(): singleton.close(); return
    token=secrets.token_urlsafe(32); token_file=directory/'native-token'
    private_file(token_file,token)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); native_url='ws://127.0.0.1:'+str(sock.getsockname()[1])
    generation=str(uuid.uuid4()); capability=secrets.token_urlsafe(32)
    job=None; proc=None; log=(directory/'service.log').open('ab')
    try:
        command=[binary,'-c','features.code_mode_host=true','app-server','--listen',native_url,
            '--ws-auth','capability-token','--ws-token-file',str(token_file)]
        if os.name=='nt':
            from task_process import WindowsJob
            job=WindowsJob(); proc=job.spawn(command,stdin=subprocess.DEVNULL,stdout=log,stderr=log,creationflags=4)
            job.attach_and_resume(proc)
        else: proc=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
        for attempt in range(150):
            try:
                async with connect(native_url,additional_headers={'Authorization':'Bearer '+token}): break
            except Exception:
                if proc.poll() is not None: raise RuntimeError('Native server exited; inspect service.log')
                await asyncio.sleep(.1)
        else: raise RuntimeError('Native server startup timed out')
        gateway=Gateway(native_url,token,capability,generation)
        async with serve(gateway.handler,'127.0.0.1',0,max_size=16*1024*1024) as server:
            save_endpoint(directory,{'url':'ws://127.0.0.1:'+str(server.sockets[0].getsockname()[1])+'/'+capability,
                'generation':generation,'binary':binary,'native_pid':proc.pid})
            while proc.poll() is None:
                write_json(directory/'status.json',{'generation':generation,'heartbeat':time.monotonic(),
                    'desktop_connected':bool(gateway.desktop_connections),'native_pid':proc.pid})
                await asyncio.sleep(.25)
            gateway.admission.failed=True
    finally:
        # This resident service is never stopped by Bridge shutdown. If its
        # native server dies, durable mapping/lock records stay unconfirmed.
        if job: job.close()
        elif proc and proc.poll() is None: proc.terminate()
        if proc:
            with contextlib.suppress(subprocess.TimeoutExpired): proc.wait(timeout=10)
        token_file.unlink(missing_ok=True); log.close(); singleton.close()


async def protocol_probe():
    """Frozen transport smoke, isolated fixture only; NOT Desktop acceptance."""
    import tempfile
    with tempfile.TemporaryDirectory(prefix='bridge-shared-frozen-') as folder:
        old=os.environ.get('POCKET_VIBE_STATE_DIR');os.environ['POCKET_VIBE_STATE_DIR']=folder
        try:
            thread='fixture-thread';turn={'id':'fixture-turn','status':'inProgress','items':[],'itemsView':'full'}
            async def fixture(ws):
                async for raw in ws:
                    message=json.loads(raw)
                    method=message.get('method');result={}
                    if method=='initialize':result={'codexHome':folder}
                    elif method=='turn/start':
                        await ws.send(json.dumps({'method':'turn/started','params':{'threadId':thread,'turn':turn}}))
                        result={'turn':turn}
                    elif method=='thread/turns/list':result={'data':[turn]}
                    elif method=='thread/backgroundTerminals/list':result={'data':[]}
                    if 'id' in message: await ws.send(json.dumps({'id':message['id'],'result':result}))
            async with serve(fixture,'127.0.0.1',0) as native:
                gateway=Gateway('ws://127.0.0.1:'+str(native.sockets[0].getsockname()[1]),'test','test-cap','test-generation')
                gateway.reconcile_interval=.05
                async with serve(gateway.handler,'127.0.0.1',0) as server:
                    url='ws://127.0.0.1:'+str(server.sockets[0].getsockname()[1])+'/test-cap'
                    async with RPC(url,'codex_desktop_probe') as rpc:
                        result=await rpc.call('bridge/status',{})
                        assert result['desktop_connected'] and result['generation']=='test-generation'
                        await rpc.call('turn/start',{'threadId':thread,'input':[{'type':'text','text':'fixture'}]})
                        waiter=asyncio.create_task(gateway.admission.reserve(thread,'bridge:fixture'))
                        await asyncio.sleep(.02);assert not waiter.done()
                    # No completion notification is sent: only the native
                    # read-only answer changes after the subscriber disconnects.
                    turn['status']='completed'
                    async with RPC(url) as observer:
                        await observer.call('bridge/status',{'threadId':thread})
                        slot=await asyncio.wait_for(waiter,5)
                        proof=read_json(gateway.admission.record.with_name('desktop-exits.json'))[thread]
                        assert proof['turn_id']==turn['id'] and proof['cleanup_confirmed']
                        await gateway.admission.abandon(thread,slot)
                    pending=list(gateway.reconciling.values())
                    for task in pending: task.cancel()
                    await asyncio.gather(*pending,return_exceptions=True)
            print(json.dumps({'ok':True,'shared_protocol_smoke':True,'lost_completion_recovered':True,
                'waiting_slot_woken':True,'fixture_only':True}))
        finally:
            if old is None: os.environ.pop('POCKET_VIBE_STATE_DIR',None)
            else: os.environ['POCKET_VIBE_STATE_DIR']=old


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(); parser.add_argument('--binary'); parser.add_argument('--directory');parser.add_argument('--probe',action='store_true')
    args=parser.parse_args()
    if args.probe: asyncio.run(protocol_probe())
    elif args.binary and args.directory: asyncio.run(run(args.binary,args.directory))
    else: parser.error('--binary and --directory required')
