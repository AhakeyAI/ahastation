"""R1–R4 against the production Hub, real HTTP/WSS and isolated durable DB.

The same suite accepts the owned MySQL 5.7 fixture; it never accesses production.
"""
import asyncio
import json
import time
import uuid
import websockets
import test_station_collaboration as baseline
from collaboration_store import CollaborationStore
from hub_store import credentials
from sqlalchemy import select

FEATURES={'X-Station-Features':'unified-meeting-v1,unified-review-fixes-v1'}
class ReviewFixesTest(baseline.StationCollaborationTest):
    async def test_r1_failed_input_preserved_explicit_retry_idempotent_and_unknown_never_retried(self):
        m,_=await self.prepare()
        original=await self.command(self.a['token'],'message.send',{'meetingId':m['id'],'text':'请读取授权资料','attachments':[]})
        await self.command(self.a['token'],'message.event',{'messageId':original['id'],'status':'preparing','exitConfirmed':False})
        await self.command(self.a['token'],'message.retry',{'messageId':original['id']},expected=409)
        failed=await self.command(self.a['token'],'message.event',{'messageId':original['id'],'status':'failed','exitConfirmed':True,'notStarted':True,'output':'资料未绑定，未启动执行'})
        self.assertEqual(failed['text'],original['text']);self.assertEqual(failed['executionStatus'],'failed')
        await self.command(self.a['token'],'message.event',{'messageId':original['id'],'status':'completed','exitConfirmed':True},expected=409)
        retry=await self.command(self.b['token'],'message.retry',{'messageId':original['id']})
        again=await self.command(self.a['token'],'message.retry',{'messageId':original['id']})
        self.assertEqual(retry['id'],again['id']);self.assertEqual(retry['text'],original['text']);self.assertEqual(retry['retryOf'],original['id'])
        unknown=await self.command(self.a['token'],'message.send',{'meetingId':m['id'],'text':'实际启动的轮次'})
        await self.command(self.a['token'],'message.event',{'messageId':unknown['id'],'status':'reconcile','exitConfirmed':False})
        await self.command(self.a['token'],'message.retry',{'messageId':unknown['id']},expected=409)
        # Old clients must stop on an unsupported terminal state, never replay it.
        old=await self.http.get('/api/collaboration/v2/snapshot',headers={'Authorization':'Bearer '+self.a['token'],'X-Station-Features':'unified-meeting-v1'})
        self.assertEqual(old.status_code,426)
        snap=await self.http.get('/api/collaboration/v2/snapshot',headers={**FEATURES,'Authorization':'Bearer '+self.a['token']})
        self.assertEqual(snap.status_code,200);self.assertEqual(len([m for m in snap.json()['entities']['message'] if m.get('retryOf')==original['id']]),1)

    async def test_r2_exact_revised_baseline_approval_history_and_dispatched_identity(self):
        await self.connect(self.a);await self.connect(self.b)
        project=await self.command(self.a['token'],'project.create',{'config':{'name':'isolated metadata only','repository':{'provider':'github','canonicalUrl':'https://github.com/fixture/review'}}})
        await self.command(self.b['token'],'binding.report',{'schemaVersion':1,'projectId':project['id'],'deviceId':self.b['id'],'state':'ready','bindingRevision':1})
        m=await self.command(self.a['token'],'meeting.create',{'title':'A then B','members':[self.b['id']],'autoApprovePlan':False,'autoAssign':False})
        a={'meetingId':m['id'],'planTaskId':'a','title':'A','objective':'whole A','targetDeviceId':self.b['id'],'agentId':'fixture','resource':'repository','permission':'workspace-write','projectId':project['id'],'baseCommit':'a'*40,'dependencies':[],'inputs':[]}
        b={**a,'planTaskId':'b','title':'B','objective':'whole B','dependencies':['a']}
        plan=await self.command(self.a['token'],'plan.propose',{'meetingId':m['id'],'tasks':[a,b]})
        approved=await self.command(self.a['token'],'plan.review',{'meetingId':m['id'],'expectedRevision':plan['revision'],'tasks':[a,b],'approved':True})
        first=await self.command(self.a['token'],'task.create',a)
        base={'taskId':first['id'],'attemptId':first['attemptId']}
        await self.command(self.b['token'],'task.receipt',{**base,'bindingRevision':1})
        await self.command(self.a['token'],'task.create',b,expected=409)
        await self.command(self.b['token'],'task.event',{**base,'status':'delivered','turnOutcome':'completed','exitConfirmed':True,'delivery':{'summary':'metadata test evidence','tests':'isolated protocol fixture','commit':'b'*40,'branch':'station/fixture/a','prUrl':'https://github.com/fixture/review/pull/1','files':[],'report':{'version':1,**base,'summary':'metadata test evidence','exitConfirmed':True,'files':[],'commit':'b'*40,'tests':[],'unresolved':['Protocol metadata fixture only']}}})
        await self.command(self.a['token'],'task.control',{**base,'deliveryHash':self.checked_delivery_hash(base),'operation':'review','evidence':'isolated fixture checks report metadata; no real Git operation'})
        await self.command(self.a['token'],'task.control',{**base,'deliveryHash':self.checked_delivery_hash(base),'operation':'integrate','evidence':'isolated fixture simulates verified integration, no real Git operation','commit':'b'*40})
        meeting=next(x for x in CollaborationStore(self.store).snapshot(self.account['owner_id'])['entities']['meeting'] if x['id']==m['id'])
        self.assertEqual(meeting['verifiedCommit'],'b'*40);self.assertEqual(meeting['plan'][1]['baseCommit'],'a'*40)
        await self.command(self.a['token'],'task.create',b,expected=409)
        revised={**b,'baseCommit':'b'*40}
        await self.command(self.a['token'],'task.create',revised,expected=409)
        await self.command(self.b['token'],'plan.propose',{'meetingId':m['id'],'tasks':[a,revised]},expected=403)
        await self.command(self.a['token'],'plan.review',{'meetingId':m['id'],'expectedRevision':meeting['revision'],'tasks':[a,{**b,'baseCommit':'c'*40}],'approved':True},expected=409)
        updated=await self.command(self.a['token'],'plan.review',{'meetingId':m['id'],'expectedRevision':meeting['revision'],'tasks':[a,revised],'approved':True})
        second=await self.command(self.a['token'],'task.create',revised);again=await self.command(self.a['token'],'task.create',revised)
        self.assertEqual(second['id'],again['id']);self.assertEqual(second['baseCommit'],'b'*40);self.assertEqual(second['dependencies'],[first['id']]);self.assertEqual(second['approvedPlanRevision'],updated['revision'])
        for field,value in [('targetDeviceId',self.a['id']),('agentId','codex'),('baseCommit','c'*40),('dependencies',[])]:
            await self.command(self.a['token'],'plan.review',{'meetingId':m['id'],'expectedRevision':updated['revision'],'tasks':[a,{**revised,field:value}],'approved':True},expected=409)
        history=CollaborationStore(self.store).replay(self.account['owner_id'],0)['events']
        self.assertTrue(any(e['kind']=='meeting' and e['value'].get('revision')==approved['revision'] and e['value'].get('plan',[{}])[-1].get('baseCommit')=='a'*40 for e in history))

    async def test_r3_business_denial_same_token_wss_identity_expiry_and_revocation(self):
        m,task=await self.prepare();created=await self.command(self.a['token'],'task.create',task)
        response=await self.http.post('/api/collaboration/v2/commands',headers={'Authorization':'Bearer '+self.b['token']},json={'protocol':2,'requestId':str(uuid.uuid4()),'action':'task.control','payload':{'taskId':created['id'],'attemptId':created['attemptId'],'operation':'review','evidence':'not coordinator'}})
        self.assertEqual(response.status_code,403);self.assertEqual(response.json()['detail']['code'],'FORBIDDEN')
        headers={**FEATURES,'Authorization':'Bearer '+self.b['token'],'X-Station-Device':self.b['id']}
        self.assertEqual((await self.http.get('/api/collaboration/v2/snapshot',headers=headers)).status_code,200)
        identity=await self.http.get('/api/collaboration/v2/identity',headers=headers);self.assertEqual(identity.json()['deviceId'],self.b['id'])
        mismatch=await self.http.get('/api/collaboration/v2/identity',headers={**headers,'X-Station-Device':self.a['id']});self.assertEqual(mismatch.status_code,401);self.assertEqual(mismatch.json()['detail']['code'],'AUTH_INVALID')
        ws,generation=await self.connect(self.b)
        await ws.send(json.dumps({'protocol':2,'type':'ping','generation':generation}));self.assertEqual(json.loads(await ws.recv())['type'],'pong')
        with self.engine.begin() as c:c.execute(credentials.update().where(credentials.c.digest==self.store.digest(self.b['token'])).values(expires=time.time()-1))
        invalid=await self.http.get('/api/collaboration/v2/snapshot',headers=headers);self.assertEqual(invalid.status_code,401)
        await ws.send(json.dumps({'protocol':2,'type':'ping','generation':generation}))
        while True:
            try:await asyncio.wait_for(ws.recv(),5)
            except websockets.exceptions.ConnectionClosed as exc:self.assertEqual(exc.rcvd.code,4401);break
        # A separate credential is genuinely revoked without deleting its device.
        with self.engine.begin() as c:c.execute(credentials.update().where(credentials.c.digest==self.store.digest(self.a['token'])).values(revoked=1))
        self.assertEqual((await self.http.get('/api/collaboration/v2/identity',headers={'Authorization':'Bearer '+self.a['token']})).status_code,401)

    async def test_r4_renaming_does_not_change_structured_agent_or_native_target_and_foreign_rejected(self):
        m,_=await self.prepare();member={'deviceId':self.b['id'],'agentId':'codex'}
        m=await self.command(self.a['token'],'meeting.update',{'meetingId':m['id'],'expectedRevision':3,'members':[self.b['id']],'participants':[member],'autoApprovePlan':False,'autoAssign':False})
        b=next(d for d in CollaborationStore(self.store).snapshot(self.account['owner_id'])['entities']['device'] if d['id']==self.b['id'])
        await self.command(self.b['token'],'device.update',{'expectedRevision':b['revision'],'config':{**self.b['config'],'name':'改名 中文 + 符号'}})
        message=await self.command(self.a['token'],'message.send',{'meetingId':m['id'],'text':'@原中文 电脑 · codex 讨论','targetDeviceId':self.b['id'],'targetAgentId':'codex'})
        self.assertEqual(message['route'],'agent');self.assertEqual(message['targetDeviceId'],self.b['id'])
        await self.command(self.a['token'],'message.send',{'meetingId':m['id'],'text':'wrong member','targetDeviceId':self.a['id'],'targetAgentId':'codex'},expected=409)
        await self.command(self.a['token'],'message.send',{'meetingId':m['id'],'text':'unknown native','targetDeviceId':self.b['id'],'nativeSessionId':'not-existing'},expected=404)
        outside=await self.command(self.other['control_token'],'device.register',{'deviceId':str(uuid.uuid4()),'config':self.a['config']})
        await self.command(outside['deviceToken'],'message.send',{'meetingId':m['id'],'text':'outside account','targetDeviceId':self.b['id'],'targetAgentId':'codex'},expected=404)
        CollaborationStore(self.store).connection(self.account['owner_id'],self.b['id'],False)
        # Existing WS is still authoritative, so close it before the offline check.
        for socket in self.sockets:await socket.close()
        await asyncio.sleep(.4)
        await self.command(self.a['token'],'message.send',{'meetingId':m['id'],'text':'offline','targetDeviceId':self.b['id'],'targetAgentId':'codex'},expected=409)

if __name__=='__main__':baseline.unittest.main()
