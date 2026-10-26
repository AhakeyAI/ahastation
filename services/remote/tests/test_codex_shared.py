"""Real async WebSocket protocol regression, mutable native-turn fixture.

No model is called. The fixture deliberately STEERS a busy turn/start, as the
installed native schema permits, so queue/admission bugs are observable.
"""
import asyncio
import json
import os
import sys
import tempfile
import unittest
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch
from websockets.asyncio.server import serve
from websockets.asyncio.client import connect
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'device'))
from codex_shared_service import Gateway,check_permissions
from codex_shared_rpc import RPC
from task_journal import TaskJournal,write_json,read_json
from session_runtime import SessionLock
import codex_shared


class Native:
    def __init__(self, cwd):
        self.cwd=str(cwd); self.clients=set(); self.turns={}; self.active={}; self.starts=[]; self.steers=[]; self.interrupts=[]
        self.backgrounds=[]; self.hold_interrupt=False; self.fail_start=False
        self.terminal_stops=[];self.subscriptions={};self.notifications=[];self.requests=[]
        self.query_gates={};self.query_started={};self.hide_turns=set();self.query_snapshots={}
        self.catalog_rows=[]
        self.metadata={}

    async def event(self,method,params):
        delivered=0
        for ws in list(self.clients):
            if params.get('threadId') not in self.subscriptions.get(ws,set()): continue
            try: await ws.send(json.dumps({'method':method,'params':params}))
            except Exception: pass
            else: delivered+=1
        self.notifications.append((method,params.get('threadId'),delivered))

    async def finish(self,thread,status='completed'):
        turn=self.active.pop(thread); turn.update(status=status)
        turn['items'].append({'type':'agentMessage','id':turn['id']+'-message','text':turn['input'][0]['text']})
        await self.event('turn/completed',{'threadId':thread,'turn':turn})

    async def handler(self,ws):
        self.clients.add(ws);self.subscriptions[ws]=set()
        try:
            async for raw in ws:
                m=json.loads(raw); method=m.get('method'); p=m.get('params') or {}; thread=p.get('threadId')
                self.requests.append((method,p))
                if method=='initialized': continue
                if method=='initialize': result={'codexHome':self.cwd}
                elif method=='thread/read': result={'thread':{'id':thread,'cwd':self.cwd,'turns':self.turns.get(thread,[]),**self.metadata.get(thread,{})}}
                elif method=='account/read':result={'requiresOpenaiAuth':False,'account':{'type':'fixture'}}
                elif method=='thread/list':
                    offset=int(p.get('cursor') or 0);rows=[] if p.get('archived') else self.catalog_rows;limit=p.get('limit',32)
                    result={'data':rows[offset:offset+limit],'nextCursor':str(offset+limit) if offset+limit<len(rows) else None}
                elif method=='thread/resume':
                    self.subscriptions[ws].add(thread)
                    result={'thread':{'id':thread,'cwd':self.cwd},'sandbox':{'type':'readOnly'},'approvalPolicy':'never','model':'original-model'}
                elif method=='thread/settings/update': result={'sandbox':{'type':'readOnly'},'approvalPolicy':'never','model':'original-model'}
                elif method=='thread/turns/list':
                    result=json.loads(json.dumps({'data':[] if thread in self.hide_turns else
                        [dict(t,itemsView='full') for t in self.turns.get(thread,[])]}))
                    self.query_snapshots[thread]=result
                    self.query_started.setdefault(thread,asyncio.Event()).set()
                    gate=self.query_gates.get(thread)
                    if gate:
                        wait=asyncio.create_task(gate.wait());closed=asyncio.create_task(ws.wait_closed())
                        try:
                            await asyncio.wait([wait,closed],return_when=asyncio.FIRST_COMPLETED)
                            if closed.done(): return
                        finally:
                            wait.cancel();closed.cancel();await asyncio.gather(wait,closed,return_exceptions=True)
                elif method=='turn/start':
                    self.subscriptions[ws].add(thread)
                    if self.fail_start:
                        await ws.send(json.dumps({'id':m['id'],'error':{'message':'start rejected'}}));continue
                    if thread in self.active:
                        self.steers.append(p); result={'turn':self.active[thread]}
                    else:
                        turn={'id':str(uuid.uuid4()),'status':'inProgress','items':[],'input':p['input']}
                        self.active[thread]=turn; self.turns.setdefault(thread,[]).append(turn); self.starts.append(p)
                        await self.event('turn/started',{'threadId':thread,'turn':turn})
                        result={'turn':turn}
                elif method=='turn/interrupt':
                    self.interrupts.append(p)
                    if not self.hold_interrupt: await self.finish(thread,'interrupted')
                    result={}
                elif method=='turn/steer': self.steers.append(p);result={}
                elif method=='thread/backgroundTerminals/list': result={'data':[row for row in self.backgrounds if row.get('threadId',thread)==thread]}
                elif method=='thread/backgroundTerminals/terminate':
                    self.terminal_stops.append(p)
                    stopped=[row for row in self.backgrounds if row['processId']==p['processId']]
                    self.backgrounds=[row for row in self.backgrounds if row['processId']!=p['processId']]
                    for row in stopped:
                        await self.event('item/completed',{'threadId':thread,'turnId':self.active[thread]['id'],
                            'item':{'id':row['itemId'],'type':'commandExecution','status':'completed','exitCode':-1}})
                    result={'terminated':bool(stopped)}
                else: result={}
                await ws.send(json.dumps({'id':m['id'],'result':result}))
        finally: self.clients.discard(ws);self.subscriptions.pop(ws,None)


class SharedTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='bridge-shared-test-'); self.folder=Path(self.temp.name)
        self.env=patch.dict(os.environ,{'POCKET_VIBE_STATE_DIR':str(self.folder/'state')});self.env.start()
        self.native=Native(self.folder)
        self.native_server=await serve(self.native.handler,'127.0.0.1',0)
        native_url='ws://127.0.0.1:'+str(self.native_server.sockets[0].getsockname()[1])
        self.gateway=Gateway(native_url,'native-secret','local-secret','generation-a')
        self.gateway.reconcile_interval=.05;self.gateway.reconcile_timeout=.5;self.runners=[]
        self.server=await serve(self.gateway.handler,'127.0.0.1',0)
        self.url='ws://127.0.0.1:'+str(self.server.sockets[0].getsockname()[1])+'/local-secret'
        codex_shared.save_endpoint(codex_shared.directory(),{'url':self.url,'generation':'generation-a'})
        self.desktop=await RPC(self.url,'codex_desktop').__aenter__()
        self.bridge=await RPC(self.url).__aenter__()
        self.config={'project_policy':{'confirmed':True,'roots':[str(self.folder)]},'desktop_permission':'read-only','timeout_seconds':20}
        self.thread=str(uuid.uuid4())
        await self.desktop.call('thread/resume',{'threadId':self.thread,'excludeTurns':True})

    async def asyncTearDown(self):
        await self.desktop.__aexit__();await self.bridge.__aexit__()
        pending=list(self.gateway.tasks.values())+list(self.gateway.reconciling.values())+self.runners
        for task in pending:
            if not task.done(): task.cancel()
        await asyncio.gather(*pending,return_exceptions=True)
        self.server.close();self.native_server.close()
        await self.server.wait_closed();await self.native_server.wait_closed()
        self.env.stop();self.temp.cleanup()

    async def until(self,predicate):
        for _ in range(300):
            if predicate(): return
            await asyncio.sleep(.01)
        self.fail('Protocol condition timed out')

    async def desktop_start(self,thread=None):
        return (await self.desktop.call('turn/start',{'threadId':thread or self.thread,'input':[{'type':'text','text':'desktop'}]}))['turn']['id']

    def journal(self,thread=None):
        journal=TaskJournal(str(uuid.uuid4()),'codex')
        journal.receive({'task_id':journal.task_id,'payload':{'session_id':thread or self.thread,'cwd':str(self.folder),'objective':'station'}},{'owner':'fixture'})
        journal.launch_once();return journal

    async def submit(self,journal):
        await self.bridge.call('bridge/task/submit',{'taskId':journal.task_id,'config':self.config})

    async def disconnect_desktop(self):
        await self.desktop.__aexit__();await self.until(lambda:not self.gateway.desktop_connections)
        await self.until(lambda:not any(self.thread in subs for subs in self.native.subscriptions.values()))

    async def reconnect_desktop(self):
        self.desktop=await RPC(self.url,'codex_desktop').__aenter__()  # No thread/resume, model or policy mutation.

    async def waiting_runner(self,journal):
        runner=asyncio.create_task(codex_shared.run_task(self.config,journal.payload()))
        self.runners.append(runner)
        await self.until(lambda:self.gateway.admission.waiting.get(self.thread)==1)
        return runner

    async def test_station_slot_wait_and_readonly_reattach_never_resubmit(self):
        import station_native
        journal=self.journal();self.config['station_slot_file']=str(journal.path/'slot.json')
        await self.submit(journal)
        await self.until(lambda:read_json(journal.path/'status.json',{}).get('status')=='waiting-slot')
        self.assertEqual(len(self.native.starts),0)
        known=await self.bridge.call('bridge/task/state',{'taskId':journal.task_id})
        self.assertTrue(known['known']);self.assertIsNone(known['turnId'])
        request={'operation':'attach','executionId':journal.task_id,'sessionId':self.thread,'objective':'must never replace original',
            'grants':[{'root':str(self.folder),'projectId':'p','confirmed':True,'permission':'read-only'}]}
        observer=asyncio.create_task(station_native.execute(request));self.runners.append(observer)
        await asyncio.sleep(.2);self.assertFalse(observer.done());self.assertEqual(len(self.native.starts),0)
        with self.assertRaises(RuntimeError):await station_native.execute({'operation':'grant-slot','executionId':journal.task_id,'generation':'old'})
        await station_native.execute({'operation':'grant-slot','executionId':journal.task_id,'generation':'generation-a'})
        await self.until(lambda:len(self.native.starts)==1)
        await self.native.finish(self.thread);result=await asyncio.wait_for(observer,5)
        self.assertTrue(result['cleanup_confirmed']);self.assertEqual(len(self.native.starts),1)
        self.assertEqual(self.native.starts[0]['input'][0]['text'],'station')

    async def test_full_access_requires_explicit_matching_local_grant(self):
        settings={'sandbox':{'type':'dangerFullAccess'},'approvalPolicy':'never','model':'original'}
        with self.assertRaises(ValueError):check_permissions(settings,{**self.config,'desktop_permission':'full-access'},self.folder)
        check_permissions(settings,{**self.config,'desktop_permission':'full-access','full_access_confirmed':True},self.folder)

    async def test_station_catalogue_pages_more_than_one_hundred_without_reading_unselected_bodies(self):
        self.native.catalog_rows=[{'id':str(uuid.uuid4()),'cwd':str(self.folder)} for _ in range(130)]
        cursor=None;rows=[]
        for _ in range(10):
            page,cursor=await codex_shared.scan_page(self.config,cursor);rows+=page
            if cursor is None:break
        self.assertEqual(len(rows),130);self.assertEqual(len({r['session_id'] for r in rows}),130)
        self.assertFalse(any(p.get('includeTurns') for method,p in self.native.requests if method=='thread/read'))
        self.assertEqual(self.native.starts,[])

    async def test_desktop_approval_wins_during_station_metadata_await_without_second_response(self):
        identity=str(uuid.uuid4());entered=asyncio.Event();release=asyncio.Event();sent=[]
        class Sender:
            async def send(self,message):sent.append(message)
        approval={'id':identity,'threadId':self.thread,'turnId':'current','decided':False,'native_id':77,
            'method':'item/fileChange/requestApproval','params':{},'connection':{'ws':Sender()}}
        self.gateway.station_approvals[identity]=approval
        folder=str(self.folder);thread=self.thread
        class Metadata:
            async def call(self,*args,**kwargs):
                entered.set();await release.wait();return {'thread':{'id':thread,'cwd':folder}}
        @asynccontextmanager
        async def recovery(_):yield Metadata()
        with patch.object(self.gateway,'recovery_rpc',recovery):
            decision=asyncio.create_task(self.gateway.local_call('bridge/approval/decide',{'approvalId':identity,'decision':'allow','config':self.config}))
            await entered.wait();approval.update(decided=True,decision='deny');release.set()
            result=await decision
        self.assertEqual(result,{'decided':True,'decision':'deny'});self.assertEqual(sent,[])

    async def test_desktop_completion_lost_during_disconnect_reconnect_continues_waiter(self):
        original=await self.desktop_start();journal=self.journal();await self.submit(journal)
        await self.until(lambda:self.gateway.admission.waiting.get(self.thread)==1)
        await self.desktop.__aexit__();await self.until(lambda:not self.gateway.desktop_connections)
        await self.until(lambda:not any(self.thread in subs for subs in self.native.subscriptions.values()))
        await self.native.finish(self.thread)
        self.assertEqual(self.native.notifications[-1],('turn/completed',self.thread,0))
        self.desktop=await RPC(self.url,'codex_desktop').__aenter__()  # No resume or manual release.
        await self.until(lambda:len(self.native.starts)==2)
        self.assertNotEqual(self.native.active[self.thread]['id'],original)
        self.assertEqual(self.native.starts[-1]['clientUserMessageId'],journal.task_id)
        await self.native.finish(self.thread);await self.until(journal.result)
        self.assertTrue(journal.result()['cleanup_confirmed']);self.assertFalse(self.native.steers)

    async def test_waiting_heartbeat_reconciles_without_desktop_and_preserves_receipt(self):
        with patch.object(self.gateway,'local_call',wraps=self.gateway.local_call) as calls:
            native=await self.desktop_start();journal=self.journal();receipt=journal.payload()
            runner=await self.waiting_runner(journal);await self.disconnect_desktop()
            await self.native.finish(self.thread)
            self.assertEqual(self.native.notifications[-1][2],0)
            await self.until(lambda:self.thread not in self.gateway.admission.active)
            proof=read_json(self.gateway.admission.record.with_name('desktop-exits.json'))[self.thread]
            self.assertEqual((proof['turn_id'],proof['generation'],proof['status']),(native,'generation-a','completed'))
            self.assertTrue(proof['cleanup_confirmed']);self.assertFalse(runner.done())
            self.assertEqual(journal.payload(),receipt);self.assertEqual(len(self.native.starts),1)
            await self.until(lambda:any(call.args[0]=='bridge/status' for call in calls.call_args_list))
            heartbeats=[call.args[1] for call in calls.call_args_list if call.args[0]=='bridge/status']
            self.assertTrue(all(params=={'threadId':self.thread} for params in heartbeats))
            self.assertEqual(sum(call.args[0]=='bridge/task/submit' for call in calls.call_args_list),1)
            resumes=sum(method=='thread/resume' for method,_ in self.native.requests)
            await self.reconnect_desktop();await self.until(lambda:len(self.native.starts)==2)
            self.assertEqual(sum(method=='thread/resume' for method,_ in self.native.requests),resumes)
            self.assertEqual(self.native.starts[-1]['clientUserMessageId'],journal.task_id)
            await self.native.finish(self.thread);result=await runner
            self.assertTrue(result['ok']);self.assertEqual(result['json']['last_message'],'station')

    async def test_interrupted_and_failed_desktop_turns_lost_then_station_continues(self):
        for status in ('interrupted','failed'):
            with self.subTest(status=status):
                self.thread=str(uuid.uuid4());await self.desktop.call('thread/resume',{'threadId':self.thread})
                turn=await self.desktop_start();journal=self.journal();runner=await self.waiting_runner(journal)
                if status=='interrupted':
                    self.native.hold_interrupt=True
                    await self.desktop.call('turn/interrupt',{'threadId':self.thread,'turnId':turn})
                    self.assertFalse(runner.done())
                self.native.active[self.thread]['items'].append({'type':'commandExecution','id':'cmd-'+turn,
                    'status':'completed','exitCode':0})
                await self.disconnect_desktop();await self.native.finish(self.thread,status)
                await self.reconnect_desktop()
                await self.until(lambda:self.native.active.get(self.thread,{}).get('id') not in (None,turn))
                await self.native.finish(self.thread);self.assertTrue((await runner)['ok'])
                self.assertEqual(read_json(self.gateway.admission.record.with_name('desktop-exits.json'))[self.thread]['status'],status)

    async def test_still_running_after_disconnect_does_not_start_waiter_or_block_other_thread(self):
        turn=await self.desktop_start();journal=self.journal();runner=await self.waiting_runner(journal)
        await self.disconnect_desktop();await self.until(lambda:self.thread in self.native.query_snapshots)
        await asyncio.sleep(.12);self.assertFalse(runner.done());self.assertEqual(len(self.native.starts),1)
        self.assertEqual(self.gateway.admission.active[self.thread]['turn'],turn)
        await self.reconnect_desktop();other=self.journal(str(uuid.uuid4()))
        await self.desktop.call('thread/resume',{'threadId':other.payload()['payload']['session_id']})
        await self.submit(other);await self.until(lambda:len(self.native.starts)==2)
        await self.native.finish(other.payload()['payload']['session_id']);await self.until(other.result)
        self.assertEqual(len([p for p in self.native.starts if p['threadId']==self.thread]),1)
        await self.native.finish(self.thread);await self.until(lambda:len(self.native.starts)==3)
        await self.native.finish(self.thread);self.assertTrue((await runner)['ok']);self.assertTrue(other.result()['ok'])

    async def test_terminal_and_command_exit_evidence_retry_without_ending_waiter(self):
        for missing in ('exit-code','background-terminal'):
            with self.subTest(missing=missing):
                self.thread=str(uuid.uuid4());await self.desktop.call('thread/resume',{'threadId':self.thread})
                native=await self.desktop_start();journal=self.journal();runner=await self.waiting_runner(journal)
                command={'type':'commandExecution','id':'cmd-'+native,'status':'completed','exitCode':None if missing=='exit-code' else 0}
                self.native.active[self.thread]['items'].append(command)
                if missing=='background-terminal':self.native.backgrounds=[{'threadId':self.thread,'itemId':command['id'],'processId':'opaque-owned'}]
                await self.disconnect_desktop();await self.native.finish(self.thread);await self.reconnect_desktop()
                await self.until(lambda:self.gateway.admission.active[self.thread].get('blocked'))
                checker=self.gateway.reconciling[self.thread]
                state=await self.bridge.call('bridge/status',{'threadId':self.thread})
                self.assertEqual(state['execution_status'],'cleanup-unconfirmed');self.assertIn('自动重试',state['detail'])
                await asyncio.sleep(.12);self.assertIs(self.gateway.reconciling[self.thread],checker)
                self.assertFalse(runner.done());self.assertIsNone(journal.result())
                self.assertFalse(self.native.terminal_stops);self.assertFalse(self.native.interrupts)
                command['exitCode']=0;self.native.backgrounds=[]
                await self.until(lambda:self.native.active.get(self.thread,{}).get('id') not in (None,native))
                await self.native.finish(self.thread);self.assertTrue((await runner)['ok'])

    async def test_duplicate_reconnect_and_retired_notifications_do_not_release_new_turn(self):
        old=await self.desktop_start();old_turn=dict(self.native.active[self.thread])
        journal=self.journal();runner=await self.waiting_runner(journal);await self.disconnect_desktop()
        await self.native.finish(self.thread);await self.reconnect_desktop()
        await self.until(lambda:len(self.native.starts)==2)
        await self.until(lambda:self.gateway.admission.active[self.thread].get('turn') is not None)
        new=self.gateway.admission.active[self.thread];new_id=new['turn']
        for _ in range(2):
            async with RPC(self.url,'codex_desktop') as repeated:
                await repeated.call('bridge/status',{'threadId':self.thread})
            await self.native.event('turn/started',{'threadId':self.thread,'turn':old_turn})
            await self.native.event('turn/completed',{'threadId':self.thread,'turn':dict(old_turn,status='completed')})
        await asyncio.sleep(.1)
        self.assertIs(self.gateway.admission.active[self.thread],new);self.assertEqual(new['turn'],new_id)
        self.assertNotEqual(new_id,old);self.assertFalse(new.get('blocked'));self.assertFalse(runner.done())
        self.assertEqual(len(self.native.starts),2);self.assertFalse(self.native.steers)
        await self.native.finish(self.thread);self.assertTrue((await runner)['ok'])

    async def test_query_timeout_missing_turn_and_status_calls_share_one_retry(self):
        native=await self.desktop_start();journal=self.journal();runner=await self.waiting_runner(journal)
        gate=asyncio.Event();self.native.query_gates[self.thread]=gate
        await self.disconnect_desktop();await self.native.finish(self.thread)
        await self.until(lambda:'核对超时' in self.gateway.admission.active[self.thread].get('reconcile_error',''))
        checker=self.gateway.reconciling[self.thread]
        states=await asyncio.gather(*(self.bridge.call('bridge/status',{'threadId':self.thread}) for _ in range(10)))
        self.assertTrue(all(state['execution_status']=='cleanup-unconfirmed' for state in states))
        self.assertTrue(all('核对超时' in state['detail'] for state in states));self.assertIs(self.gateway.reconciling[self.thread],checker)
        self.native.hide_turns.add(self.thread);gate.set();self.native.query_gates.pop(self.thread)
        await self.until(lambda:'尚未一致' in self.gateway.admission.active[self.thread].get('reconcile_error',''))
        self.assertFalse(runner.done());self.assertEqual(len(self.native.starts),1)
        self.native.hide_turns.clear();await self.reconnect_desktop()
        await self.until(lambda:len(self.native.starts)==2)
        self.assertNotEqual(self.native.active[self.thread]['id'],native)
        await self.native.finish(self.thread);self.assertTrue((await runner)['ok'])

    async def test_late_reconcile_result_checks_record_turn_and_generation(self):
        for mismatch in ('record','turn','generation'):
            with self.subTest(mismatch=mismatch):
                self.thread=str(uuid.uuid4());await self.desktop.call('thread/resume',{'threadId':self.thread})
                old=await self.desktop_start();reservation=self.gateway.admission.active[self.thread]
                gate=asyncio.Event();self.native.query_gates[self.thread]=gate
                await self.disconnect_desktop();await self.native.finish(self.thread)
                await self.until(lambda:self.native.query_snapshots.get(self.thread,{}).get('data',[{}])[0].get('status')=='completed')
                if mismatch=='record':
                    self.gateway.admission.active[self.thread]={**reservation,'done':asyncio.Event(),'turn':str(uuid.uuid4())}
                elif mismatch=='turn':reservation['turn']=str(uuid.uuid4())
                else:self.gateway.generation='generation-b'
                current=self.gateway.admission.active[self.thread]
                gate.set();await self.until(lambda:self.thread not in self.gateway.reconciling)
                self.assertIs(self.gateway.admission.active[self.thread],current)
                self.assertNotIn(self.thread,read_json(self.gateway.admission.record.with_name('desktop-exits.json'),{}))
                self.assertEqual(len([p for p in self.native.starts if p['threadId']==self.thread]),1)
                if mismatch=='generation':
                    state=await self.bridge.call('bridge/status',{'threadId':self.thread})
                    self.assertEqual(state['execution_status'],'cleanup-unconfirmed');self.assertIn('换代',state['detail'])
                    self.gateway.generation='generation-a'
                self.gateway.admission.active.pop(self.thread);await self.reconnect_desktop()

    async def test_timed_out_private_recovery_reply_is_not_forwarded_to_desktop(self):
        await self.desktop_start();gate=asyncio.Event();self.native.query_gates[self.thread]=gate
        await self.bridge.call('bridge/status',{'threadId':self.thread})
        await self.until(lambda:'核对超时' in self.gateway.admission.active[self.thread].get('reconcile_error',''))
        gate.set();await self.until(lambda:not self.gateway.admission.active[self.thread].get('blocked'))
        await asyncio.sleep(.1)
        events=[]
        while not self.desktop.events.empty():events.append(self.desktop.events.get_nowait())
        self.assertFalse(any(str(event.get('id','')).startswith('ahastation-bridge:') for event in events))
        self.assertEqual(len(self.native.starts),1);self.assertFalse(self.native.interrupts)
        await self.native.finish(self.thread)

    async def test_reconnected_desktop_input_waits_for_unconfirmed_turn_instead_of_steering(self):
        old=await self.desktop_start();journal=self.journal();runner=await self.waiting_runner(journal)
        await self.disconnect_desktop()
        await self.until(lambda:self.thread in self.native.query_snapshots and not self.gateway.admission.active[self.thread].get('blocked'))
        gate=asyncio.Event();self.native.query_gates[self.thread]=gate
        await self.native.finish(self.thread);await self.reconnect_desktop()
        fresh=asyncio.create_task(self.desktop_start());self.runners.append(fresh)
        await asyncio.sleep(.1)
        self.assertEqual(len(self.native.starts),1,'Reconnected input must not bypass exit verification')
        self.assertFalse(fresh.done());self.assertFalse(runner.done())
        gate.set();await self.until(lambda:len(self.native.starts)==2)
        await self.native.finish(self.thread);await self.until(lambda:len(self.native.starts)==3)
        await self.native.finish(self.thread);self.assertTrue((await runner)['ok']);self.assertNotEqual(await fresh,old)
        self.assertFalse(self.native.steers)
        self.assertEqual(sum(p.get('clientUserMessageId')==journal.task_id for p in self.native.starts),1)
        # Healthy steering on the original live socket remains compatible.
        self.thread=str(uuid.uuid4());await self.desktop.call('thread/resume',{'threadId':self.thread})
        live=await self.desktop_start()
        await self.bridge.call('bridge/status',{'threadId':self.thread})
        await self.until(lambda:self.thread in self.native.query_snapshots)
        steered=await self.desktop.call('turn/start',{'threadId':self.thread,'input':[{'type':'text','text':'own follow-up'}]})
        self.assertEqual(steered['turn']['id'],live);self.assertEqual(len(self.native.steers),1)
        await self.native.finish(self.thread)

    async def test_desktop_done_station_same_thread_then_desktop_again(self):
        await self.desktop_start(); await self.native.finish(self.thread)
        journal=self.journal(); await self.submit(journal)
        await self.until(lambda:len(self.native.starts)==2)
        await self.native.finish(self.thread); await self.until(journal.result)
        self.assertTrue(journal.result()['cleanup_confirmed']);self.assertEqual(journal.result()['json']['last_message'],'station')
        await self.desktop_start();self.assertEqual(len(self.native.starts),3)
        self.assertEqual({p['threadId'] for p in self.native.starts},{self.thread});self.assertFalse(self.native.steers)
        self.assertNotIn('model',self.native.starts[1]);self.assertNotIn('sandboxPolicy',self.native.starts[1])
        mapping=read_json(journal.path/'shared.json');self.assertEqual(mapping['thread_id'],self.thread);self.assertEqual(mapping['cwd'],str(self.folder))
        await self.native.finish(self.thread)

    async def test_desktop_stop_waits_for_real_end_and_other_thread_proceeds(self):
        turn=await self.desktop_start(); self.native.hold_interrupt=True
        journal=self.journal(); await self.submit(journal)
        await self.until(lambda:read_json(journal.path/'status.json',{}).get('status')=='waiting')
        await self.desktop.call('turn/interrupt',{'threadId':self.thread,'turnId':turn})
        await asyncio.sleep(.1);self.assertEqual(len(self.native.starts),1)
        other=self.journal(str(uuid.uuid4()))
        await self.desktop.call('thread/resume',{'threadId':other.payload()['payload']['session_id'],'excludeTurns':True})
        await self.submit(other)
        await self.until(lambda:len(self.native.starts)==2)
        self.assertNotEqual(self.native.starts[-1]['threadId'],self.thread)
        await self.native.finish(self.thread,'interrupted')
        await self.until(lambda:len(self.native.starts)==3)
        self.assertFalse(self.native.steers)
        await self.native.finish(self.thread);await self.native.finish(other.payload()['payload']['session_id'])
        await self.until(journal.result);await self.until(other.result)

    async def test_cancel_waiting_does_not_interrupt_desktop(self):
        await self.desktop_start();journal=self.journal();await self.submit(journal)
        journal.request_cancel();await self.until(journal.result)
        self.assertTrue(journal.result()['cancelled']);self.assertTrue(journal.result()['cleanup_confirmed'])
        self.assertEqual(len(self.native.starts),1);self.assertFalse(self.native.interrupts)
        await self.native.finish(self.thread)

    async def test_exact_turn_cancel_ack_is_not_exit_proof_then_next_send(self):
        journal=self.journal();await self.submit(journal);await self.until(lambda:self.thread in self.native.active)
        self.native.hold_interrupt=True;journal.request_cancel()
        await self.until(lambda:len(self.native.interrupts)==1);await asyncio.sleep(.1)
        self.assertIsNone(journal.result());mapping=read_json(journal.path/'shared.json')
        self.assertEqual(self.native.interrupts[0],{'threadId':self.thread,'turnId':mapping['turn_id']})
        with self.assertRaisesRegex(RuntimeError,'另一端'):
            await self.desktop.call('turn/interrupt',{'threadId':self.thread,'turnId':'wrong-turn'})
        with self.assertRaisesRegex(RuntimeError,'另一端'):
            await self.desktop.call('turn/steer',{'threadId':self.thread,'expectedTurnId':mapping['turn_id'],'input':[]})
        async with RPC(self.url,'another_desktop') as other:
            with self.assertRaisesRegex(RuntimeError,'另一端'):
                await other.call('turn/interrupt',self.native.interrupts[0])
        await self.desktop.call('turn/interrupt',self.native.interrupts[0])
        self.assertIsNone(journal.result())  # Desktop ACK is still not exit proof.
        await self.native.finish(self.thread,'interrupted');await self.until(journal.result)
        self.assertTrue(journal.result()['cleanup_confirmed'])
        next_journal=self.journal();await self.submit(next_journal);await self.until(lambda:len(self.native.starts)==2)
        await self.native.finish(self.thread);await self.until(next_journal.result)

    async def test_reconnect_and_duplicate_submit_do_not_execute_twice(self):
        journal=self.journal();await self.submit(journal);await self.until(lambda:len(self.native.starts)==1)
        await self.bridge.__aexit__();self.bridge=await RPC(self.url).__aenter__()
        await asyncio.gather(self.submit(journal),self.submit(journal));self.assertEqual(len(self.native.starts),1)
        await self.native.finish(self.thread);await self.until(journal.result)
        await self.submit(journal);self.assertEqual(len(self.native.starts),1)

    async def test_desktop_socket_loss_recovers_same_service_result_without_reexecution(self):
        journal=self.journal();await self.submit(journal);await self.until(lambda:self.thread in self.native.active)
        await self.desktop.__aexit__();await self.until(journal.result)
        self.assertFalse(journal.result()['cleanup_confirmed'])
        await self.native.finish(self.thread)
        await self.bridge.call('bridge/task/reconcile',{'taskId':journal.task_id})
        self.assertTrue(journal.result()['cleanup_confirmed']);self.assertTrue(journal.result()['ok'])
        self.assertEqual(journal.result()['json']['last_message'],'station')
        self.assertEqual(len(self.native.starts),1)

    async def test_uncertain_owned_background_blocks_next_and_not_cleaned_globally(self):
        journal=self.journal();await self.submit(journal);await self.until(lambda:self.thread in self.native.active)
        turn=self.native.active[self.thread];self.native.backgrounds=[{'itemId':turn['id']+'-message','processId':'owned-pty'}]
        await self.native.finish(self.thread);await self.until(journal.result)
        self.assertFalse(journal.result()['cleanup_confirmed'])
        next_journal=self.journal();await self.submit(next_journal);await self.until(next_journal.result)
        self.assertFalse(next_journal.result()['cleanup_confirmed']);self.assertEqual(len(self.native.starts),1)
        lock=SessionLock('codex',self.thread)
        try:self.assertEqual(lock.read()['status'],'cleanup-unconfirmed')
        finally:lock.close()
        self.native.backgrounds=[]
        await self.bridge.call('bridge/task/reconcile',{'taskId':journal.task_id})
        self.assertTrue(journal.result()['cleanup_confirmed'])
        again=self.journal();await self.submit(again);await self.until(lambda:len(self.native.starts)==2)
        await self.native.finish(self.thread);await self.until(again.result)

    async def test_generation_change_no_resubmit_and_missing_desktop_fails(self):
        journal=self.journal();write_json(journal.path/'shared.json',{'generation':'older-service','thread_id':self.thread})
        with self.assertRaisesRegex(RuntimeError,'服务已重启'):await self.submit(journal)
        await self.desktop.__aexit__();self.desktop=await RPC(self.url).__aenter__()
        with self.assertRaisesRegex(RuntimeError,'桌面尚未'):await self.submit(self.journal())
        self.assertFalse(self.native.starts)

    async def test_unauthorized_origin_and_capability_rejected(self):
        async with connect(self.url,origin='http://malicious.local') as ws:
            with self.assertRaises(Exception):await ws.recv()
        async with connect(self.url.replace('local-secret','wrong')) as ws:
            with self.assertRaises(Exception):await ws.recv()

    async def test_policy_ceiling_and_original_settings_no_elevation(self):
        with self.assertRaisesRegex(ValueError,'权限超过'):
            check_permissions({'sandbox':{'type':'dangerFullAccess'}},self.config,self.folder)
        with self.assertRaisesRegex(ValueError,'权限超过'):
            check_permissions({'sandbox':{'type':'workspaceWrite'}},self.config,self.folder)
        check_permissions({'sandbox':{'type':'readOnly'}},self.config,self.folder)

    async def test_native_completed_command_without_exit_code_is_not_exit_proof(self):
        journal=self.journal();await self.submit(journal);await self.until(lambda:self.thread in self.native.active)
        native=self.native.active[self.thread]['id'];await self.native.finish(self.thread,'interrupted')
        self.native.turns[self.thread][-1]['items'].append({'type':'commandExecution','id':'owned-command',
            'status':'completed','exitCode':None,'processId':'opaque-native-id'})
        await self.until(journal.result);self.assertFalse(journal.result()['cleanup_confirmed'])
        next_task=self.journal();await self.submit(next_task);await self.until(next_task.result)
        self.assertEqual(len(self.native.starts),1);self.assertFalse(next_task.result()['cleanup_confirmed'])

    async def test_missing_inflight_history_item_does_not_hide_active_terminal(self):
        journal=self.journal();await self.submit(journal);await self.until(lambda:self.thread in self.native.active)
        self.native.backgrounds=[{'itemId':'not-yet-persisted','processId':'opaque-command'}]
        await self.native.finish(self.thread,'interrupted');await self.until(journal.result)
        self.assertFalse(journal.result()['cleanup_confirmed'])
        next_task=self.journal();await self.submit(next_task);await self.until(next_task.result)
        self.assertEqual(len(self.native.starts),1)

    async def test_live_command_exit_required_even_when_missing_from_history(self):
        journal=self.journal();await self.submit(journal);await self.until(lambda:self.thread in self.native.active)
        native=self.native.active[self.thread]['id']
        await self.native.event('item/started',{'threadId':self.thread,'turnId':native,
            'item':{'type':'commandExecution','id':'live-only','status':'inProgress','exitCode':None}})
        await self.native.finish(self.thread,'interrupted');await self.until(journal.result)
        self.assertFalse(journal.result()['cleanup_confirmed'])

    async def test_desktop_stop_terminates_only_live_items_of_its_own_turn(self):
        native=await self.desktop_start()
        await self.native.event('item/started',{'threadId':self.thread,'turnId':native,
            'item':{'type':'commandExecution','id':'desktop-command','status':'inProgress','exitCode':None}})
        self.native.backgrounds=[{'itemId':'desktop-command','processId':'desktop-opaque'},
            {'itemId':'previous-other-task','processId':'leave-alone'}]
        await self.until(lambda:'desktop-command' in self.gateway.admission.active[self.thread].get('commands',{}))
        await self.desktop.call('turn/interrupt',{'threadId':self.thread,'turnId':native})
        self.assertEqual(self.native.terminal_stops,[{'threadId':self.thread,'processId':'desktop-opaque'}])
        self.assertEqual(self.native.backgrounds[0]['processId'],'leave-alone')
        await asyncio.sleep(.1)
        self.assertEqual(self.gateway.admission.status(self.thread)[0],'cleanup-unconfirmed')

    async def test_native_child_session_needs_identity_and_exit_proof(self):
        journal=self.journal();await self.submit(journal);await self.until(lambda:self.thread in self.native.active)
        await self.native.finish(self.thread)
        self.native.turns[self.thread][-1]['items'].append({'id':'spawn-child','type':'collabAgentToolCall',
            'receiverThreadIds':[str(uuid.uuid4())],'tool':'spawnAgent','status':'completed'})
        await self.until(journal.result)
        self.assertFalse(journal.result()['cleanup_confirmed'])

    async def test_crashed_service_keeps_durable_desktop_admission_block(self):
        await self.desktop_start()
        from codex_shared_service import Admission
        recovered=Admission(self.gateway.admission.record,'generation-after-crash')
        self.assertEqual(recovered.status(self.thread)[0],'cleanup-unconfirmed')
        with self.assertRaisesRegex(RuntimeError,'停止未确认'):
            await recovered.reserve(self.thread,'bridge:new-task')
        other=await recovered.reserve(str(uuid.uuid4()),'bridge:other-thread')
        self.assertIsNone(other['turn'])
        await self.native.finish(self.thread)

    async def test_loaded_desktop_settings_stay_on_actual_socket_without_resume(self):
        from bridge_settings import mode_settings,mode_binary
        old={'access':'cli','binary':'saved-cli-path'}
        desktop=mode_settings(old,'desktop','')
        self.assertEqual(mode_binary(desktop,'desktop'),'');self.assertEqual(mode_binary(desktop,'cli'),'saved-cli-path')
        cli=mode_settings(desktop,'cli','new-cli-path')
        self.assertEqual(mode_binary(cli,'desktop'),'');self.assertEqual(mode_binary(cli,'cli'),'new-cli-path')
        original=dict(self.gateway.settings[self.thread]);journal=self.journal();await self.submit(journal)
        await self.until(lambda:self.thread in self.native.active)
        self.assertEqual(self.gateway.settings[self.thread],original)
        await self.native.finish(self.thread);await self.until(journal.result)

    async def test_nearly_simultaneous_desktop_and_station_no_implicit_steer(self):
        journal=self.journal(); desktop=asyncio.create_task(self.desktop_start()); await self.submit(journal)
        await self.until(lambda:len(self.native.starts)==1);await asyncio.sleep(.1)
        self.assertEqual(len(self.native.starts),1);self.assertFalse(self.native.steers)
        await self.native.finish(self.thread);await self.until(lambda:len(self.native.starts)==2)
        await self.native.finish(self.thread);await self.until(journal.result);await desktop


class LinkedLaunchTest(unittest.TestCase):
    def test_explicit_launch_uses_shared_url_without_force_cli_override(self):
        from unittest.mock import AsyncMock,patch
        from codex_shared import launch_desktop
        with patch('codex_shared.desktop_installation',return_value=Path('trusted-desktop')), \
                patch('codex_shared.status',new=AsyncMock(side_effect=RuntimeError('not connected'))), \
                patch('codex_desktop.running_runtimes',return_value=[]), \
                patch('codex_shared.ensure_service',return_value={'url':'ws://127.0.0.1:1234/local-secret'}), \
                patch('codex_shared.subprocess.Popen') as spawn, \
                patch.dict(os.environ,{'CODEX_APP_SERVER_FORCE_CLI':'1'}):
            launch_desktop({'binary':'discovered-component'})
            environment=spawn.call_args.kwargs['env']
            self.assertEqual(environment['CODEX_APP_SERVER_WS_URL'],'ws://127.0.0.1:1234/local-secret')
            self.assertNotIn('CODEX_APP_SERVER_FORCE_CLI',environment)
            self.assertEqual(os.environ['CODEX_APP_SERVER_FORCE_CLI'],'1')


if __name__=='__main__':unittest.main()
