"""Q102–Q107: production HTTP/WSS, durable DB; SQLite and owned MySQL 5.7."""
import asyncio
import uuid
import test_station_collaboration as baseline
from collaboration_store import CollaborationStore
from sqlalchemy import select
from collaboration_store import requests

class StabilityTest(baseline.StationCollaborationTest):
    def current(self,meeting):
        return next(m for m in CollaborationStore(self.store).snapshot(self.account['owner_id'])['entities']['meeting'] if m['id']==meeting['id'])

    async def test_only_host_can_decide_plan_without_affecting_execution_device_tool_approval(self):
        meeting, task = await self.prepare()
        service = CollaborationStore(self.store)
        basis = self.current(meeting)
        for action in ('plan.review', 'plan.decide'):
            for approved in (True, False):
                with self.subTest(action=action, approved=approved):
                    identity = str(uuid.uuid4())
                    payload = {'meetingId': meeting['id'], 'expectedPlanVersion': basis['planVersion'], 'approved': approved}
                    if action == 'plan.review':
                        payload.update(tasks=[{**task, 'objective': 'unauthorized replacement'}])
                    before = service.snapshot(self.account['owner_id'])
                    await self.command(self.b['token'], action, payload, identity, expected=403)
                    self.assertEqual(service.snapshot(self.account['owner_id']), before)
                    with self.engine.connect() as connection:
                        self.assertIsNone(connection.execute(select(requests.c.id).where(requests.c.id == identity)).scalar())

        reviewed = await self.command(self.a['token'], 'plan.review', {
            'meetingId': meeting['id'], 'expectedPlanVersion': basis['planVersion'], 'tasks': [task], 'approved': True,
        })
        self.assertTrue(reviewed['planApproved'])
        rejected = await self.command(self.a['token'], 'plan.decide', {
            'meetingId': meeting['id'], 'expectedPlanVersion': reviewed['planVersion'], 'approved': False,
        })
        self.assertFalse(rejected['planApproved'])
        await self.command(self.a['token'], 'plan.decide', {
            'meetingId': meeting['id'], 'expectedPlanVersion': rejected['planVersion'], 'approved': True,
        })
        created = await self.command(self.a['token'], 'task.create', task)
        execution = {'taskId': created['id'], 'attemptId': created['attemptId']}
        await self.command(self.b['token'], 'task.receipt', {**execution, 'bindingRevision': 0})
        approval = await self.command(self.b['token'], 'approval.request', {
            **execution, 'approvalId': str(uuid.uuid4()), 'tool': 'file-write', 'description': 'local action', 'supported': True,
        })
        decided = await self.command(self.b['token'], 'approval.decide', {'approvalId': approval['id'], 'decision': 'allow'})
        self.assertEqual(decided['decision'], 'allow')
        self.assertEqual(decided['decidedBy'], self.b['id'])
        await self.command(self.a['token'], 'approval.decide', {'approvalId': approval['id'], 'decision': 'deny'}, expected=409)

    async def test_identical_host_proposal_keeps_existing_approval_and_only_real_change_needs_review(self):
        m,task=await self.prepare();before=self.current(m)
        same=await self.command(self.a['token'],'plan.propose',{'meetingId':m['id'],'expectedPlanVersion':before['planVersion'],'expectedPlanDecisionVersion':before['planDecisionVersion'],'tasks':[task]})
        self.assertTrue(same['planApproved']);self.assertEqual(same['planVersion'],before['planVersion']);self.assertEqual(same['planDecisionVersion'],before['planDecisionVersion'])
        changed=await self.command(self.a['token'],'plan.propose',{'meetingId':m['id'],'expectedPlanVersion':same['planVersion'],'expectedPlanDecisionVersion':same['planDecisionVersion'],'tasks':[{**task,'objective':'actual new arrangement'}]})
        self.assertFalse(changed['planApproved']);self.assertEqual(changed['planVersion'],same['planVersion']+1)
        # An explicit human rejection still changes the decision on the same content.
        approved=await self.command(self.a['token'],'plan.decide',{'meetingId':m['id'],'expectedPlanVersion':changed['planVersion'],'approved':True})
        rejected=await self.command(self.a['token'],'plan.decide',{'meetingId':m['id'],'expectedPlanVersion':approved['planVersion'],'approved':False})
        self.assertFalse(rejected['planApproved']);self.assertEqual(rejected['planVersion'],approved['planVersion'])

    async def test_expert_retry_preserves_exact_target_and_unknown_is_never_retried(self):
        m,_=await self.prepare()
        m=await self.command(self.a['token'],'meeting.update',{'meetingId':m['id'],'expectedRevision':3,'members':[self.b['id']],'participants':[{'deviceId':self.b['id'],'agentId':'codex'}],'autoApprovePlan':False,'autoAssign':False})
        msg=await self.command(self.a['token'],'message.send',{'meetingId':m['id'],'text':'@中文电脑 独立交流','targetDeviceId':self.b['id'],'targetAgentId':'codex','attachments':[]})
        await self.command(self.a['token'],'message.event',{'messageId':msg['id'],'status':'failed','exitConfirmed':True,'notStarted':True},expected=403)
        await self.command(self.b['token'],'message.event',{'messageId':msg['id'],'status':'failed','exitConfirmed':True,'notStarted':True,'output':'输入准备失败，未启动'})
        first=await self.command(self.a['token'],'message.retry',{'messageId':msg['id']})
        again=await self.command(self.b['token'],'message.retry',{'messageId':msg['id']})
        self.assertEqual(first,again)
        for field in ('meetingId','text','targetDeviceId','targetAgentId','attachments','route'):self.assertEqual(first[field],msg[field])
        await self.command(self.b['token'],'message.event',{'messageId':first['id'],'status':'reconcile','exitConfirmed':False})
        await self.command(self.a['token'],'message.retry',{'messageId':first['id']},expected=409)
        # A different ordinary Host input remains valid while the expert waits.
        host=await self.command(self.a['token'],'message.send',{'meetingId':m['id'],'text':'Host 继续统筹'})
        self.assertEqual(host['route'],'host')
        await self.command(self.b['token'],'message.stop',{'messageId':first['id']})
        await self.command(self.b['token'],'message.event',{'messageId':first['id'],'status':'stopped','exitConfirmed':False},expected=409)
        consultation=await self.command(self.a['token'],'message.send',{'meetingId':m['id'],'text':'Host consultation','targetDeviceId':self.b['id'],'targetAgentId':'codex','consultation':True})
        await self.command(self.b['token'],'message.event',{'messageId':consultation['id'],'status':'failed','exitConfirmed':True,'notStarted':True})
        retry=await self.command(self.b['token'],'message.retry',{'messageId':consultation['id']})
        self.assertTrue(retry['consultation']);self.assertEqual(retry['targetDeviceId'],self.b['id'])

    async def test_plan_content_version_ignores_policy_refresh_but_fences_both_writers(self):
        m,task=await self.prepare();basis=self.current(m)
        v=basis['planVersion'];decision=basis['planDecisionVersion']
        changed=await self.command(self.a['token'],'meeting.update',{'meetingId':m['id'],'expectedRevision':basis['revision'],'members':basis['members'],'autoApprovePlan':False,'autoAssign':True})
        self.assertEqual(changed['planVersion'],v);self.assertEqual(changed['planDecisionVersion'],decision)
        # Human review uses its actual content basis, not the unrelated meeting revision.
        reviewed=await self.command(self.a['token'],'plan.review',{'meetingId':m['id'],'expectedPlanVersion':v,'tasks':[task],'approved':True})
        self.assertEqual(reviewed['planVersion'],v)
        self.assertGreater(reviewed['planDecisionVersion'],decision)
        await self.command(self.a['token'],'plan.propose',{'meetingId':m['id'],'expectedPlanVersion':v,'expectedPlanDecisionVersion':decision,'tasks':[{**task,'objective':'late Host output'}]},expected=409)
        self.assertEqual(self.current(m)['plan'],[task])
        new=await self.command(self.a['token'],'plan.propose',{'meetingId':m['id'],'expectedPlanVersion':v,'expectedPlanDecisionVersion':reviewed['planDecisionVersion'],'tasks':[{**task,'objective':'new explicit proposal'}]})
        self.assertEqual(new['planVersion'],v+1)
        await self.command(self.a['token'],'plan.review',{'meetingId':m['id'],'expectedPlanVersion':v,'tasks':[task],'approved':True},expected=409)
        await self.command(self.a['token'],'plan.decide',{'meetingId':m['id'],'expectedPlanVersion':v,'approved':False},expected=409)
        # Old stations cannot overwrite a meeting using the new protection.
        await self.command(self.a['token'],'plan.propose',{'meetingId':m['id'],'tasks':[task]},expected=426)
        headers={'Authorization':'Bearer '+self.a['token'],'X-Station-Features':'unified-meeting-v1,unified-review-fixes-v1'}
        self.assertEqual((await self.http.get('/api/collaboration/v2/snapshot',headers=headers)).status_code,426)
        headers['X-Station-Features']+=',unified-stability-v1'
        self.assertEqual((await self.http.get('/api/collaboration/v2/snapshot',headers=headers)).status_code,200)

    async def test_dispatched_fields_remain_immutable_at_latest_plan_version(self):
        m,task=await self.prepare();task={**task,'planTaskId':'whole'};basis=self.current(m)
        approved=await self.command(self.a['token'],'plan.review',{'meetingId':m['id'],'expectedPlanVersion':basis['planVersion'],'tasks':[task],'approved':True})
        dispatched=await self.command(self.a['token'],'task.create',task)
        await self.command(self.a['token'],'plan.review',{'meetingId':m['id'],'expectedPlanVersion':approved['planVersion'],'tasks':[{**task,'objective':'edit after dispatch'}],'approved':True},expected=409)
        current=self.current(m);self.assertEqual(current['plan'],[task]);self.assertTrue(current['planApproved'])
        await self.command(self.a['token'],'meeting.update',{'meetingId':m['id'],'expectedRevision':current['revision'],'members':current['members'],'autoApprovePlan':False,'autoAssign':False})
        saved=next(t for t in CollaborationStore(self.store).snapshot(self.account['owner_id'])['entities']['task'] if t['id']==dispatched['id'])
        self.assertEqual(saved['objective'],task['objective']);self.assertFalse(saved.get('stopRequested',False))

    async def test_same_submission_lost_response_and_restart_yield_one_message(self):
        m,_=await self.prepare();request=str(uuid.uuid4());payload={'meetingId':m['id'],'text':'同一正文，可明确再发','attachments':[]}
        # Real concurrent HTTP requests, including an intentionally ignored response.
        responses=await asyncio.gather(*(self.command(self.a['token'],'message.send',payload,request) for _ in range(3)))
        self.assertEqual(len({r['id'] for r in responses}),1)
        self.assertEqual(responses[0]['submissionId'],request)
        service=CollaborationStore(self.store);reopened=CollaborationStore(type(self.store)(self.engine,'test-only-collaboration-secret-at-least-32'))
        self.assertEqual(service.snapshot(self.account['owner_id']),reopened.snapshot(self.account['owner_id']))
        recovered=await self.command(self.a['token'],'message.send',payload,request);self.assertEqual(recovered['id'],responses[0]['id'])
        await self.command(self.a['token'],'message.send',{**payload,'text':'不能改变原提交'},request,expected=409)
        fresh=await self.command(self.a['token'],'message.send',payload)
        self.assertNotEqual(fresh['id'],recovered['id'])
        events=service.replay(self.account['owner_id'],0)['events']
        self.assertEqual(len([e for e in events if e['kind']=='message' and e['id']==recovered['id']]),1)
