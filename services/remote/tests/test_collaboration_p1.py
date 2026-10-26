import copy
import uuid
from sqlalchemy import create_engine
import test_ui_fixes_hub as fixtures
from collaboration_store import CollaborationStore, delivery_hash
from hub_store import HubStore


class CollaborationP1(fixtures.UIFixesHub):
    async def test_K01_HTTP_requires_explicit_completion_and_preserves_historical_delivery(self):
        _,_,task=await self.task()
        base=self.base(task)
        delivery=await self.publish_generated_text(self.b['token'],base,'Retained complete fixture')
        for outcome in (None,'unknown','failed','interrupted'):
            payload={**base,'status':'delivered','exitConfirmed':True,'delivery':delivery}
            if outcome:payload['turnOutcome']=outcome
            reply=await self.raw(self.b['token'],'task.event',payload)
            self.assertEqual(reply.status_code,409,reply.text)
            self.assertEqual(reply.json()['detail']['code'],'TURN_COMPLETION_UNCONFIRMED')
            current=self.current(task)
            self.assertNotIn('delivery',current)
            self.assertNotIn('turnOutcome',current)
        done=await self.command(self.b['token'],'task.event',{
            **base,'status':'delivered','exitConfirmed':True,'turnOutcome':'completed','delivery':delivery})
        duplicate=await self.command(self.b['token'],'task.event',{
            **base,'status':'delivered','exitConfirmed':True,'delivery':delivery})
        self.assertEqual(duplicate,done)

    async def verified(self):
        meeting, planned, task = await self.task()
        done = await self.finish(task, '完整中文成果 D1🧭')
        for op in ('review', 'integrate'):
            done = await self.command(self.a['token'], 'task.control', {
                **self.base(task), 'operation': op, 'evidence': 'Inspected exact full content',
                'deliveryHash': delivery_hash(done),
            })
        return meeting, planned, done

    async def test_verified_delivery_rejects_changed_body_tests_and_commit_but_duplicate_is_idempotent(self):
        _, _, task = await self.verified()
        original = copy.deepcopy(task)
        variants = []
        changed = await self.publish_generated_text(self.b['token'], self.base(task), '未经核验 D2')
        variants.append(changed)
        for field, value in [('tests', [{'argv': ['test'], 'exitCode': 0, 'output': 'different', 'source': 'station-verifier'}]), ('commit', 'b' * 40)]:
            changed = copy.deepcopy(task['delivery'])
            changed['report'][field] = value
            if field == 'commit':
                changed[field] = value
            variants.append(changed)
        for delivery in variants:
            with self.subTest(delivery=delivery['summary']):
                response = await self.raw(self.b['token'], 'task.event', {
                    **self.base(task), 'status': 'delivered', 'exitConfirmed': True,
                    'turnOutcome': 'completed', 'delivery': delivery,
                })
                self.assertEqual(response.status_code, 409, response.text)
                self.assertEqual(response.json()['detail']['code'], 'VERIFIED_DELIVERY_IMMUTABLE')
                self.assertEqual(self.current(task), original)
        duplicate = await self.command(self.b['token'], 'task.event', {
            **self.base(task), 'status': 'delivered', 'exitConfirmed': True,
            'turnOutcome': 'completed', 'delivery': task['delivery'],
        })
        self.assertEqual(duplicate, original)
        invalid = await self.raw(self.b['token'], 'task.event', {
            **self.base(task), 'status': 'delivered', 'delivery': task['delivery'],
        })
        self.assertEqual(invalid.status_code, 409, invalid.text)
        reopened = HubStore(create_engine(self.engine.url), 'test-only-collaboration-secret-at-least-32')
        try:
            saved = next(t for t in CollaborationStore(reopened).snapshot(self.account['owner_id'])['entities']['task'] if t['id'] == task['id'])
            self.assertEqual(saved, original)
            self.assertTrue(CollaborationStore.verified_delivery(saved))
        finally:
            reopened.engine.dispose()

    async def test_corrupt_existing_binding_blocks_server_dependencies_and_accept_after_restart(self):
        meeting, planned, task = await self.verified()
        store = CollaborationStore(self.store)
        dependent = {**planned, 'planTaskId': 'dependent', 'title': 'Dependent', 'dependencies': [task['id']]}
        current = next(m for m in store.snapshot(self.account['owner_id'])['entities']['meeting'] if m['id'] == meeting['id'])
        await self.command(self.a['token'], 'plan.review', {'meetingId': meeting['id'], 'expectedPlanVersion': current['planVersion'], 'tasks': [planned, dependent], 'approved': True})
        following = await self.command(self.a['token'], 'task.create', dependent)
        await self.command(self.b['token'], 'task.receipt', {**self.base(following), 'bindingRevision': 0})
        following = await self.finish(following, 'Dependent result before history corruption')
        for op in ('review', 'integrate'):
            following = await self.command(self.a['token'], 'task.control', {
                **self.base(following), 'operation': op, 'evidence': 'Inspected full dependent content', 'deliveryHash': delivery_hash(following),
            })
        with store.transaction(self.account['owner_id']) as c:
            changed = store.get(c, self.account['owner_id'], 'task', task['id'])
            changed['delivery']['report']['summary'] = 'Late report from pre-fix history'
            store.put(c, self.account['owner_id'], 'task', task['id'], changed)
        self.assertFalse(store.verified_delivery(self.current(task)))
        reopened = HubStore(create_engine(self.engine.url), 'test-only-collaboration-secret-at-least-32')
        try:
            saved = next(t for t in CollaborationStore(reopened).snapshot(self.account['owner_id'])['entities']['task'] if t['id'] == task['id'])
            self.assertFalse(CollaborationStore.verified_delivery(saved))
            self.assertEqual(saved['integration'], 'verified')  # preserve historical fact, do not fabricate evidence
        finally:
            reopened.engine.dispose()
        for op in ('integrate', 'accept'):
            response = await self.raw(self.a['token'], 'task.control', {
                **self.base(following), 'operation': op, 'evidence': 'Original dependent evidence', 'deliveryHash': delivery_hash(following),
            })
            self.assertEqual(response.status_code, 409, response.text)
        new_dependent = {**dependent, 'planTaskId': 'new-dependent', 'title': 'New dependent', 'dependencies': [following['id']]}
        current = next(m for m in store.snapshot(self.account['owner_id'])['entities']['meeting'] if m['id'] == meeting['id'])
        await self.command(self.a['token'], 'plan.review', {'meetingId': meeting['id'], 'expectedPlanVersion': current['planVersion'], 'tasks': [planned, dependent, new_dependent], 'approved': True})
        response = await self.raw(self.a['token'], 'task.create', new_dependent)
        self.assertEqual(response.status_code, 409, response.text)
        response = await self.raw(self.a['token'], 'task.control', {**self.base(task), 'operation': 'accept'})
        self.assertEqual(response.status_code, 409, response.text)
        response = await self.raw(self.a['token'], 'task.control', {
            **self.base(task), 'operation': 'review', 'evidence': 'Inspecting D2 must not inherit the old integration',
            'deliveryHash': delivery_hash(self.current(task)),
        })
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()['detail']['code'], 'DELIVERY_IDENTITY_CHANGED')
        self.assertEqual(self.current(task)['verificationBinding'], task['verificationBinding'])
        self.assertFalse(store.verified_delivery(self.current(task)))
        unrelated = {**planned, 'planTaskId': 'unrelated', 'title': 'Independent', 'dependencies': []}
        current = next(m for m in store.snapshot(self.account['owner_id'])['entities']['meeting'] if m['id'] == meeting['id'])
        await self.command(self.a['token'], 'plan.review', {'meetingId': meeting['id'], 'expectedPlanVersion': current['planVersion'], 'tasks': [planned, dependent, new_dependent, unrelated], 'approved': True})
        self.assertEqual((await self.command(self.a['token'], 'task.create', unrelated))['status'], 'offered')

    async def test_corrupt_binding_cannot_authorize_execution_baseline_revision(self):
        meeting, planned, task = await self.verified()
        project = await self.command(self.a['token'], 'project.create', {'config': {
            'name': 'Isolated baseline metadata', 'repository': {'provider': 'github', 'canonicalUrl': 'https://github.com/fixture/p1'},
        }})
        repository = {**planned, 'planTaskId': 'repository', 'title': 'Repository dependent',
                      'resource': 'repository', 'permission': 'workspace-write', 'projectId': project['id'],
                      'baseCommit': 'a' * 40, 'dependencies': [task['id']]}
        store = CollaborationStore(self.store)
        current = next(m for m in store.snapshot(self.account['owner_id'])['entities']['meeting'] if m['id'] == meeting['id'])
        await self.command(self.a['token'], 'plan.review', {'meetingId': meeting['id'], 'expectedPlanVersion': current['planVersion'], 'tasks': [planned, repository], 'approved': True})
        # Inject the exact pre-fix corrupt combination into this owned fixture only.
        with store.transaction(self.account['owner_id']) as c:
            before = store.get(c, self.account['owner_id'], 'task', task['id'])
            before['delivery']['summary'] = 'Late unreviewed preview'
            store.put(c, self.account['owner_id'], 'task', task['id'], before)
            current = store.get(c, self.account['owner_id'], 'meeting', meeting['id'])
            current = store.put(c, self.account['owner_id'], 'meeting', meeting['id'], {**current, 'verifiedCommit': 'b' * 40})
        response = await self.raw(self.a['token'], 'plan.review', {
            'meetingId': meeting['id'], 'expectedPlanVersion': current['planVersion'],
            'tasks': [planned, {**repository, 'baseCommit': 'b' * 40}], 'approved': True,
        })
        self.assertEqual(response.status_code, 409, response.text)
        # The final PR receipt must also reject stale verifiedCommit evidence.
        # Add an injected existing repository record to this owned legacy fixture.
        with store.transaction(self.account['owner_id']) as c:
            historical = {**store.get(c,self.account['owner_id'],'task',task['id']),
                          **repository, 'id': str(uuid.uuid4()), 'dependencies': [task['id']]}
            historical['delivery'] = copy.deepcopy(historical['delivery'])
            historical['delivery']['report']['taskId'] = historical['id']
            historical['verificationBinding'] = {'attemptId': historical['attemptId'], 'reviewed': True,
                                                 'deliveryHash': delivery_hash(historical)}
            self.assertTrue(store.verified_delivery(historical))
            store.put(c, self.account['owner_id'], 'task', historical['id'], historical)
        response = await self.raw(self.a['token'], 'meeting.result', {
            'meetingId': meeting['id'], 'commit': 'b' * 40, 'prUrl': 'https://github.com/fixture/p1/pull/1',
        })
        self.assertEqual(response.status_code, 409, response.text)

    async def test_explicit_new_attempt_replaces_scope_without_inheriting_review(self):
        meeting, planned, task = await self.verified()
        base = self.base(task)
        await self.command(self.a['token'], 'task.control', {
            **base, 'operation': 'revise-scope', 'expectedScopeVersion': 0,
            'scope': {'objective': 'Explicit new scope', 'acceptanceCriteria': [
                {'id': 'new', 'description': 'New result', 'verification': {'kind': 'manual'}},
            ]},
        })
        resumed = await self.command(self.a['token'], 'task.control', {
            **base, 'operation': 'continue', 'expectedScopeVersion': 1, 'followups': [],
        })
        self.assertNotEqual(resumed['attemptId'], task['attemptId'])
        self.assertFalse(CollaborationStore.verified_delivery(resumed))
        stale = await self.raw(self.b['token'], 'task.event', {
            **base, 'status': 'delivered', 'exitConfirmed': True, 'turnOutcome': 'completed', 'delivery': task['delivery'],
        })
        self.assertEqual(stale.status_code, 409)
        await self.command(self.b['token'], 'task.receipt', {**self.base(resumed), 'bindingRevision': 0})
        await self.command(self.b['token'], 'task.event', {**self.base(resumed), 'status': 'executed', 'exitConfirmed': True, 'turnOutcome': 'completed'})
        delivery = await self.publish_generated_text(self.b['token'], self.base(resumed), 'Explicit D2 new attempt')
        stale_scope = await self.raw(self.b['token'], 'task.event', {
            **self.base(resumed), 'status': 'delivered', 'exitConfirmed': True, 'turnOutcome': 'completed', 'delivery': delivery,
        })
        self.assertEqual(stale_scope.status_code, 409)
        self.assertEqual(stale_scope.json()['detail']['code'], 'SCOPE_DELIVERY_OUTDATED')
        delivery['scopeVersion'] = 1
        done = await self.command(self.b['token'], 'task.event', {
            **self.base(resumed), 'status': 'delivered', 'exitConfirmed': True, 'turnOutcome': 'completed', 'delivery': delivery,
        })
        self.assertFalse(CollaborationStore.verified_delivery(done))
        for op in ('review', 'integrate'):
            done = await self.command(self.a['token'], 'task.control', {
                **self.base(resumed), 'operation': op, 'evidence': 'Reviewed new scope result', 'deliveryHash': delivery_hash(done),
            })
        self.assertTrue(CollaborationStore.verified_delivery(done))
        current = next(m for m in CollaborationStore(self.store).snapshot(self.account['owner_id'])['entities']['meeting'] if m['id'] == meeting['id'])
        following = {**current['plan'][0], 'planTaskId': 'new-attempt-dependent', 'title': 'Consume newly verified result', 'dependencies': [done['id']]}
        await self.command(self.a['token'], 'plan.review', {
            'meetingId': meeting['id'], 'expectedPlanVersion': current['planVersion'], 'tasks': [*current['plan'], following], 'approved': True,
        })
        self.assertEqual((await self.command(self.a['token'], 'task.create', following))['status'], 'offered')

    async def test_original_plan_request_receipt_wins_after_lost_response_and_plan_change(self):
        meeting, planned = await self.prepare()
        store = CollaborationStore(self.store)
        current = next(m for m in store.snapshot(self.account['owner_id'])['entities']['meeting'] if m['id'] == meeting['id'])
        payload = {'meetingId': meeting['id'], 'tasks': [planned], 'expectedPlanVersion': current.get('planVersion', 0), 'expectedPlanDecisionVersion': current.get('planDecisionVersion', 0)}
        rejected_id = 'hp:' + str(uuid.uuid4())
        rejected = await self.raw(self.a['token'], 'plan.propose', {
            **payload, 'tasks': [{**planned, 'dependencies': ['unknown-task']}],
        }, rejected_id)
        self.assertEqual(rejected.status_code, 400, rejected.text)
        self.assertEqual(rejected.json()['detail']['requestId'], rejected_id)
        self.assertIs(rejected.json()['detail']['applied'], False)
        identity = 'hp:' + str(uuid.uuid4())
        original = await self.command(self.a['token'], 'plan.propose', payload, identity)
        await self.command(self.a['token'], 'plan.propose', {
            'meetingId': meeting['id'], 'tasks': [], 'expectedPlanVersion': original['planVersion'],
            'expectedPlanDecisionVersion': original.get('planDecisionVersion', 0),
        })
        replay = await self.command(self.a['token'], 'plan.propose', payload, identity)
        self.assertEqual(replay, original)
        conflict = await self.raw(self.a['token'], 'plan.propose', {**payload, 'tasks': []}, identity)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()['detail']['code'], 'REQUEST_ID_CONTENT_CONFLICT')


def load_tests(loader, tests, pattern):
    # Inherited regressions run in their own files; count these independent cases once.
    import unittest
    return unittest.TestSuite(CollaborationP1(name) for name in CollaborationP1.__dict__ if name.startswith('test_'))
