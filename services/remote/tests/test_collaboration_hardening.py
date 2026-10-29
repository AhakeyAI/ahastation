"""Q108-Q112: actual production HTTP/WSS and SQLite / owned MySQL5.7."""
import json
import uuid
from sqlalchemy import select,update
import test_station_collaboration as baseline
from collaboration_store import CollaborationStore,requests

class HardeningTest(baseline.StationCollaborationTest):
    async def test_H11_normal_stop_human_review_and_verified_dependency_do_not_require_new_execution(self):
        meeting,payload=await self.prepare();task=await self.command(self.a['token'],'task.create',payload);base={'taskId':task['id'],'attemptId':task['attemptId']}
        await self.command(self.b['token'],'task.receipt',{**base,'bindingRevision':0})
        await self.command(self.a['token'],'task.control',{**base,'operation':'stop'})
        delivery=await self.publish_generated_text(self.b['token'],base,'original normal result')
        await self.command(self.b['token'],'task.event',{**base,'status':'delivered','turnOutcome':'completed','exitConfirmed':True,'delivery':delivery})
        await self.command(self.a['token'],'task.control',{**base,'deliveryHash':self.checked_delivery_hash(base),'operation':'review','evidence':'human explicitly checked original text'})
        verified=await self.command(self.a['token'],'task.control',{**base,'deliveryHash':self.checked_delivery_hash(base),'operation':'integrate','evidence':'human explicitly confirmed original text'})
        self.assertEqual(verified['attemptId'],task['attemptId']);self.assertTrue(verified['stopRequested']);self.assertEqual(verified['integration'],'verified')
        dependent={**payload,'planTaskId':'dependent','title':'separate approved delivery','dependencies':[task['id']]}
        plan=await self.command(self.a['token'],'plan.propose',{'meetingId':meeting['id'],'tasks':[payload,dependent]})
        await self.command(self.a['token'],'task.create',dependent,expected=409)
        await self.command(self.a['token'],'plan.decide',{'meetingId':meeting['id'],'expectedRevision':plan['revision'],'approved':True})
        created=await self.command(self.a['token'],'task.create',dependent);self.assertEqual(created['dependencies'],[task['id']])
        accepted=await self.command(self.a['token'],'task.control',{**base,'operation':'accept'})
        self.assertEqual(accepted['status'],'accepted');self.assertTrue(accepted['stopRequested']);self.assertEqual(accepted['attemptId'],task['attemptId'])
        await self.command(self.a['token'],'task.control',{**base,'operation':'advance'},expected=409)
    async def test_H06_query_receipt_keeps_arbitrary_valid_legacy_identity(self):
        meeting,_=await self.prepare();identity='legacy:slash/plus+query?'
        message=await self.command(self.a['token'],'message.send',{'meetingId':meeting['id'],'text':'original'},identity)
        response=await self.http.get('/api/collaboration/v2/message-receipts',params={'requestId':identity},headers={'Authorization':'Bearer '+self.a['token']})
        self.assertEqual(response.status_code,200,response.text);self.assertEqual(response.json()['requestId'],identity);self.assertEqual(response.json()['value']['id'],message['id'])
    async def test_H06_original_old_receipt_read_is_private_read_only_and_survives_missing_submission_field(self):
        meeting,_=await self.prepare();identity=str(uuid.uuid4())
        message=await self.command(self.a['token'],'message.send',{'meetingId':meeting['id'],'text':'old receipt body'},identity)
        with self.engine.begin() as c:
            row=c.execute(select(requests).where(requests.c.owner==self.account['owner_id'],requests.c.id==identity)).mappings().one()
            old=json.loads(row['result']);old['value'].pop('submissionId',None)
            c.execute(update(requests).where(requests.c.owner==self.account['owner_id'],requests.c.id==identity).values(result=json.dumps(old)))
        before=CollaborationStore(self.store).snapshot(self.account['owner_id'])['cursor']
        headers={'Authorization':'Bearer '+self.a['token']}
        for _ in range(2):
            reply=await self.http.get('/api/collaboration/v2/message-receipts/'+identity,headers=headers)
            self.assertEqual(reply.status_code,200,reply.text);value=reply.json();self.assertTrue(value['found']);self.assertEqual(value['value']['id'],message['id']);self.assertNotIn('submissionId',value['value'])
        foreign=await self.http.get('/api/collaboration/v2/message-receipts/'+identity,headers={'Authorization':'Bearer '+self.b['token']})
        self.assertFalse(foreign.json()['found'])
        self.assertEqual(CollaborationStore(self.store).snapshot(self.account['owner_id'])['cursor'],before)

    async def test_H10_H11_normal_end_is_independent_of_stop_request_and_late_progress(self):
        meeting,payload=await self.prepare()
        for stop_first in (True,False):
            # A fresh approved plan for each independent execution identity.
            current=next(m for m in CollaborationStore(self.store).snapshot(self.account['owner_id'])['entities']['meeting'] if m['id']==meeting['id'])
            item={**payload,'planTaskId':'whole-'+str(stop_first),'title':'whole '+str(stop_first)}
            plan=await self.command(self.a['token'],'plan.propose',{'meetingId':meeting['id'],'tasks':current['plan']+[item]})
            await self.command(self.a['token'],'plan.decide',{'meetingId':meeting['id'],'expectedRevision':plan['revision'],'approved':True})
            task=await self.command(self.a['token'],'task.create',item);base={'taskId':task['id'],'attemptId':task['attemptId']}
            await self.command(self.b['token'],'task.receipt',{**base,'bindingRevision':0})
            if stop_first:await self.command(self.a['token'],'task.control',{**base,'operation':'stop'})
            ended=await self.command(self.b['token'],'task.event',{**base,'status':'executed','turnOutcome':'completed','exitConfirmed':True})
            self.assertEqual(ended['turnOutcome'],'completed')
            if not stop_first:await self.command(self.a['token'],'task.control',{**base,'operation':'stop'})
            await self.command(self.a['token'],'task.control',{**base,'operation':'supplement','text':'must await explicit continue'})
            await self.command(self.a['token'],'task.control',{**base,'operation':'advance'},expected=409)
            late=await self.command(self.b['token'],'task.event',{**base,'status':'stop-unconfirmed','exitConfirmed':False})
            self.assertEqual(late['status'],'executed');self.assertTrue(late['exitConfirmed'])
            delivery={'summary':'original finished turn','tests':'未运行：停止后不新启动测试','files':[],'commit':'','branch':'','prUrl':''}
            delivery=await self.publish_generated_text(self.b['token'],base,delivery['summary'])
            delivered=await self.command(self.b['token'],'task.event',{**base,'status':'delivered','turnOutcome':'completed','exitConfirmed':True,'delivery':delivery})
            self.assertTrue(delivered['stopRequested']);self.assertEqual(delivered['delivery'],delivery)
            late=await self.command(self.b['token'],'task.event',{**base,'status':'stopped','exitConfirmed':True})
            self.assertEqual(late['status'],'delivered')
            await self.command(self.b['token'],'task.event',{**base,'status':'stopped','turnOutcome':'interrupted','exitConfirmed':True},expected=409)
            continued=await self.command(self.a['token'],'task.control',{**base,'operation':'continue','text':'human explicitly continues','followups':[]})
            self.assertNotEqual(continued['attemptId'],task['attemptId']);self.assertNotIn('turnOutcome',continued);self.assertFalse(continued['stopRequested'])

    async def test_H12_interrupted_output_never_becomes_complete_delivery_or_releases_dependencies(self):
        meeting,payload=await self.prepare();task=await self.command(self.a['token'],'task.create',payload);base={'taskId':task['id'],'attemptId':task['attemptId']}
        await self.command(self.b['token'],'task.receipt',{**base,'bindingRevision':0})
        stopped=await self.command(self.b['token'],'task.event',{**base,'status':'stopped','turnOutcome':'interrupted','exitConfirmed':True,'output':'partial text retained'})
        self.assertEqual(stopped['output'],['partial text retained'])
        await self.command(self.b['token'],'task.event',{**base,'status':'delivered','turnOutcome':'completed','exitConfirmed':True},expected=409)
        await self.command(self.a['token'],'task.control',{**base,'deliveryHash':self.checked_delivery_hash(base),'operation':'review','evidence':'cannot make partial complete'},expected=409)

    async def test_H10_expert_normal_completion_cannot_be_replaced_by_a_late_stop_result(self):
        meeting,_=await self.prepare();message=await self.command(self.a['token'],'message.send',{'meetingId':meeting['id'],'text':'Host input'})
        base={'messageId':message['id']}
        await self.command(self.a['token'],'message.event',{**base,'status':'completed','turnOutcome':'completed','exitConfirmed':True,'output':'normal output'})
        late=await self.command(self.a['token'],'message.event',{**base,'status':'stopped','exitConfirmed':True})
        self.assertEqual(late['executionStatus'],'completed');self.assertEqual(late['output'],'normal output')
        await self.command(self.a['token'],'message.event',{**base,'status':'stopped','turnOutcome':'interrupted','exitConfirmed':True},expected=409)

    async def test_H14_old_client_gets_explicit_version_error_after_new_outcome_not_invalidated_identity(self):
        m,_=await self.prepare();msg=await self.command(self.a['token'],'message.send',{'meetingId':m['id'],'text':'host'})
        await self.command(self.a['token'],'message.event',{'messageId':msg['id'],'status':'completed','exitConfirmed':True,'turnOutcome':'completed'})
        headers={'Authorization':'Bearer '+self.a['token'],'X-Station-Features':'unified-meeting-v1,unified-review-fixes-v1,unified-stability-v1'}
        self.assertEqual((await self.http.get('/api/collaboration/v2/snapshot',headers=headers)).status_code,426)
        headers['X-Station-Features']+=',unified-hardening-v1'
        self.assertEqual((await self.http.get('/api/collaboration/v2/snapshot',headers=headers)).status_code,200)
        self.assertEqual((await self.http.get('/api/collaboration/v2/identity',headers=headers)).status_code,200)
