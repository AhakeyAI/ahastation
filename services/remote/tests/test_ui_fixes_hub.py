import base64,hashlib,json,math,uuid
from sqlalchemy import create_engine
from test_station_collaboration import StationCollaborationTest
from collaboration_store import CollaborationStore,delivery_hash
from hub_store import HubStore

class UIFixesHub(StationCollaborationTest):
    async def task(self):
        m,p=await self.prepare();p={**p,'planTaskId':'ui-fix-task'};meeting=next(x for x in CollaborationStore(self.store).snapshot(self.account['owner_id'])['entities']['meeting'] if x['id']==m['id']);await self.command(self.a['token'],'plan.review',{'meetingId':m['id'],'expectedPlanVersion':meeting['planVersion'],'tasks':[p],'approved':True});t=await self.command(self.a['token'],'task.create',p);await self.command(self.b['token'],'task.receipt',{'taskId':t['id'],'attemptId':t['attemptId'],'bindingRevision':0});return m,p,t
    def base(self,t):return {'taskId':t['id'],'attemptId':t['attemptId']}
    def current(self,t):return next(r for r in CollaborationStore(self.store).snapshot(self.account['owner_id'])['entities']['task'] if r['id']==t['id'])
    async def raw(self,token,action,p,identity=None):return await self.http.post('/api/collaboration/v2/commands',headers={'Authorization':'Bearer '+token},json={'protocol':2,'requestId':identity or str(uuid.uuid4()),'action':action,'payload':p})
    async def finish(self,t,text='Generated current result🧭'):
        b=self.base(t);await self.command(self.b['token'],'task.event',{**b,'status':'executed','turnOutcome':'completed','exitConfirmed':True});d=await self.publish_generated_text(self.b['token'],b,text);return await self.command(self.b['token'],'task.event',{**b,'status':'delivered','turnOutcome':'completed','exitConfirmed':True,'delivery':d})
    async def test_long_utf8_full_hash_survives_http_hub_reopen_and_preview_is_not_body(self):
        _,_,t=await self.task();text=('中文🧭e\u0301\n'*16000)+'FULL-END';done=await self.finish(t,text);m=done['delivery']['textArtifact'];self.assertLess(len(done['delivery']['summary']),len(text))
        parts=[];headers={'Authorization':'Bearer '+self.a['token']}
        for i in range(m['chunkCount']):
            r=await self.http.get('/api/collaboration/v2/text-artifacts/'+m['artifactId']+'/chunks/'+str(i),headers=headers);self.assertEqual(r.status_code,200);parts.append(base64.b64decode(r.json()['data']))
        actual=b''.join(parts);self.assertEqual(actual,text.encode());self.assertEqual(hashlib.sha256(actual).hexdigest(),m['sha256'])
        reopened=HubStore(create_engine(self.engine.url),'test-only-collaboration-secret-at-least-32');from text_artifacts import TextArtifacts
        saved=TextArtifacts(CollaborationStore(reopened)).get({'owner':self.account['owner_id'],'device':self.a['id']},m['artifactId']);self.assertEqual(saved['manifest'],m);self.assertEqual(saved['missing'],[]);reopened.engine.dispose()
        old=await self.http.get('/api/collaboration/v2/snapshot',headers=headers);self.assertEqual(old.status_code,426)
        new=await self.http.get('/api/collaboration/v2/snapshot',headers={**headers,'X-Station-Features':'unified-meeting-v1,unified-review-fixes-v1,unified-stability-v1,unified-hardening-v1,text-artifacts-v1'});self.assertEqual(new.status_code,200);self.assertNotIn(text,new.text)
    async def test_missing_out_of_order_duplicate_conflict_and_wrong_total_hash(self):
        _,_,t=await self.task();data=('🧭中文e\u0301'*9000+'END').encode();b=self.base(t);m={'version':1,'artifactId':str(uuid.uuid4()),**b,'mediaType':'text/plain;charset=utf-8','byteLength':len(data),'sha256':hashlib.sha256(data).hexdigest(),'chunkSize':32768,'chunkCount':math.ceil(len(data)/32768),'contentComplete':True};h={'Authorization':'Bearer '+self.b['token']};path='/api/collaboration/v2/text-artifacts'
        self.assertEqual((await self.http.post(path,headers=h,json=m)).status_code,200);base=path+'/'+m['artifactId']
        self.assertEqual((await self.http.post(base+'/complete',headers=h,json={})).status_code,409)
        for i in reversed(range(m['chunkCount'])):
            d=data[i*32768:(i+1)*32768];v={'data':base64.b64encode(d).decode(),'sha256':hashlib.sha256(d).hexdigest()}
            for _ in range(2):self.assertEqual((await self.http.put(base+'/chunks/'+str(i),headers=h,json=v)).status_code,200)
        conflict=b'X'*min(32768,len(data));r=await self.http.put(base+'/chunks/0',headers=h,json={'data':base64.b64encode(conflict).decode(),'sha256':hashlib.sha256(conflict).hexdigest()});self.assertEqual(r.status_code,409);self.assertEqual(r.json()['detail']['code'],'TEXT_CHUNK_CONFLICT')
        self.assertEqual((await self.http.post(base+'/complete',headers=h,json={})).status_code,200)
        self.assertEqual((await self.http.post(base+'/complete',headers=h,json={})).status_code,200)
        wrong={**m,'artifactId':str(uuid.uuid4()),'sha256':'0'*64};self.assertEqual((await self.http.post(path,headers=h,json=wrong)).status_code,200)
        for i in range(m['chunkCount']):
            d=data[i*32768:(i+1)*32768];await self.http.put(path+'/'+wrong['artifactId']+'/chunks/'+str(i),headers=h,json={'data':base64.b64encode(d).decode(),'sha256':hashlib.sha256(d).hexdigest()})
        r=await self.http.post(path+'/'+wrong['artifactId']+'/complete',headers=h,json={});self.assertEqual(r.status_code,409);self.assertEqual(r.json()['detail']['code'],'TEXT_ARTIFACT_HASH_MISMATCH')
    async def test_encoded_48k_chunk_body_exceeds_64000_and_oversize_manifest_is_explicit(self):
        _,_,t=await self.task();h={'Authorization':'Bearer '+self.b['token']};path='/api/collaboration/v2/text-artifacts';data=b'X'*49152
        r=await self.http.put(path+'/'+str(uuid.uuid4())+'/chunks/0',headers=h,json={'data':base64.b64encode(data).decode(),'sha256':hashlib.sha256(data).hexdigest()});self.assertEqual(r.status_code,413)
        m={'version':1,'artifactId':str(uuid.uuid4()),**self.base(t),'mediaType':'text/plain;charset=utf-8','byteLength':16777217,'sha256':'0'*64,'chunkSize':32768,'chunkCount':513,'contentComplete':True}
        r=await self.http.post(path,headers=h,json=m);self.assertEqual(r.status_code,413)
        m.update(byteLength=0,chunkCount=0,sha256=hashlib.sha256(b'').hexdigest(),mediaType='application/octet-stream');self.assertEqual((await self.http.post(path,headers=h,json=m)).status_code,400)
    async def test_unreviewed_accept_failed_tests_stale_hash_and_noncoordinator_are_rejected(self):
        _,_,t=await self.task();done=await self.finish(t);b=self.base(t)
        missing=await self.raw(self.a['token'],'task.control',{**b,'operation':'review','evidence':'missing captured identity'});self.assertEqual(missing.status_code,426);self.assertEqual(missing.json()['detail']['code'],'DELIVERY_HASH_REQUIRED')
        r=await self.raw(self.b['token'],'task.control',{**b,'operation':'accept'});self.assertEqual(r.status_code,409);self.assertEqual(r.json()['detail']['code'],'DELIVERY_NOT_REVIEWED')
        self.assertEqual((await self.raw(self.b['token'],'task.control',{**b,'operation':'review','evidence':'bad role'})).status_code,403)
        self.assertEqual((await self.raw(self.a['token'],'task.control',{**b,'operation':'review','evidence':'old','deliveryHash':'0'*64})).status_code,409)
        with CollaborationStore(self.store).transaction(self.account['owner_id']) as c:
            saved=CollaborationStore(self.store).get(c,self.account['owner_id'],'task',t['id']);saved['delivery']['report']['tests']=[{'argv':['node','test'], 'exitCode':1,'output':'actual failure','source':'station-verifier'}];CollaborationStore(self.store).put(c,self.account['owner_id'],'task',t['id'],saved)
        self.assertEqual((await self.raw(self.a['token'],'task.control',{**b,'operation':'review','evidence':'cannot override failure'})).status_code,409)
    async def test_human_review_stable_identity_retry_and_accept_survive_restart_after_stop(self):
        _,_,t=await self.task();done=await self.finish(t);b=self.base(t);await self.command(self.a['token'],'task.control',{**b,'operation':'stop'});digest=delivery_hash(done)
        for op in ['review','integrate']:
            identity='human-'+op+'-'+str(uuid.uuid4());p={**b,'operation':op,'evidence':'Inspected actual full content and test risks','deliveryHash':digest};one=await self.command(self.a['token'],'task.control',p,identity);two=await self.command(self.a['token'],'task.control',p,identity);self.assertEqual(one,two)
        accepted=await self.command(self.a['token'],'task.control',{**b,'operation':'accept'});self.assertEqual(accepted['status'],'accepted');self.assertTrue(accepted['stopRequested']);self.assertEqual(accepted['turnOutcome'],'completed');self.assertEqual(len([e for e in accepted['evidence'] if e.get('operation')=='review']),1)
        reopened=HubStore(create_engine(self.engine.url),'test-only-collaboration-secret-at-least-32');saved=next(x for x in CollaborationStore(reopened).snapshot(self.account['owner_id'])['entities']['task'] if x['id']==t['id']);reopened.engine.dispose();self.assertEqual(saved['verificationBinding']['deliveryHash'],digest);self.assertEqual(saved['status'],'accepted')
    async def test_scope_revision_changes_goal_and_criteria_without_new_attempt_until_continue(self):
        _,_,t=await self.task();done=await self.finish(t);b=self.base(t);await self.command(self.a['token'],'task.control',{**b,'operation':'stop'});supp=await self.command(self.a['token'],'task.control',{**b,'operation':'supplement','text':'replace four with five'});f=supp['pendingFollowups'][-1]
        scope={'objective':'Return FIVE complete sentences and NEW-MARKER','acceptanceCriteria':[{'id':'five','description':'FIVE and NEW-MARKER','verification':{'kind':'manual'}}]}
        revised=await self.command(self.a['token'],'task.control',{**b,'operation':'revise-scope','expectedScopeVersion':0,'scope':scope,'supersededFollowupIds':[f['id']]})
        self.assertEqual(revised['id'],t['id']);self.assertEqual(revised['attemptId'],t['attemptId']);self.assertEqual(revised['objective'],scope['objective']);self.assertEqual(revised['acceptanceCriteria'],scope['acceptanceCriteria']);self.assertTrue(revised['stopRequested']);self.assertTrue(revised['pendingFollowups'][-1]['ignored']);self.assertTrue(revised['scopeHistory'][0]['delivery'])
        self.assertEqual((await self.raw(self.a['token'],'task.control',{**b,'operation':'continue','expectedScopeVersion':0})).status_code,409)
        resumed=await self.command(self.a['token'],'task.control',{**b,'operation':'continue','expectedScopeVersion':1,'followups':[],'text':'Use the current scope and finish this attempt'});self.assertEqual(resumed['id'],t['id']);self.assertNotEqual(resumed['attemptId'],t['attemptId']);self.assertEqual(resumed['objective'],scope['objective']);self.assertIn('明确允许继续',resumed['attemptInstructions']);self.assertNotIn('replace four',resumed['objective'])
    async def test_plan_omission_version_request_identity_and_connection_have_distinct_codes(self):
        m,p,t=await self.task();store=CollaborationStore(self.store);meeting=next(x for x in store.snapshot(self.account['owner_id'])['entities']['meeting'] if x['id']==m['id']);basis={'meetingId':m['id'],'expectedPlanVersion':meeting['planVersion'],'expectedPlanDecisionVersion':meeting['planDecisionVersion']}
        r=await self.raw(self.a['token'],'plan.propose',{**basis,'tasks':[]});self.assertEqual(r.status_code,409);self.assertEqual(r.json()['detail']['code'],'DISPATCHED_TASK_OMITTED')
        r=await self.raw(self.a['token'],'plan.propose',{**basis,'tasks':[p],'expectedPlanVersion':meeting['planVersion']-1});self.assertEqual(r.json()['detail']['code'],'PLAN_VERSION_CONFLICT')
        r=await self.raw(self.a['token'],'plan.propose',{**basis,'tasks':[p],'expectedPlanDecisionVersion':meeting['planDecisionVersion']+1});self.assertEqual(r.json()['detail']['code'],'PLAN_APPROVAL_CONFLICT')
        identity=str(uuid.uuid4());await self.command(self.a['token'],'task.control',{**self.base(t),'operation':'supplement','text':'one'},identity)
        r=await self.raw(self.a['token'],'task.control',{**self.base(t),'operation':'supplement','text':'two'},identity);self.assertEqual(r.json()['detail']['code'],'REQUEST_ID_CONTENT_CONFLICT')
    async def test_old_attempt_chunks_and_wrong_execution_device_cannot_publish(self):
        _,_,t=await self.task();data=b'part';m={'version':1,'artifactId':str(uuid.uuid4()),**self.base(t),'mediaType':'text/plain;charset=utf-8','byteLength':len(data),'sha256':hashlib.sha256(data).hexdigest(),'chunkSize':32768,'chunkCount':1,'contentComplete':True};path='/api/collaboration/v2/text-artifacts'
        r=await self.http.post(path,headers={'Authorization':'Bearer '+self.a['token']},json=m);self.assertEqual(r.status_code,403)
        r=await self.http.post(path,headers={'Authorization':'Bearer '+self.b['token']},json=m);self.assertEqual(r.status_code,200)
        with CollaborationStore(self.store).transaction(self.account['owner_id']) as c:
            saved=CollaborationStore(self.store).get(c,self.account['owner_id'],'task',t['id']);saved['attemptId']=str(uuid.uuid4());CollaborationStore(self.store).put(c,self.account['owner_id'],'task',t['id'],saved)
        r=await self.http.put(path+'/'+m['artifactId']+'/chunks/0',headers={'Authorization':'Bearer '+self.b['token']},json={'data':base64.b64encode(data).decode(),'sha256':hashlib.sha256(data).hexdigest()});self.assertEqual(r.status_code,403)
    async def test_approved_scope_after_normal_completion_waits_for_explicit_continue_without_faking_stop(self):
        _,_,t=await self.task();await self.finish(t);b=self.base(t)
        scope={'objective':'New current delivery format','acceptanceCriteria':[{'id':'new','description':'new exact content','verification':{'kind':'manual'}}]}
        changed=await self.command(self.a['token'],'task.control',{**b,'operation':'revise-scope','expectedScopeVersion':0,'scope':scope})
        self.assertFalse(changed['stopRequested']);self.assertEqual(changed['attemptId'],t['attemptId'])
        self.assertEqual((await self.raw(self.a['token'],'task.control',{**b,'operation':'advance'})).status_code,409)
        self.assertEqual((await self.raw(self.a['token'],'task.control',{**b,'operation':'review','evidence':'old body is not new scope'})).status_code,409)
        resumed=await self.command(self.a['token'],'task.control',{**b,'operation':'continue','expectedScopeVersion':1,'followups':[],'text':'Use the current scope and finish this attempt'})
        self.assertEqual(resumed['id'],t['id']);self.assertNotEqual(resumed['attemptId'],t['attemptId']);self.assertFalse(resumed['stopRequested']);self.assertIn('Use the current scope and finish this attempt',resumed['attemptInstructions']);self.assertEqual(resumed['objective'],scope['objective'])

    async def test_legacy_scope_revision_changes_only_the_exact_original_plan_task(self):
        m,p=await self.prepare();other={**p,'title':'Another independent legacy task','objective':'Keep this objective unchanged'}
        plan=await self.command(self.a['token'],'plan.propose',{'meetingId':m['id'],'tasks':[p,other]});await self.command(self.a['token'],'plan.decide',{'meetingId':m['id'],'expectedRevision':plan['revision'],'approved':True})
        t=await self.command(self.a['token'],'task.create',p);await self.command(self.b['token'],'task.receipt',{**self.base(t),'bindingRevision':0});await self.finish(t)
        await self.command(self.a['token'],'task.control',{**self.base(t),'operation':'revise-scope','expectedScopeVersion':0,'scope':{'objective':'Revised only this original task','acceptanceCriteria':[{'id':'new','description':'New current format','verification':{'kind':'manual'}}]}})
        meeting=next(x for x in CollaborationStore(self.store).snapshot(self.account['owner_id'])['entities']['meeting'] if x['id']==m['id'])
        self.assertEqual(meeting['plan'][0]['objective'],'Revised only this original task');self.assertEqual(meeting['plan'][1],other)

    async def test_invited_nonexecution_participant_reads_full_text_without_receiving_execution_rights(self):
        m,_,t=await self.task();done=await self.finish(t,'Observer can inspect complete text🧭');observer=await self.register('Read-only invited expert');await self.connect(observer)
        meeting=next(x for x in CollaborationStore(self.store).snapshot(self.account['owner_id'])['entities']['meeting'] if x['id']==m['id'])
        await self.command(self.a['token'],'meeting.update',{'meetingId':m['id'],'expectedRevision':meeting['revision'],'members':[self.b['id']],'participants':[{'deviceId':self.b['id'],'agentId':'fixture','executionCandidate':True},{'deviceId':observer['id'],'agentId':'fixture','executionCandidate':False}],'autoApprovePlan':False,'autoAssign':False})
        path='/api/collaboration/v2/text-artifacts/'+done['delivery']['textArtifact']['artifactId'];headers={'Authorization':'Bearer '+observer['token']}
        response=await self.http.get(path,headers=headers);self.assertEqual(response.status_code,200,response.text)
        response=await self.http.get(path+'/chunks/0',headers=headers);self.assertEqual(response.status_code,200);self.assertEqual(base64.b64decode(response.json()['data']).decode(),'Observer can inspect complete text🧭')
        self.assertEqual((await self.raw(observer['token'],'task.receipt',{**self.base(t),'bindingRevision':0})).status_code,403)
        self.assertEqual((await self.http.post(path+'/complete',headers=headers,json={})).status_code,403)
