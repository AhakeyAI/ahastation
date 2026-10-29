"""Public protocol over real loopback HTTP/WS, native scanner and owned processes.

SQLite is an explicitly injected test DB, not a MySQL/cloud acceptance result.
Set HUB_TEST_MYSQL_URL to an empty, dedicated test schema for native DB checks.
"""
import asyncio
import json
import os
import socket
import sys
import tempfile
import time
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'device'))
import httpx
import uvicorn
import websockets
from sqlalchemy import create_engine,select,update
from sqlalchemy.exc import SQLAlchemyError
from fastapi import HTTPException
from hub_store import HubStore,metadata,pairs,credentials,tasks
from public_hub import create_app
from public_bridge import PublicBridge
from task_journal import TaskJournal,read_json,write_json
from project_policy import authorized_cwd
from session_runtime import device_id,SessionLock,execution_status

class PublicRemoteTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='station-public-')
        self.root=Path(self.temp.name); self.home=self.root/'home'; self.project=self.root/'project'; self.project.mkdir()
        self.env=patch.dict(os.environ,{'POCKET_VIBE_STATE_DIR':str(self.root/'state'),'HOME':str(self.home),'USERPROFILE':str(self.home)})
        self.env.start()
        self.engine=create_engine('sqlite:///'+str(self.root/'hub.sqlite'),connect_args={'timeout':15})
        self.store=HubStore(self.engine,'test-secret-strong-enough-not-a-real-secret'); self.store.migrate()
        self.app=create_app(self.store)
        self.socket=socket.socket(); self.socket.bind(('127.0.0.1',0)); self.url=f'http://127.0.0.1:{self.socket.getsockname()[1]}'
        self.server=uvicorn.Server(uvicorn.Config(self.app,log_level='critical',lifespan='on'))
        self.server_task=asyncio.create_task(self.server.serve(sockets=[self.socket])); await self.until(lambda:self.server.started)
        self.http=httpx.AsyncClient(base_url=self.url,trust_env=False,timeout=20)
        self.a=await asyncio.to_thread(self.store.identity,'alice','test-password-123',register=True)
        self.b=await asyncio.to_thread(self.store.identity,'bobby','test-password-123',register=True)
        self.owner=self.a['owner_id']; self.headers={'Authorization':'Bearer '+self.a['control_token']}
        self.other={'Authorization':'Bearer '+self.b['control_token']}; self.bridges=[]; self.connections=[]
        self.native=str(uuid.uuid4()); sessions=self.home/'.codex'/'sessions'; sessions.mkdir(parents=True)
        (sessions/(self.native+'.jsonl')).write_text(json.dumps({'type':'session_meta','payload':{'cwd':str(self.project)}})+'\n'+json.dumps({'type':'response_item','payload':{'role':'user','content':'fixture existing session'}}),encoding='utf-8')
        self.adapter=self.root/'adapter.py'
        self.adapter.write_text("import json,sys,time,subprocess,os\nt=json.load(sys.stdin)\np=t['objective']\nif p=='slow':\n while True:\n  open('owned-writing.txt','a').write('x'); time.sleep(.03)\nif p=='descendant':\n subprocess.Popen([sys.executable,'-c',\"import time; time.sleep(2); open('late.txt','w').write('bad')\"],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nopen('turns.txt','a').write(t['session_id']+' '+p+'\\n')\nprint(json.dumps({'last_message':'reply:'+t['session_id']+':'+p}))\n",encoding='utf-8')
        self.config=self.root/'config.json'
        self.config.write_text(json.dumps({'command':[sys.executable,str(self.adapter)],'capabilities':['codex.exec'],'project_policy':{'confirmed':True,'roots':[str(self.project)]},'working_dir':str(self.project),'timeout_seconds':2}),encoding='utf-8')

    async def asyncTearDown(self):
        for bridge in self.bridges: await bridge.exit_gracefully()
        for connection in self.connections: connection.cancel()
        await asyncio.gather(*self.connections,return_exceptions=True)
        await self.http.aclose(); self.server.should_exit=True
        await asyncio.wait_for(self.server_task,15); self.socket.close(); self.engine.dispose(); self.env.stop(); self.temp.cleanup()

    async def until(self,condition):
        for _ in range(1000):
            if condition(): return
            await asyncio.sleep(.01)
        self.fail('Timed out waiting for the real protocol fixture')

    async def connect(self):
        pair=self.store.create_pair(self.owner)
        claim=self.store.claim_pair(pair['pair_code'],device_id(),'Fixture PC')
        self.device=claim['device_id']; self.device_token=claim['device_token']
        bridge=PublicBridge(self.url,self.device_token,'codex',self.config,allow_local=True,owner_id=self.owner)
        self.bridges.append(bridge); connection=asyncio.create_task(bridge._connect_once()); self.connections.append(connection)
        await self.until(lambda: bridge.agent_id in self.app.state.connections and self.app.state.connections[bridge.agent_id][2].catalog_status=='ready')
        response=await self.http.get('/v1/remote-sessions?refresh=true',headers=self.headers)
        self.assertEqual(response.status_code,200,response.text); self.target=response.json()['sessions'][0]
        return bridge

    def body(self,prompt='first',key=None,target=None):
        target=target or self.target
        return {'prompt':prompt,'idempotency_key':key or str(uuid.uuid4()),'target_agent_id':target['agent_id'],'provider':target['provider'],
                'session_id':target['session_id'],'cwd':target['cwd'],'remote_target':target,'turn_options':{'mode':'resume','session_id':target['session_id'],'cwd':target['cwd']}}

    async def submit(self,body):
        response=await self.http.post('/v1/turns',json=body,headers=self.headers)
        self.assertEqual(response.status_code,200,response.text); return response.json()['turn_id']

    async def finished(self,task_id):
        for _ in range(600):
            row=(await self.http.get('/v1/turns/'+task_id,headers=self.headers)).json()['task']
            if row['status'] in {'done','failed','cancelled','cleanup-unconfirmed'}: return row
            await asyncio.sleep(.02)
        self.fail('Task did not reach a verifiable terminal state')

    async def test_native_two_turns_dedup_owner_isolation_and_real_cancel(self):
        bridge=await self.connect()
        first=self.body(); task=await self.submit(first); result=await self.finished(task)
        self.assertEqual(result['status'],'done'); self.assertTrue(result['result']['cleanup_confirmed'])
        self.assertEqual(task,await self.submit(first))
        second=await self.submit(self.body('second')); result=await self.finished(second)
        self.assertIn(self.native,result['result']['json']['last_message'])
        self.assertEqual(len((self.project/'turns.txt').read_text().splitlines()),2)

        # A different native session is actually waiting in the existing Bridge queue.
        other_native=str(uuid.uuid4())
        (self.home/'.codex'/'sessions'/(other_native+'.jsonl')).write_text(json.dumps({'type':'session_meta','payload':{'cwd':str(self.project)}}))
        first=await self.submit(self.body('slow'))
        await self.until(lambda:(self.project/'owned-writing.txt').exists())
        queued=await self.submit(self.body('queued-other-session',target={**self.target,'session_id':other_native}))
        await self.until(lambda:self.store.get_task(self.owner,queued)['status']=='waiting')
        directory=(await self.http.get('/v1/remote-sessions?refresh=true',headers=self.headers)).json()
        self.assertEqual(next(row['execution_status'] for row in directory['sessions'] if row['session_id']==other_native),'waiting')
        await self.http.post('/v1/turns/'+first+'/cancel',headers=self.headers)
        self.assertEqual((await self.finished(first))['status'],'cancelled')
        self.assertEqual((await self.finished(queued))['status'],'done')
        for path in ['/v1/remote-sessions','/v2/devices','/v2/tasks']:
            self.assertNotIn(self.device,(await self.http.get(path,headers=self.other)).text)
        self.assertEqual((await self.http.get('/v1/turns/'+task,headers=self.other)).status_code,404)
        self.assertEqual((await self.http.post('/v1/turns/'+task+'/cancel',headers=self.other)).status_code,404)
        self.assertEqual((await self.http.post('/v1/turns',json=self.body(),headers=self.other)).status_code,404)
        slow=await self.submit(self.body('slow'))
        await self.until(lambda:(self.project/'owned-writing.txt').exists())
        await self.http.post('/v1/turns/'+slow+'/cancel',headers=self.headers)
        result=await self.finished(slow); self.assertEqual(result['status'],'cancelled'); self.assertTrue(result['result']['cleanup_confirmed'])
        before=(self.project/'owned-writing.txt').read_bytes(); await asyncio.sleep(.15)
        self.assertEqual(before,(self.project/'owned-writing.txt').read_bytes())
        self.assertEqual(execution_status('codex',self.native),'idle')
        sequence=self.app.state.connections[bridge.agent_id][2].seq
        await asyncio.sleep(.2)
        self.assertLessEqual(self.app.state.connections[bridge.agent_id][2].seq,sequence+1,'Terminal result ACK must not create an endless cancel/result loop (one heartbeat permitted)')
        self.assertEqual((await self.http.post('/v1/turns/'+slow+'/cancel',headers=self.headers)).json()['task']['status'],'cancelled')
        self.assertEqual((await self.finished(await self.submit(self.body('after-cancel'))))['status'],'done')
        self.assertEqual((await self.http.get('/health')).json(),{'ok':True,'protocol':2,'service':'ahastation-hub'})
        self.assertEqual((await self.http.get('/api/tasks',headers=self.headers)).status_code,404)
        self.assertEqual((await self.http.get('/v2/devices',headers={'X-Pocket-Token':'pocket-vibe-dev-token'})).status_code,401)
        # New real project appears inside an already-authorized root, without pairing again.
        newer=str(uuid.uuid4()); (self.home/'.codex'/'sessions'/(newer+'.jsonl')).write_text(json.dumps({'type':'session_meta','payload':{'cwd':str(self.project)}}))
        self.assertIn(newer,(await self.http.get('/v1/remote-sessions?refresh=true',headers=self.headers)).text)

    async def test_parallel_catalog_and_sends_uses_actual_scanner(self):
        bridge=await self.connect(); scanner=bridge._scan_sessions
        def slow_scan(): time.sleep(.08); return scanner()
        bridge._scan_sessions=slow_scan
        results=await asyncio.gather(*(self.http.get('/v1/remote-sessions?refresh=true',headers=self.headers) for _ in range(2)))
        self.assertTrue(all(row.json()['sessions'] for row in results))
        ids=await asyncio.gather(self.submit(self.body('parallel-a')),self.submit(self.body('parallel-b')))
        self.assertTrue(all(row['status']=='done' for row in await asyncio.gather(*(self.finished(key) for key in ids))))
        self.assertEqual(len((self.project/'turns.txt').read_text().splitlines()),2)

    async def test_cancel_snapshot_race_dispatches_then_waits_for_correct_bridge_exit_proof(self):
        bridge=await self.connect()
        original_cancel=self.store.request_cancel; original_report=bridge._report; original_handle=bridge._handle_message
        for attempt in range(3):
            with self.subTest(attempt=attempt):
                read_started=threading.Event(); continue_cancel=threading.Event()
                proof_ready=asyncio.Event(); release_proof=asyncio.Event(); cancels=[]
                body=self.body('slow')
                payload={key:body[key] for key in ('provider','session_id','cwd','turn_options','remote_target')}
                payload['objective']=body['prompt']
                task,_=self.store.submit(self.owner,self.device,bridge.agent_id,body['idempotency_key'],payload)
                task_id=task['task_id']
                def paused_cancel(owner,key):
                    if key==task_id:
                        # Deliberately observe an obsolete queued snapshot at
                        # the request boundary; admission wins before the
                        # production cancellation transaction reads its row.
                        self.assertEqual(self.store.get_task(owner,key)['status'],'queued')
                        read_started.set()
                        if not continue_cancel.wait(10): raise RuntimeError('Cancellation gate timed out')
                    return original_cancel(owner,key)
                async def held_report(ws,journal,result):
                    if journal.task_id==task_id and result.get('cleanup_confirmed') is True:
                        proof_ready.set(); await release_proof.wait()
                    return await original_report(ws,journal,result)
                async def observe_cancel(ws,msg):
                    if msg['type']=='cancel': cancels.append(msg['task_id'])
                    return await original_handle(ws,msg)
                response_task=None
                try:
                    with patch.object(self.store,'request_cancel',side_effect=paused_cancel), patch.object(bridge,'_report',side_effect=held_report), patch.object(bridge,'_handle_message',side_effect=observe_cancel):
                        response_task=asyncio.create_task(self.http.post('/v1/turns/'+task_id+'/cancel',headers=self.headers))
                        self.assertTrue(await asyncio.to_thread(read_started.wait,5))
                        # Real catalog response drives the existing Hub pump,
                        # actual WS delivery and owned native fixture process.
                        await self.http.get('/v1/remote-sessions?refresh=true',headers=self.headers)
                        await self.until(lambda:self.store.get_task(self.owner,task_id)['status']=='running')
                        continue_cancel.set()
                        response=await response_task
                        self.assertEqual(response.status_code,200,response.text)
                        self.assertEqual(response.json()['task']['status'],'cancelling')
                        self.assertIsNot(response.json()['task'].get('result',{}).get('cleanup_confirmed'),True)
                        await asyncio.wait_for(proof_ready.wait(),10)
                        self.assertIn(task_id,cancels)
                        row=self.store.get_task(self.owner,task_id)
                        self.assertNotIn(row['status'],{'done','failed','cancelled'})
                        self.assertIsNot(row.get('result',{}).get('cleanup_confirmed'),True)
                        self.assertIn(task_id,[row['task_id'] for row in self.store.list_tasks(self.owner,active=True)])
                        self.assertEqual((await self.http.post('/v1/turns/'+task_id+'/cancel',headers=self.other)).status_code,404)
                        release_proof.set()
                        result=await self.finished(task_id)
                        self.assertEqual(result['status'],'cancelled'); self.assertTrue(result['result']['cleanup_confirmed'])
                finally:
                    continue_cancel.set(); release_proof.set()
                    if response_task: await asyncio.gather(response_task,return_exceptions=True)

    async def test_cancel_after_admission_before_network_delivery_is_resent_after_task(self):
        bridge=await self.connect(); agent=self.app.state.connections[bridge.agent_id][2]
        original=agent.send; entered=asyncio.Event(); deliver=asyncio.Event(); sent=[]
        async def gated_send(kind,payload,task_id=None):
            if kind=='task': entered.set(); await deliver.wait()
            sent.append(kind)
            return await original(kind,payload,task_id)
        submit_task=cancel_task=None
        try:
            with patch.object(agent,'send',side_effect=gated_send):
                submit_task=asyncio.create_task(self.submit(self.body('slow')))
                await asyncio.wait_for(entered.wait(),5)
                row=self.store.list_tasks(self.owner,active=True)[0]; key=row['task_id']
                self.assertEqual(row['status'],'dispatching')
                cancel_task=asyncio.create_task(self.http.post('/v1/turns/'+key+'/cancel',headers=self.headers))
                await self.until(lambda:'cancel' in sent)
                self.assertIsNot(self.store.get_task(self.owner,key).get('result',{}).get('cleanup_confirmed'),True)
                deliver.set(); self.assertEqual(await submit_task,key)
                # The earlier cancel can legitimately report a missing receipt
                # before task delivery. Do not mistake that intermediate
                # unconfirmed state for the final guardian result.
                await self.until(lambda:self.store.get_task(self.owner,key)['status'] in {'done','failed','cancelled'})
                result=await self.finished(key)
                self.assertEqual(result['status'],'cancelled'); self.assertTrue(result['result']['cleanup_confirmed'])
                self.assertEqual((await cancel_task).status_code,200)
                self.assertIn('cancel',sent[sent.index('task')+1:])
        finally:
            deliver.set()
            await asyncio.gather(*(task for task in (submit_task,cancel_task) if task),return_exceptions=True)

    async def test_disconnect_cancel_reconnect_and_no_duplicate_execution(self):
        bridge=await self.connect(); body=self.body('slow'); key=await self.submit(body)
        await self.until(lambda:(self.project/'owned-writing.txt').exists())
        await bridge.current_ws.close()
        await self.until(lambda:not self.app.state.connections)
        # Duplicate returns its durable task even when the selected Agent is offline.
        self.assertEqual(key,await self.submit(body))
        self.assertEqual((await self.http.post('/v1/turns',json=self.body(),headers=self.headers)).status_code,409)
        self.assertEqual((await self.http.post('/v1/turns/'+key+'/cancel',headers=self.headers)).json()['task']['status'],'cancelling')
        connection=asyncio.create_task(bridge._connect_once()); self.connections.append(connection)
        result=await self.finished(key); self.assertIn(result['status'],{'cancelled','failed'}); self.assertTrue(result['result']['cleanup_confirmed'])
        size=(self.project/'owned-writing.txt').stat().st_size; await asyncio.sleep(.2)
        self.assertEqual(size,(self.project/'owned-writing.txt').stat().st_size)
        self.assertLessEqual(len(bridge.journals()),1)

    async def test_queued_cancel_attachment_limits_invalid_session_and_credentials(self):
        bridge=await self.connect()
        broken=self.body(); broken['session_id']='missing'; broken['remote_target']={**self.target,'session_id':'missing'}; broken['turn_options']['session_id']='missing'
        self.assertEqual((await self.http.post('/v1/turns',json=broken,headers=self.headers)).status_code,409)
        attached=self.body(); attached['attachments']=[{'path':'private.txt'}]
        self.assertEqual((await self.http.post('/v1/turns',json=attached,headers=self.headers)).status_code,400)
        self.assertEqual((await self.http.post('/v1/turns',content=b'x'*70000,headers=self.headers)).status_code,413)
        early=self.body(); cancel=await self.http.post('/v2/submissions/'+early['idempotency_key']+'/cancel',headers=self.headers)
        self.assertEqual(cancel.json()['task']['status'],'cancelled')
        self.assertEqual((await self.finished(await self.submit(early)))['status'],'cancelled'); self.assertFalse((self.project/'turns.txt').exists())
        lock=SessionLock('codex',self.native); self.assertTrue(lock.try_acquire()); lock.write({'version':2,'status':'running'})
        try:
            waiting=await self.submit(self.body('must-not-run')); await asyncio.sleep(.2)
            await self.http.post('/v1/turns/'+waiting+'/cancel',headers=self.headers)
            result=await self.finished(waiting); self.assertEqual(result['status'],'cancelled')
            self.assertEqual(lock.read()['status'],'running'); self.assertFalse((self.project/'turns.txt').exists())
        finally: lock.write({'version':2,'status':'idle','exit_proof':True}); lock.close()
        # Revocation closes a live connection and does not accept legacy global credentials.
        self.store.revoke(self.owner,device=self.device)
        await self.until(lambda:not self.app.state.connections)
        self.assertEqual((await self.http.get('/v2/device/unpair',headers={'Authorization':'Bearer '+self.device_token})).status_code,405)

    async def test_pair_races_expiry_recovery_and_scoped_tombstones(self):
        pair=self.store.create_pair(self.owner)
        def claim(_):
            try: return self.store.claim_pair(pair['pair_code'],str(uuid.uuid4()),'race')
            except HTTPException as exc: return exc.status_code
        with ThreadPoolExecutor(2) as pool: results=await asyncio.to_thread(lambda:list(pool.map(claim,range(2))))
        self.assertEqual(sum(isinstance(value,dict) for value in results),1); self.assertIn(409,results)
        expired=self.store.create_pair(self.owner)
        with self.engine.begin() as conn: conn.execute(update(pairs).where(pairs.c.digest==self.store.digest(expired['pair_code'])).values(expires=0))
        with self.assertRaises(HTTPException): self.store.claim_pair(expired['pair_code'],str(uuid.uuid4()),'expired')
        recovered=self.store.identity('alice','new-password-123',recovery=self.a['recovery_code'])
        with self.assertRaises(HTTPException): self.store.authenticate(self.a['control_token'],'control')
        self.assertTrue(self.store.list_devices(self.owner)); self.assertNotEqual(recovered['recovery_code'],self.a['recovery_code'])
        journal=TaskJournal(str(uuid.uuid4()),'codex'); msg={'payload':{'session_id':self.native}}
        binding={'service_url':self.url,'owner_id':self.owner}; journal.receive(msg,binding); self.assertTrue(journal.launch_once()); self.assertFalse(journal.launch_once())
        with self.assertRaises(ValueError): journal.receive(msg,{'service_url':self.url,'owner_id':self.b['owner_id']})
        journal.finish({'ok':True,'cleanup_confirmed':True,'stdout':'bounded feedback'}); journal.ack(); journal.purge_feedback(days=-1)
        self.assertTrue(journal.result()['cleanup_confirmed']); self.assertFalse((journal.path/'payload.json').exists())
        self.assertFalse(TaskJournal.all('codex',{'service_url':'https://other.test','owner_id':self.owner}))
        unresolved=TaskJournal(str(uuid.uuid4()),'codex'); unresolved.receive(msg,binding); unresolved.launch_once()
        unresolved.finish({'ok':False,'cleanup_confirmed':False}); unresolved.ack(); unresolved.purge_feedback(days=-1)
        self.assertTrue((unresolved.path/'payload.json').exists(),'Unconfirmed cleanup must retain its native recovery reference after feedback retention')

    async def test_production_db_fail_closed_and_project_symlink(self):
        sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'examples'))
        from bridge_settings import apply_pairing,provider_config
        with self.assertRaises(ValueError): provider_config('codex','configured',[],'workspace-write')
        old={'owner_id':self.owner,'service_url':self.url,'providers':{'claude':{'roots':['previous-owner-project']}}}
        claimed={'protocol':2,'device_id':device_id(),'owner_id':self.b['owner_id'],'device_token':'scoped-test-token'}
        self.assertFalse(apply_pairing(old,self.url,claimed)['providers'])
        self.assertEqual(apply_pairing(old,self.url,{**claimed,'owner_id':self.owner})['providers'],old['providers'])
        # The actual WS redirect endpoint must not receive the device credential.
        from fastapi.responses import Response
        captured=[]
        @self.app.websocket('/redirect/ws/desktop')
        async def redirect(ws):
            await ws.send_denial_response(Response(status_code=307,headers={'Location':self.url.replace('http:','ws:')+'/capture'}))
        @self.app.websocket('/capture')
        async def capture(ws):
            captured.append(ws.headers.get('authorization')); await ws.accept(); await ws.close()
        redirecting=PublicBridge(self.url+'/redirect','test-device-token','codex',self.config,allow_local=True,owner_id=self.owner)
        with self.assertRaises(websockets.exceptions.InvalidStatus): await redirecting._connect_once()
        self.assertFalse(captured)
        with patch.dict(os.environ,{'MYSQL_HOST':'','MYSQL_ADDRESS':'','MYSQL_USER':'root','MYSQL_PASSWORD':'placeholder'}):
            with self.assertRaises(RuntimeError): HubStore.production()
        policy={'confirmed':True,'roots':[str(self.project)]}
        self.assertEqual(authorized_cwd(str(self.project),policy),self.project.resolve())
        outside=self.root/'outside'; outside.mkdir()
        with self.assertRaises(ValueError): authorized_cwd(str(outside),policy)
        link=self.project/'escape'
        try: link.symlink_to(outside,target_is_directory=True)
        except OSError: pass  # Windows requires developer mode; native Linux/macOS exercises this boundary.
        else:
            with self.assertRaises(ValueError): authorized_cwd(str(link),policy)
        for _ in range(2): self.store.rate('atomic-rate',2)
        with self.assertRaises(HTTPException): self.store.rate('atomic-rate',2)

    async def test_revoked_offline_handshake_stops_owned_tasks_but_database_outage_does_not(self):
        connected=await self.connect(); notices=[]
        observer=PublicBridge(self.url,self.device_token,'codex',self.config,notices.append,allow_local=True,owner_id=self.owner)
        self.bridges.append(observer)
        journal=TaskJournal(str(uuid.uuid4()),'codex'); journal.receive({'payload':{'session_id':self.native}},observer.binding)
        # A duplicate live provider is a retryable conflict, not credential revocation/cancel.
        duplicate=asyncio.create_task(observer.run_forever())
        await self.until(lambda:bool(notices)); self.assertFalse((journal.path/'cancel.json').exists())
        observer.stop_event.set(); await duplicate
        observer.stop_event.clear(); notices.clear()
        original=self.store.authenticate
        def outage(token,scope):
            if scope=='device': raise SQLAlchemyError('Isolated simulated DB outage; no secret payload')
            return original(token,scope)
        with patch.object(self.store,'authenticate',side_effect=outage):
            task=asyncio.create_task(observer.run_forever())
            await self.until(lambda:bool(notices)); self.assertFalse((journal.path/'cancel.json').exists())
            observer.stop_event.set(); await task
        # Revocation while disconnected is detected by HTTP 401 on the next handshake.
        observer.stop_event.clear(); self.store.revoke(self.owner,device=self.device)
        await asyncio.wait_for(observer.run_forever(),5)
        self.assertTrue(observer.stop_event.is_set()); self.assertTrue((journal.path/'cancel.json').exists())

if __name__=='__main__': unittest.main()
