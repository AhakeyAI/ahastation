"""Unified routing through production HTTP/WSS and transactional account store."""
import test_station_collaboration as baseline
from collaboration_store import CollaborationStore

class UnifiedMeetingTest(baseline.StationCollaborationTest):
    # Inherit the complete old protocol regression as well as these new cases.
    async def test_plan_dependencies_are_owned_acyclic_and_stable_after_dispatch(self):
        m,task=await self.prepare();task={**task,'planTaskId':'whole'}
        await self.command(self.a['token'],'plan.review',{'meetingId':m['id'],'expectedRevision':3,'tasks':[{**task,'dependencies':['foreign-task']}],'approved':True},expected=400)
        await self.command(self.a['token'],'plan.review',{'meetingId':m['id'],'expectedRevision':3,'tasks':[{**task,'dependencies':['whole']}],'approved':True},expected=400)
        reviewed=await self.command(self.a['token'],'plan.review',{'meetingId':m['id'],'expectedRevision':3,'tasks':[task],'approved':True})
        first=await self.command(self.a['token'],'task.create',task);again=await self.command(self.a['token'],'task.create',task)
        self.assertEqual(first['id'],again['id'])
        await self.command(self.a['token'],'plan.review',{'meetingId':m['id'],'expectedRevision':reviewed['revision'],'tasks':[{**task,'objective':'silently change dispatched work'}],'approved':True},expected=409)

    async def test_removing_execution_candidacy_keeps_member_discussion_and_received_work(self):
        m,task=await self.prepare();received=await self.command(self.a['token'],'task.create',task)
        await self.command(self.b['token'],'task.receipt',{'taskId':received['id'],'attemptId':received['attemptId'],'bindingRevision':0})
        updated=await self.command(self.a['token'],'meeting.update',{'meetingId':m['id'],'expectedRevision':3,'members':[self.b['id']],'participants':[{'deviceId':self.b['id'],'agentId':'codex','executionCandidate':False}],'autoAssign':False,'autoApprovePlan':False})
        msg=await self.command(self.b['token'],'message.send',{'meetingId':m['id'],'text':'still discuss','targetDeviceId':self.b['id'],'targetAgentId':'codex'})
        self.assertEqual(msg['route'],'agent');self.assertFalse(updated['participants'][0]['executionCandidate'])
        current=next(t for t in CollaborationStore(self.store).snapshot(self.account['owner_id'])['entities']['task'] if t['id']==received['id'])
        self.assertEqual(current['status'],'received');self.assertFalse(current.get('stopRequested',False))
        stopped=await self.command(self.a['token'],'message.stop',{'messageId':msg['id']});self.assertTrue(stopped['stopRequested'])

    async def test_older_clients_get_explicit_upgrade_requirement(self):
        await self.connect(self.a)
        await self.command(self.a['token'],'meeting.create',{'title':'unified','members':[],'participants':[],'hostAuthority':'original-orchestrator','hostAgentId':'codex','autoAssign':False,'autoApprovePlan':False})
        headers={'Authorization':'Bearer '+self.a['token']}
        self.assertEqual((await self.http.get('/api/collaboration/v2/snapshot',headers=headers)).status_code,426)
        value=await self.http.get('/api/collaboration/v2/snapshot',headers={**headers,'X-Station-Features':'unified-meeting-v1'})
        self.assertEqual(value.status_code,200);self.assertIn('unified-meeting-v1',value.json()['capabilities'])
    async def test_approved_target_is_immutable_even_in_auto_assignment(self):
        meeting,task=await self.prepare()
        updated=await self.command(self.a['token'],'meeting.update',{'meetingId':meeting['id'],'expectedRevision':3,'members':[self.a['id'],self.b['id']],'autoApprovePlan':False,'autoAssign':True})
        await self.command(self.a['token'],'task.create',{**task,'targetDeviceId':self.a['id']},expected=409)
        self.assertTrue(updated['autoAssign'])

    async def test_members_are_stable_and_b_can_join_discuss_without_project_or_second_host(self):
        await self.connect(self.a);await self.connect(self.b)
        m=await self.command(self.a['token'],'meeting.create',{'title':'text first','members':[],'participants':[],'autoApprovePlan':False,'autoAssign':False,'hostAgentId':'codex','hostAuthority':'original-orchestrator'})
        participant={'deviceId':self.b['id'],'agentId':'codex'}
        m=await self.command(self.a['token'],'meeting.update',{'meetingId':m['id'],'expectedRevision':m['revision'],'members':[self.b['id']],'participants':[participant,participant],'autoApprovePlan':False,'autoAssign':False})
        self.assertEqual(m['participants'],[participant]);self.assertNotIn(self.a['id'],m['members'])
        msg=await self.command(self.b['token'],'message.send',{'meetingId':m['id'],'text':'independent discussion','targetDeviceId':self.b['id'],'targetAgentId':'codex'})
        self.assertEqual(msg['route'],'agent')
        snapshot=CollaborationStore(self.store).snapshot(self.account['owner_id'])
        self.assertEqual(len(snapshot['entities']['meeting']),1);self.assertEqual(len(snapshot['entities']['task']),0)
        await self.command(self.b['token'],'message.send',{'meetingId':m['id'],'text':'ambiguous','targetDeviceId':self.b['id'],'targetAgentId':'codex','taskId':'bad'},expected=400)

    async def test_explicit_task_chat_saves_only_that_tasks_mailbox_and_never_dispatches_host(self):
        m,task=await self.prepare();one=await self.command(self.a['token'],'task.create',task)
        chat=await self.command(self.b['token'],'message.send',{'meetingId':m['id'],'text':'precise followup','taskId':one['id']})
        self.assertEqual(chat['route'],'task')
        snap=CollaborationStore(self.store).snapshot(self.account['owner_id']);saved=next(t for t in snap['entities']['task'] if t['id']==one['id'])
        self.assertEqual(saved['pendingFollowups'][0]['text'],'precise followup');self.assertFalse(saved['pendingFollowups'][0]['delivered']);self.assertEqual(saved['attemptId'],one['attemptId'])
        await self.command(self.b['token'],'message.send',{'meetingId':'other','text':'foreign','taskId':one['id']},expected=404)

    async def test_remote_configuration_is_a_saved_request_and_plan_review_is_versioned(self):
        m,task=await self.prepare()
        request=await self.command(self.b['token'],'meeting.request',{'meetingId':m['id'],'operation':'stop-host'})
        self.assertEqual(request['route'],'control');self.assertEqual(request['targetDeviceId'],self.a['id'])
        await self.command(self.b['token'],'meeting.update',{'meetingId':m['id'],'expectedRevision':3,'members':[],'autoApprovePlan':False,'autoAssign':False},expected=403)
        brief={'goal':'edited goal','approach':'edited why','steps':[],'risks':[],'openQuestions':[]}
        reviewed=await self.command(self.a['token'],'plan.review',{'meetingId':m['id'],'expectedRevision':3,'tasks':[task],'brief':brief,'approved':True})
        self.assertEqual(reviewed['planBrief'],brief)
        await self.command(self.a['token'],'plan.review',{'meetingId':m['id'],'expectedRevision':3,'tasks':[task],'approved':True},expected=409)

    async def test_host_migration_preserves_ids_and_refuses_inflight_tasks(self):
        m,task=await self.prepare();offered=await self.command(self.a['token'],'task.create',task)
        await self.command(self.a['token'],'meeting.migrate',{'meetingId':m['id'],'expectedRevision':3},expected=409)
        await self.command(self.a['token'],'task.control',{'taskId':offered['id'],'attemptId':offered['attemptId'],'operation':'stop'})
        await self.command(self.b['token'],'task.event',{'taskId':offered['id'],'attemptId':offered['attemptId'],'status':'stopped','exitConfirmed':True})
        migrated=await self.command(self.a['token'],'meeting.migrate',{'meetingId':m['id'],'expectedRevision':3})
        self.assertEqual(migrated['id'],m['id']);self.assertEqual(migrated['hostAuthority'],'original-orchestrator')
