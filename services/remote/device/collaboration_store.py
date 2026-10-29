"""Durable Station collaboration. Socket delivery is only a wakeup hint.

All commands serialize on the account row and commit state, cursor, events and
request receipt together. No cloud method interprets a local path as authority.
"""
from __future__ import annotations
import hashlib
import json
import time
import uuid
import os
import base64
from contextlib import contextmanager, nullcontext
from pathlib import Path
from fastapi import HTTPException
from sqlalchemy import MetaData, Table, Column, String, Integer, Text, select, update
from sqlalchemy.dialects.mysql import LONGTEXT
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

metadata = MetaData()
accounts = Table('collab_accounts', metadata, Column('owner', String(36), primary_key=True), Column('cursor', Integer, nullable=False))
entities = Table('collab_entities', metadata, Column('owner', String(36), primary_key=True),
    Column('kind', String(24), primary_key=True), Column('id', String(160), primary_key=True),
    Column('revision', Integer, nullable=False), Column('data', Text().with_variant(LONGTEXT(), 'mysql'), nullable=False))
events = Table('collab_events', metadata, Column('owner', String(36), primary_key=True), Column('seq', Integer, primary_key=True),
    Column('data', Text().with_variant(LONGTEXT(), 'mysql'), nullable=False))
requests = Table('collab_requests', metadata, Column('owner', String(36), primary_key=True), Column('id', String(80), primary_key=True),
    Column('digest', String(64), nullable=False), Column('result', Text().with_variant(LONGTEXT(), 'mysql'), nullable=False))
from text_artifacts import install_tables,TextArtifacts
install_tables(metadata)
for table in metadata.tables.values():
    table.dialect_options['mysql'].update(engine='InnoDB', charset='utf8mb4', collate='utf8mb4_bin')

def contract_directories(module_path):
    # Cloud export: /app/device -> /app/contracts. The source checkout has
    # services/remote/device -> <repository>/contracts. A shallow /app path
    # does not have parents[3], so guard the optional repository layout.
    roots = [module_path.parent.parent / 'contracts/collaboration']
    if len(module_path.parents) > 3:
        roots.append(module_path.parents[3] / 'contracts/collaboration')
    return roots

def contract_validator():
    names = ('v1.schema.json', 'v2.schema.json')
    roots = contract_directories(Path(__file__).resolve())
    root = next((candidate for candidate in roots
                 if all((candidate / name).is_file() for name in names)), None)
    if root is None:
        raise FileNotFoundError('Both collaboration schema files are required; checked: '
                                + ', '.join(str(candidate) for candidate in roots))
    schemas = [json.loads((root / name).read_text(encoding='utf-8')) for name in names]
    registry = Registry()
    for schema in schemas: registry = registry.with_resource(schema['$id'], Resource.from_contents(schema))
    return Draft202012Validator(schemas[1], registry=registry)

VALIDATOR = contract_validator()
def check(command):
    if not isinstance(command, dict) or command.get('protocol') != 2: raise HTTPException(426, 'Collaboration protocol 2 required')
    pending=[(command,0)];count=0
    while pending:
        value,depth=pending.pop();count+=1
        if depth>24 or count>20000: raise HTTPException(400,'JSON complexity limit exceeded')
        if isinstance(value,dict): pending.extend((v,depth+1) for v in value.values())
        elif isinstance(value,list): pending.extend((v,depth+1) for v in value)
    try:size=len(json.dumps(command,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode('utf-8'))
    except (ValueError,UnicodeEncodeError):raise HTTPException(400,'Invalid JSON value')
    if size > 64000 or not VALIDATOR.is_valid(command):
        raise HTTPException(400, 'Invalid collaboration command')
    if command['action'] in ('device.register','device.update'):
        agents=command['payload']['config']['agents']
        if len({a['agentId'] for a in agents})!=len(agents): fail('Duplicate Agent identity',400)
    if command['action']=='binding.report':
        report=command['payload']
        if report['state']=='ready' and (report['bindingRevision']<1 or 'reasonCode' in report):fail('Invalid ready binding',400)
        if report['state']!='ready' and 'reasonCode' not in report:fail('Missing binding reason',400)
    if command['action']=='project.create':
        repository=command['payload']['config'].get('repository')
        if repository and repository['canonicalUrl'].endswith('.git'):fail('Noncanonical repository identity',400)

def encode(value): return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)
SEMANTIC_ERRORS={
 'Plan changed; review the current plan and retain your edits':'PLAN_VERSION_CONFLICT',
 'Plan decision changed; late Host proposal was not applied':'PLAN_APPROVAL_CONFLICT',
 'Plan version protection requires Station collaboration.4 or later':'PLAN_PROTOCOL_REQUIRED',
 'Keep dispatched work in the plan and approval history':'DISPATCHED_TASK_OMITTED',
 'Request identity reused with different content':'REQUEST_ID_CONTENT_CONFLICT',
}
def fail(detail, status=409, code=None):
    code=code or SEMANTIC_ERRORS.get(detail) or ('FORBIDDEN' if status==403 else 'PROTOCOL_INCOMPATIBLE' if status==426 else None)
    if not code and status==409 and ('dispatched' in detail.lower() or 'immutable' in detail.lower()):code='DISPATCHED_TASK_IMMUTABLE'
    raise HTTPException(status, {'code':code,'message':detail} if code else detail)

def delivery_hash(task):
    return hashlib.sha256(json.dumps({'meetingId':task['meetingId'],'taskId':task['id'],'attemptId':task['attemptId'],'delivery':task.get('delivery')},ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode('utf-8')).hexdigest()

class CollaborationStore:
    def __init__(self, hub, connection_liveness=None): self.hub = hub; self.connection_liveness=connection_liveness

    def plan_basis(self, meeting, payload, proposal=False):
        if 'expectedPlanVersion' in payload:
            if payload['expectedPlanVersion']!=meeting.get('planVersion',0):fail('Plan changed; review the current plan and retain your edits')
            if proposal and payload.get('expectedPlanDecisionVersion')!=meeting.get('planDecisionVersion',0):fail('Plan decision changed; late Host proposal was not applied')
            meeting['planProtocol']='stability-v1'
        elif meeting.get('planProtocol')=='stability-v1' or meeting.get('hostAuthority')=='original-orchestrator':fail('Plan version protection requires Station collaboration.4 or later',426)
        elif 'expectedRevision' in payload and payload['expectedRevision']!=meeting['revision']:fail('Plan changed; review the current version')

    def write_plan(self, meeting, tasks, brief, approved, decision=False):
        # Only plan content/arrangements change this version. Heartbeats, names,
        # progress and meeting policy never do. Approval has a separate Host fence.
        changed=encode([meeting.get('plan',[]),meeting.get('planBrief')])!=encode([tasks,brief])
        # Repeating an identical Host proposal is not a new arrangement and
        # must not withdraw the approval already granted to that arrangement.
        if not decision and not changed:approved=bool(approved or meeting.get('planApproved'))
        meeting['planVersion']=meeting.get('planVersion',0)+int(changed)
        meeting['planDecisionVersion']=meeting.get('planDecisionVersion',0)+int(decision or meeting.get('planApproved')!=approved)
        meeting.update(plan=tasks,planApproved=approved)
        if brief is not None:meeting['planBrief']=brief

    def protect_receipt(self,result):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        nonce=os.urandom(12);key=hashlib.sha256(b'station-registration-receipt\0'+self.hub.secret).digest()
        return {'sealed':base64.urlsafe_b64encode(nonce+AESGCM(key).encrypt(nonce,encode(result).encode(),b'collaboration-v2')).decode()}

    def open_receipt(self,result):
        if 'sealed' not in result:return result
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        data=base64.urlsafe_b64decode(result['sealed']);key=hashlib.sha256(b'station-registration-receipt\0'+self.hub.secret).digest()
        return json.loads(AESGCM(key).decrypt(data[:12],data[12:],b'collaboration-v2'))

    @contextmanager
    def transaction(self, owner):
        from hub_store import users
        with (self.hub.collaboration_lock if self.hub.engine.dialect.name=='sqlite' else nullcontext()), self.hub.engine.begin() as c:
            if not c.execute(select(users.c.id).where(users.c.id == owner).with_for_update()).scalar(): fail('Account unavailable', 401)
            if c.execute(select(accounts.c.owner).where(accounts.c.owner == owner)).scalar() is None:
                c.execute(accounts.insert().values(owner=owner, cursor=0))
            yield c

    def get(self, c, owner, kind, identity, required=True):
        row = c.execute(select(entities.c.data).where(entities.c.owner == owner, entities.c.kind == kind, entities.c.id == identity)).scalar()
        if row is None:
            if required: fail('Entity not found', 404)
            return None
        return json.loads(row)

    def rows(self, c, owner, kind):
        return [json.loads(row) for row in c.execute(select(entities.c.data).where(entities.c.owner == owner, entities.c.kind == kind)).scalars()]

    def put(self, c, owner, kind, identity, data):
        old = self.get(c, owner, kind, identity, False)
        value = {**data, 'id': identity, 'revision': (old or {}).get('revision', 0) + 1}
        where = (entities.c.owner == owner) & (entities.c.kind == kind) & (entities.c.id == identity)
        if old: c.execute(update(entities).where(where).values(revision=value['revision'], data=encode(value)))
        else: c.execute(entities.insert().values(owner=owner, kind=kind, id=identity, revision=value['revision'], data=encode(value)))
        seq = c.execute(select(accounts.c.cursor).where(accounts.c.owner == owner)).scalar() + 1
        c.execute(update(accounts).where(accounts.c.owner == owner).values(cursor=seq))
        event = {'protocol': 2, 'seq': seq, 'eventId': str(uuid.uuid4()), 'kind': kind, 'id': identity,
                 'revision': value['revision'], 'occurredAt': int(time.time()*1000), 'value': value}
        c.execute(events.insert().values(owner=owner, seq=seq, data=encode(event)))
        if kind in ('task','message') and value.get('targetDeviceId'):
            device=self.get(c,owner,'device',value['targetDeviceId'],False)
            if device:
                occupied=sum(t['targetDeviceId']==device['id'] and t['status'] in ('running','approval','stop-unconfirmed','reconcile') and not t.get('exitConfirmed') for t in self.rows(c,owner,'task'))
                occupied+=sum(m.get('targetDeviceId')==device['id'] and m.get('executionStatus') in ('running','reconcile') and not m.get('exitConfirmed') for m in self.rows(c,owner,'message'))
                if occupied!=device.get('activeTasks',0): self.put(c,owner,'device',device['id'],{**device,'activeTasks':occupied})
                if device.get('revoked') and device.get('draining'):
                    pending=[t for t in self.rows(c,owner,'task') if t['targetDeviceId']==device['id'] and not t.get('exitConfirmed') and t['status'] not in ('stopped','delivered','accepted')]
                    pending.extend(m for m in self.rows(c,owner,'message') if m.get('targetDeviceId')==device['id'] and m.get('executionStatus') and not m.get('exitConfirmed'))
                    if not pending:self.finish_revoke(c,owner,device)
        return value

    def snapshot(self, owner):
        with self.transaction(owner) as c:
            cursor = c.execute(select(accounts.c.cursor).where(accounts.c.owner == owner)).scalar()
            result = {'protocol': 2, 'cursor': cursor, 'entities': {}, 'capabilities':['unified-meeting-v1','unified-review-fixes-v1','unified-stability-v1','unified-hardening-v1','text-artifacts-v1','delivery-review-v1','scope-revision-v1']}
            for kind in ('device','project','binding','meeting','message','task','approval','native','history','nativecontrol'):
                result['entities'][kind] = [] if kind=='history' else self.rows(c, owner, kind)
            return result

    def replay(self, owner, after):
        if after < 0: fail('Invalid cursor',400)
        with self.transaction(owner) as c:
            cursor = c.execute(select(accounts.c.cursor).where(accounts.c.owner == owner)).scalar()
            if after > cursor: fail('Snapshot required',410)
            rows = c.execute(select(events.c.data).where(events.c.owner == owner, events.c.seq > after).order_by(events.c.seq).limit(200)).scalars()
            page=[];size=0
            for row in rows:
                if page and size+len(row)>512*1024:break
                page.append(json.loads(row));size+=len(row)
            return {'protocol':2,'cursor':cursor,'events':page}

    def history(self,owner,device,session,after=0):
        if after<0:fail('Invalid history cursor',400)
        with self.transaction(owner) as c:
            self.get(c,owner,'native',device+':'+session)
            rows=[r for r in self.rows(c,owner,'history') if r['deviceId']==device and r['sessionId']==session and r['firstSeq']>after]
            rows.sort(key=lambda r:r['firstSeq']);page=[];size=0
            for row in rows[:40]:
                encoded=encode(row)
                if page and size+len(encoded)>48000:break
                page.append(row);size+=len(encoded)
            return {'messages':page,'cursor':page[-1]['firstSeq'] if page else after,'hasMore':len(rows)>len(page)}

    def connection(self, owner, device, online, generation=None):
        with self.transaction(owner) as c:
            row = self.get(c, owner, 'device', device)
            if generation is not None and generation != row.get('connectionGeneration',0): return row
            row.update(online=online,lastSeenAt=int(time.time()*1000))
            if online: row['connectionGeneration'] = row.get('connectionGeneration',0)+1
            return self.put(c,owner,'device',device,row)

    def heartbeat(self, owner, device, generation):
        with self.transaction(owner) as c:
            row = self.get(c,owner,'device',device)
            if not row.get('online') or row.get('connectionGeneration') != generation: fail('Connection superseded')
            # Durable lease makes coordinator gating fail closed across process restarts.
            row['lastSeenAt']=int(time.time()*1000)
            return self.put(c,owner,'device',device,row)

    def online(self,c,owner,device):
        row=self.get(c,owner,'device',device,False)
        return bool(row and not row.get('revoked') and row.get('online') and time.time()*1000-row.get('lastSeenAt',0)<45000 and
            (self.connection_liveness is None or self.connection_liveness(owner,device)))

    def finish_revoke(self,c,owner,device):
        from hub_store import credentials,devices
        c.execute(update(credentials).where(credentials.c.owner==owner,credentials.c.device==device['id']).values(revoked=1))
        c.execute(update(devices).where(devices.c.owner==owner,devices.c.id==device['id']).values(revoked=1))
        self.put(c,owner,'device',device['id'],{**device,'draining':False})

    def message_receipt(self, principal, identity):
        # Read only: old idempotent successes remain usable without rebuilding
        # a command, refreshing permissions, or disclosing registration tokens.
        with self.transaction(principal['owner']) as c:
            row=c.execute(select(requests.c.result).where(requests.c.owner==principal['owner'],requests.c.id==identity)).mappings().first()
            value=json.loads(row['result']).get('value',{}) if row else {}
            if not isinstance(value,dict) or value.get('sourceDeviceId')!=principal.get('device') or value.get('route') not in ('host','agent','native','task'):
                return {'protocol':2,'requestId':identity,'found':False}
            return {'protocol':2,'requestId':identity,'found':True,'value':value}

    @staticmethod
    def verified_delivery(task):
        if not task:
            return False
        delivery = task.get('delivery') or {}
        binding = task.get('verificationBinding') or {}
        report = delivery.get('report') or {}
        completed = task.get('turnOutcome') == 'completed' or 'turnOutcome' not in task and not task.get('stopRequested')
        return bool(task.get('integration') == 'verified' and task['status'] in ('delivered', 'accepted')
            and task.get('exitConfirmed') is True and completed
            and task.get('scopeVersion', 0) == delivery.get('scopeVersion', 0)
            and report.get('taskId') == task['id'] and report.get('attemptId') == task['attemptId']
            and report.get('exitConfirmed') is True and binding.get('reviewed') is True
            and binding.get('attemptId') == task['attemptId'] and binding.get('deliveryHash') == delivery_hash(task))

    def verified_delivery_tree(self, c, owner, task):
        pending, seen = [task], set()
        while pending:
            current = pending.pop()
            if not self.verified_delivery(current) or current['meetingId'] != task['meetingId']:
                return False
            if current['id'] in seen:
                continue
            seen.add(current['id'])
            pending.extend(self.get(c, owner, 'task', dep, False) for dep in current.get('dependencies', []))
        return True

    def command(self, principal, command):
        check(command)
        owner, device = principal['owner'], principal.get('device')
        action, p, request = command['action'], command['payload'], command['requestId']
        digest=hashlib.sha256(encode([device,command]).encode()).hexdigest()
        with self.transaction(owner) as c:
            saved=c.execute(select(requests).where(requests.c.owner==owner,requests.c.id==request)).mappings().first()
            if saved:
                if saved['digest']!=digest: fail('Request identity reused with different content')
                return self.open_receipt(json.loads(saved['result']))
            if action=='device.register':
                if principal['scope']!='control': fail('Account login required',403)
                value=self.register(c,owner,p)
            else:
                if principal['scope']!='station' or not device: fail('Station credential required',403)
                local=self.get(c,owner,'device',device)
                cleanup=(action=='task.event' and p.get('status') in ('stopped','stop-unconfirmed','reconcile')) or action=='message.event' and (p.get('status') in ('stopped','reconcile') or p.get('status')=='failed' and p.get('exitConfirmed') is True)
                if local.get('revoked') and not cleanup: fail('Device revoked; only execution cleanup is allowed',403)
                try:
                    value=self.apply(c,owner,device,action,{**p,'submissionId':request} if action=='message.send' else p)
                except HTTPException as error:
                    # Receipt lookup above already ruled out an earlier success.
                    # The enclosing transaction rolls back every proposal change.
                    if action == 'plan.propose' and error.status_code in (400, 403, 409):
                        detail = error.detail if isinstance(error.detail, dict) else {'message': error.detail}
                        error.detail = {**detail, 'requestId': request, 'applied': False}
                    raise
            result={'protocol':2,'ok':True,'value':value}
            c.execute(requests.insert().values(owner=owner,id=request,digest=digest,result=encode(self.protect_receipt(result) if action=='device.register' else result)))
            return result

    def register(self,c,owner,p):
        from hub_store import devices,credentials
        identity=p['deviceId']
        physical=c.execute(select(devices).where(devices.c.id==identity).with_for_update()).mappings().first()
        if physical and physical['owner']!=owner: fail('Device belongs to another account',403)
        old=self.get(c,owner,'device',identity,False)
        if old and old.get('revoked'):
            if old.get('draining') or not p.get('reactivate'):fail('Finish execution cleanup and explicitly authorize local reactivation')
            c.execute(update(devices).where(devices.c.id==identity).values(revoked=0))
            old=self.put(c,owner,'device',identity,{**old,**p['config'],'revoked':False,'online':False,'acceptingTasks':False})
            for binding in self.rows(c,owner,'binding'):
                if binding['deviceId']==identity:self.put(c,owner,'binding',binding['id'],{**binding,'state':'unbound','reasonCode':'REVOKED'})
        if not physical: c.execute(devices.insert().values(id=identity,owner=owner,name=p['config']['name'],revoked=0,created=time.time()))
        if not old:
            old=self.put(c,owner,'device',identity,{**p['config'],'online':False,'lastSeenAt':0,'connectionGeneration':0,'activeTasks':0,'revoked':False})
        c.execute(update(credentials).where(credentials.c.owner==owner,credentials.c.device==identity,credentials.c.scope=='station').values(revoked=1))
        return {'device':old,'deviceToken':self.hub.issue(c,owner,'station',identity)}

    def meeting(self,c,owner,p): return self.get(c,owner,'meeting',p['meetingId'])
    def coordinator(self,c,owner,device,meeting):
        if meeting['coordinatorDeviceId']!=device: fail('Only the original coordinating device may dispatch',403)
        if not self.online(c,owner,device): fail('Coordinator is offline; saved input waits')

    def apply(self,c,owner,device,action,p):
        if action=='device.update':
            old=self.get(c,owner,'device',device)
            if old['revision']!=p['expectedRevision']: fail('Device revision conflict')
            return self.put(c,owner,'device',device,{**old,**p['config']})
        if action=='device.revoke':
            from hub_store import devices
            old=self.get(c,owner,'device',p['deviceId'])
            old.update(revoked=True,acceptingTasks=False,draining=True)
            c.execute(update(devices).where(devices.c.owner==owner,devices.c.id==old['id']).values(revoked=2))
            self.put(c,owner,'device',old['id'],old)
            pending=False
            for task in self.rows(c,owner,'task'):
                if task['targetDeviceId']==old['id'] and not task.get('exitConfirmed') and task['status'] not in ('stopped','delivered','accepted'):
                    pending=True
                    self.put(c,owner,'task',task['id'],{**task,'stopRequested':True,'continueAllowed':False})
            for message in self.rows(c,owner,'message'):
                if message.get('targetDeviceId')==old['id'] and message.get('executionStatus') and not message.get('exitConfirmed'):
                    pending=True;self.put(c,owner,'message',message['id'],{**message,'stopRequested':True})
            if not pending:self.finish_revoke(c,owner,old)
            return self.get(c,owner,'device',old['id'])
        if action=='project.create':
            return self.put(c,owner,'project',str(uuid.uuid4()),p['config'])
        if action=='binding.report':
            if p['deviceId']!=device: fail('Binding belongs to another device',403)
            self.get(c,owner,'project',p['projectId'])
            identity=p['projectId']+':'+device
            old=self.get(c,owner,'binding',identity,False)
            if old and p['bindingRevision']<=old['bindingRevision']:
                if all(old.get(k)==v for k,v in p.items()): return old
                fail('Stale local authorization')
            project=self.get(c,owner,'project',p['projectId']);repository=project.get('repository',{}).get('canonicalUrl')
            if p['state']!='ready':
                for task in self.rows(c,owner,'task'):
                    if task['targetDeviceId']==device and (task.get('projectId')==p['projectId'] or repository and any(ref['repository']==repository for ref in task.get('inputs',[]))):
                        self.put(c,owner,'task',task['id'],{**task,'stopRequested':True,'continueAllowed':False})
                for message in self.rows(c,owner,'message'):
                    if message.get('targetDeviceId')==device and message.get('nativeSessionId') and not message.get('exitConfirmed'):
                        native=self.get(c,owner,'native',device+':'+message['nativeSessionId'],False)
                        if native and native['projectId']==p['projectId']:self.put(c,owner,'message',message['id'],{**message,'stopRequested':True})
            else:
                for task in self.rows(c,owner,'task'):
                    if task['targetDeviceId']==device and task.get('continueAllowed') is False and (task.get('projectId')==p['projectId'] or repository and any(ref['repository']==repository for ref in task.get('inputs',[]))):
                        self.put(c,owner,'task',task['id'],{**task,'continueAllowed':True})
            return self.put(c,owner,'binding',identity,p)
        if action=='meeting.create':
            for member in p['members']: self.get(c,owner,'device',member)
            for member in p.get('participants',[]): self.get(c,owner,'device',member['deviceId'])
            if p.get('mainProjectId'): self.get(c,owner,'project',p['mainProjectId'])
            return self.put(c,owner,'meeting',str(uuid.uuid4()),{**p,'coordinatorDeviceId':device,'planApproved':False,'plan':[],'accepted':False})
        if action=='meeting.request':
            meeting=self.meeting(c,owner,p)
            if p.get('changes',{}).get('meetingId',meeting['id'])!=meeting['id']:fail('Request belongs to another meeting',400)
            return self.put(c,owner,'message',str(uuid.uuid4()),{'meetingId':meeting['id'],'text':'会议设置请求' if p['operation']=='configure' else '停止 Host 当前回复','route':'control','request':p,'sourceDeviceId':device,'targetDeviceId':meeting['coordinatorDeviceId'],'createdAt':int(time.time()*1000)})
        if action=='meeting.migrate':
            meeting=self.meeting(c,owner,p);self.coordinator(c,owner,device,meeting)
            if meeting['revision']!=p['expectedRevision']:fail('Meeting changed during migration')
            if any(t['meetingId']==meeting['id'] and t['status'] not in ('stopped','delivered','accepted') for t in self.rows(c,owner,'task')):fail('Keep the existing Host until in-flight work is reconciled')
            if any(n.get('meetingId')==meeting['id'] and n['status']!='idle' for n in self.rows(c,owner,'native')):fail('Native continuation must be idle before migration')
            meeting.update(previousHostAuthority=meeting.get('hostAuthority','legacy-shared'),hostAuthority='original-orchestrator')
            return self.put(c,owner,'meeting',meeting['id'],meeting)
        if action=='plan.review':
            meeting=self.meeting(c,owner,p)
            self.coordinator(c,owner,device,meeting)
            self.plan_basis(meeting,p)
            self.validate_plan(c,owner,meeting,p['tasks'])
            if any(t['meetingId']!=meeting['id'] for t in p['tasks']):fail('Foreign plan task',400)
            old_project=meeting.get('mainCodeProjectId') or meeting.get('mainProjectId')
            if old_project and any(t.get('projectId',old_project)!=old_project and t['resource'] in ('repository','directory') for t in p['tasks']):fail('Use a separate meeting for another main project')
            for task in p['tasks']:
                if task['targetDeviceId'] not in meeting['members']:fail('Select an execution member first')
                if meeting.get('participants') is not None and not any(m['deviceId']==task['targetDeviceId'] and m['agentId']==task['agentId'] and m.get('executionCandidate',True) for m in meeting['participants']):fail('Agent is not selected for execution')
            self.write_plan(meeting,p['tasks'],p.get('brief',meeting.get('planBrief')),p['approved'],decision=True)
            return self.put(c,owner,'meeting',meeting['id'],meeting)
        if action=='meeting.result':
            meeting=self.meeting(c,owner,p);self.coordinator(c,owner,device,meeting)
            if p['commit']!=meeting.get('verifiedCommit'):fail('Final result must reference the verified meeting commit')
            repository_tasks = (t for t in self.rows(c,owner,'task')
                                if t['meetingId'] == meeting['id'] and t['resource'] == 'repository')
            if any(not self.verified_delivery_tree(c,owner,t) for t in repository_tasks):
                fail('Current repository deliveries and predecessors must be verified before recording the final result')
            return self.put(c,owner,'meeting',meeting['id'],{**meeting,'finalPrUrl':p['prUrl'],'finalCommit':p['commit']})
        if action in ('meeting.update','plan.propose','plan.decide'):
            meeting=self.meeting(c,owner,p)
            self.coordinator(c,owner,device,meeting)
            if action!='meeting.update':self.plan_basis(meeting,p,proposal=action=='plan.propose')
            elif meeting['revision']!=p['expectedRevision']: fail('Meeting revision conflict')
            if action=='meeting.update':
                for member in p['members']:self.get(c,owner,'device',member)
                meeting.update({k:p[k] for k in ('members','autoApprovePlan','autoAssign')})
                if 'participants' in p:
                    meeting['participants']=list({(m['deviceId'],m['agentId']):m for m in p['participants']}.values())
                if 'mainProjectId' in p:
                    if meeting.get('mainProjectId') not in (None,p['mainProjectId']):fail('Open another project in its own meeting')
                    self.get(c,owner,'project',p['mainProjectId']);meeting['mainProjectId']=p['mainProjectId']
                if 'hostAuthority' in p:fail('Host authority requires a verified migration')
            elif action=='plan.propose':
                self.validate_plan(c,owner,meeting,p['tasks'])
                if any(t['meetingId']!=meeting['id'] for t in p['tasks']):fail('Plan task belongs to another meeting',400)
                code={t['projectId'] for t in p['tasks'] if t['resource']=='repository'}
                if len(code)>1 or code and meeting.get('mainCodeProjectId') not in (None,next(iter(code))):fail('First release supports one main code project per meeting')
                if code:meeting['mainCodeProjectId']=next(iter(code))
                if meeting.get('mainProjectId') and any(t.get('projectId',meeting['mainProjectId'])!=meeting['mainProjectId'] and t['resource'] in ('repository','directory') for t in p['tasks']):fail('Use another meeting for another main project')
                self.write_plan(meeting,p['tasks'],p.get('brief',meeting.get('planBrief')),meeting['autoApprovePlan'])
            else:self.write_plan(meeting,meeting['plan'],meeting.get('planBrief'),p['approved'],decision=True)
            return self.put(c,owner,'meeting',meeting['id'],meeting)
        if action=='message.retry':
            original=self.get(c,owner,'message',p['messageId']);self.meeting(c,owner,{'meetingId':original['meetingId']})
            if original.get('route') not in ('host','agent') or original.get('replyTo') or original.get('executionStatus')!='failed' or original.get('notStarted') is not True or not original.get('exitConfirmed'):
                fail('Only a confirmed unstarted Host or expert input can be retried; reconcile actual execution first')
            prior=next((m for m in self.rows(c,owner,'message') if m.get('retryOf')==original['id']),None)
            if prior:return prior
            return self.apply(c,owner,device,'message.send',{**{k:original[k] for k in ('meetingId','text','attachments','targetDeviceId','targetAgentId','consultation') if k in original},'retryOf':original['id']})
        if action=='message.send':
            meeting=self.meeting(c,owner,p)
            if sum(bool(p.get(k)) for k in ('nativeSessionId','targetAgentId','taskId'))>1:fail('Choose one explicit message route',400)
            route='native' if p.get('nativeSessionId') else 'agent' if p.get('targetAgentId') else 'task' if p.get('taskId') else 'host'
            if p.get('consultation') and (device!=meeting['coordinatorDeviceId'] or route!='agent') and not p.get('retryOf'):fail('Only Host can initiate a consultation',403)
            if p.get('consultationId'):
                original=self.get(c,owner,'message',p['consultationId'])
                if not original.get('consultation') or original.get('targetDeviceId')!=device or original['meetingId']!=meeting['id'] or route!='host':fail('Foreign consultation result',403)
            if p.get('replyTo'):
                original=self.get(c,owner,'message',p['replyTo'])
                if original['meetingId']!=meeting['id']:fail('Foreign reply',403)
                expected=original.get('targetDeviceId') if original['route'] in ('agent','native') else meeting['coordinatorDeviceId']
                if device!=expected:fail('Only the addressed device can reply',403)
            elif route=='agent':
                member={'deviceId':p.get('targetDeviceId'),'agentId':p['targetAgentId']}
                if not any(m['deviceId']==member['deviceId'] and m['agentId']==member['agentId'] for m in meeting.get('participants',[{'deviceId':m,'agentId':'codex'} for m in meeting['members']])):fail('Select this discussion member first')
                if p['targetAgentId'] not in ('codex','file-test'):fail('Agent has no shared discussion adapter',422)
                target=self.get(c,owner,'device',p['targetDeviceId'])
                if target.get('revoked') or not self.online(c,owner,target['id']):fail('Selected discussion member is offline or revoked; select an available member before sending')
            elif route=='task':
                task=self.get(c,owner,'task',p['taskId'])
                if task['meetingId']!=meeting['id']:fail('Task belongs to another meeting',400)
                self.control(c,owner,device,task,{'operation':'supplement','text':p['text'],'inputs':p.get('attachments',[])})
            if p.get('nativeSessionId'):
                native=self.get(c,owner,'native',p.get('targetDeviceId','')+':'+p['nativeSessionId'])
                if native.get('meetingId')!=meeting['id']: fail('Select this native conversation into the meeting first')
                if native.get('status')=='unavailable':fail('Native conversation is outside the current local authorization')
                if self.get(c,owner,'binding',native['projectId']+':'+p['targetDeviceId'])['state']!='ready':fail('Native project authorization has changed')
                target=self.get(c,owner,'device',p['targetDeviceId'])
                if not p.get('replyTo') and (target.get('revoked') or not target['acceptingTasks'] or not self.online(c,owner,target['id'])):fail('Selected device is offline or not accepting new continuation work')
            return self.put(c,owner,'message',str(uuid.uuid4()),{**p,'sourceDeviceId':device,'route':route,'createdAt':int(time.time()*1000)})
        if action=='message.stop':
            message=self.get(c,owner,'message',p['messageId'])
            if message.get('route') not in ('native','agent') or message.get('replyTo'):fail('This input is not an active native continuation or expert discussion')
            return self.put(c,owner,'message',message['id'],{**message,'stopRequested':True})
        if action in ('message.receipt','message.event'):
            message=self.get(c,owner,'message',p['messageId'])
            expected=message.get('targetDeviceId')
            if message.get('route')=='host':expected=self.get(c,owner,'meeting',message['meetingId'])['coordinatorDeviceId']
            if expected!=device or message.get('route') not in ('native','agent','control','host') or message.get('replyTo'):fail('Not this device input',403)
            if action=='message.receipt':
                if message.get('executionStatus'):return message
                meeting=self.get(c,owner,'meeting',message['meetingId'])
                if not self.online(c,owner,meeting['coordinatorDeviceId']):fail('Coordinator offline; continuation waits')
                return self.put(c,owner,'message',message['id'],{**message,'executionStatus':'received','bindingRevision':p['bindingRevision'],'receivedAt':int(time.time()*1000)})
            if message['route']=='native' and not message.get('executionStatus') and not (p['status']=='stopped' and p.get('exitConfirmed') is True):fail('Durable continuation receipt required')
            if message.get('executionStatus')=='failed':
                if p['status']!='failed':fail('Failed input is terminal; use an explicit retry')
                return message
            if p['status']=='failed' and (message['route'] not in ('host','agent') or p.get('exitConfirmed') is not True):fail('Failed input requires confirmed non-running execution')
            if message.get('executionStatus') in ('stopped','completed') and p['status'] not in ('stopped','completed'):fail('Obsolete native progress')
            outcome=p.get('turnOutcome');known=message.get('turnOutcome')
            if outcome and outcome!='unknown' and p.get('exitConfirmed') is not True:fail('Turn outcome requires actual exit evidence')
            if known in ('completed','interrupted','failed') and outcome and outcome!=known:fail('Conflicting original turn outcome')
            if message.get('executionStatus')=='completed' and p['status']=='stopped':return message
            if message.get('executionStatus')=='stopped' and p['status']!='stopped' and outcome!='completed':fail('Stopped native input cannot be completed by a late result')
            if p['status'] in ('stopped','completed') and p.get('exitConfirmed') is not True:fail('Continuation exit remains unconfirmed')
            return self.put(c,owner,'message',message['id'],{**message,'executionStatus':p['status'],**{k:v for k,v in p.items() if k not in ('messageId','status')}})
        if action=='task.create': return self.create_task(c,owner,device,p)
        if action.startswith('task.') or action.startswith('approval.'):
            if action=='approval.observed':
                approval=self.get(c,owner,'approval',p['approvalId']);task=self.approval_context(c,owner,approval)
                if task['targetDeviceId']!=device or approval.get('attemptId') and approval['attemptId']!=task['attemptId']:fail('Obsolete or foreign native approval',403)
                if approval.get('effectiveDecision') and approval['effectiveDecision']!=p['decision']:fail('Native approval already finalized')
                if approval.get('effectiveDecision')==p['decision']:return approval
                return self.put(c,owner,'approval',approval['id'],{**approval,'effectiveDecision':p['decision'],'executionStatus':'applied'})
            if action=='approval.decide':
                approval=self.get(c,owner,'approval',p['approvalId'])
                task=self.approval_context(c,owner,approval)
                if approval.get('decision') or approval.get('effectiveDecision') or approval.get('attemptId') and approval['attemptId']!=task['attemptId'] or task.get('stopRequested') or task.get('exitConfirmed'): fail('Approval expired or already decided')
                if not approval['supported']: fail('Use the native desktop interaction',422)
                return self.put(c,owner,'approval',approval['id'],{**approval,'decision':p['decision'],'decidedBy':device})
            if action=='approval.request':
                task=self.approval_context(c,owner,p)
                if task['targetDeviceId']!=device:fail('Only execution device can publish native approval',403)
                if p.get('attemptId') and p['attemptId']!=task['attemptId']:fail('Obsolete approval attempt')
                old=self.get(c,owner,'approval',p['approvalId'],False)
                if old:
                    if any(old.get(k)!=p.get(k) for k in ('taskId','attemptId','messageId')):fail('Approval identity reused')
                    return old
                return self.put(c,owner,'approval',p['approvalId'],{**p,'meetingId':task['meetingId']})
            task=self.get(c,owner,'task',p['taskId'])
            if p['attemptId']!=task['attemptId']: fail('Obsolete execution attempt')
            if action=='task.control': return self.control(c,owner,device,task,p)
            if task['targetDeviceId']!=device: fail('Only the execution device may acknowledge execution',403)
            if action=='task.receipt':
                if task['status']!='offered': return task
                if task.get('stopRequested'): fail('Task stopped before receipt')
                meeting=self.get(c,owner,'meeting',task['meetingId'])
                if not self.online(c,owner,meeting['coordinatorDeviceId']): fail('Coordinator offline; unreceived work waits')
                value=self.put(c,owner,'task',task['id'],{**task,'status':'received','bindingRevision':p['bindingRevision'],'receivedAt':int(time.time()*1000)})
                self.task_notice(c,owner,value,'received');return value
            if action=='task.event':
                if task['status']=='offered' and not (p['status']=='stopped' and p.get('exitConfirmed') is True): fail('Durable receipt required before execution')
                outcome=p.get('turnOutcome');known=task.get('turnOutcome')
                if outcome and outcome!='unknown' and p.get('exitConfirmed') is not True:fail('Turn outcome requires actual exit evidence')
                if known in ('completed','interrupted','failed') and outcome and outcome!=known:fail('Conflicting original turn outcome')
                if outcome=='completed' and p['status']=='stopped':fail('Normal turn cannot be reported as interrupted')
                if p['status']=='delivered' and p.get('delivery') and p['delivery'].get('scopeVersion',0)!=task.get('scopeVersion',0):
                    fail('Delivery belongs to a superseded scope',409,'SCOPE_DELIVERY_OUTDATED')
                protected_delivery = task.get('delivery') and (
                    task.get('verificationBinding') or task.get('integration') == 'verified'
                    or task['status'] == 'accepted')
                if p['status']=='delivered' and protected_delivery:
                    if delivery_hash({**task, 'delivery': p.get('delivery', task['delivery'])}) != delivery_hash(task):
                        fail('Reviewed delivery is immutable; use explicit scope revision and a new attempt', 409, 'VERIFIED_DELIVERY_IMMUTABLE')
                if task['status']=='accepted':return task
                if p['status']=='delivered' and p.get('exitConfirmed') is not True:
                    fail('Execution exit evidence required')
                if p['status']=='delivered' and task.get('delivery') and task['status']=='delivered' and delivery_hash({**task,'delivery':p.get('delivery',task['delivery'])})==delivery_hash(task):
                    return task
                if p['status']=='delivered' and (outcome or known)!='completed':
                    fail('Publication requires explicit normal turn completion evidence',409,'TURN_COMPLETION_UNCONFIRMED')
                if task['status']=='delivered' and p['status']!='delivered':return task
                if known=='completed' and p['status'] in ('stopped','stop-unconfirmed','reconcile'):return task
                if task['status']=='stopped' and p['status']!='stopped' and outcome!='completed':fail('Execution already ended')
                if task['status'] in ('executed','delivery-pending','delivered') and p['status'] in ('running','waiting-slot','waiting-desktop','approval'): fail('Late progress cannot overwrite completed execution')
                if task['status']=='delivered' and p['status'] in ('executed','delivery-pending'):return task
                if task.get('nativeTurnId') and p.get('nativeTurnId') not in (None,task['nativeTurnId']):fail('Native turn changed within an execution attempt')
                if p['status']=='stopped' and p.get('exitConfirmed') is not True: fail('Actual exit evidence required')
                if p['status'] in ('executed','delivery-pending','delivered') and p.get('exitConfirmed') is not True: fail('Execution exit evidence required')
                if task.get('stopRequested') and p['status'] in ('running','approval'): fail('Task has a pending stop')
                if p['status']=='delivered' and protected_delivery:return task
                if p['status']=='delivered' and task['resource']=='text':TextArtifacts(self).require_complete(c,owner,task,(p.get('delivery') or {}).get('textArtifact'))
                history=task.get('output',[])
                if p.get('output'): history=(history+[p['output'][-4000:]])[-16:]
                if p.get('nativeTurnId'):
                    for followup in task['pendingFollowups']:
                        if followup.get('includedInAttempt')==task['attemptId']:followup['delivered']=True
                if p.get('delivery') is not None and task.get('delivery') and task['delivery'] != p['delivery']:
                    task.pop('verificationBinding', None)
                    task.pop('review', None)
                    task['integration'] = 'revalidation-required'
                value=self.put(c,owner,'task',task['id'],{**task,**p,'output':history})
                self.task_notice(c,owner,value,p['status']);return value
        if action=='native.catalog':
            result=[]
            present={r['sessionId'] for r in p['sessions']}
            if p.get('complete') is False and not p.get('catalogId'):fail('Paged catalogue identity required',400)
            for old in self.rows(c,owner,'native') if p.get('complete',True) else []:
                absent=old.get('catalogId')!=p['catalogId'] and old['sessionId'] not in present if p.get('catalogId') else old['sessionId'] not in present
                if old['deviceId']==device and absent and old.get('status')!='unavailable':
                    result.append(self.put(c,owner,'native',old['id'],{**old,'status':'unavailable','reason':'不在当前已授权目录内或本机对话不可用'}))
            for row in p['sessions']:
                binding=self.get(c,owner,'binding',row['projectId']+':'+device,False)
                if not binding or binding['state']!='ready':row={**row,'status':'unavailable','reason':'本机项目授权已撤销或未就绪'}
                identity=device+':'+row['sessionId']; old=self.get(c,owner,'native',identity,False) or {}
                if 'nativeTurnId' not in row:old.pop('nativeTurnId',None)
                result.append(self.put(c,owner,'native',identity,{**old,**row,'deviceId':device,**({'catalogId':p['catalogId']} if p.get('catalogId') else {})}))
            return result
        if action=='native.bind':
            meeting=self.meeting(c,owner,p)
            identity=p['deviceId']+':'+p['sessionId']; native=self.get(c,owner,'native',identity)
            if p['operation']=='bind':
                if native.get('status')=='unavailable':fail('Native conversation is outside current local authorization')
                if native.get('meetingId') and native['meetingId']!=meeting['id']: fail('Conversation already belongs to another meeting')
                native['meetingId']=meeting['id']
            else:
                if native.get('meetingId')!=meeting['id']: fail('Conversation is associated elsewhere')
                if native['status']!='idle': fail('Stop and reconcile the exact native turn before changing association')
                for task in self.rows(c,owner,'task'):
                    if task.get('nativeSessionId')==p['sessionId'] and task['targetDeviceId']==p['deviceId'] and task['status'] not in ('stopped','delivered','accepted'): fail('Associated work has not exited')
                for message in self.rows(c,owner,'message'):
                    if message.get('nativeSessionId')==p['sessionId'] and message.get('targetDeviceId')==p['deviceId'] and not message.get('replyTo') and not message.get('exitConfirmed'):fail('Stop and reconcile the queued native continuation before changing association')
                native.pop('meetingId',None)
            return self.put(c,owner,'native',identity,native)
        if action=='native.stop':
            native=self.get(c,owner,'native',p['deviceId']+':'+p['sessionId'])
            if native.get('meetingId')!=p['meetingId']:fail('Conversation is not selected in this meeting')
            return self.put(c,owner,'nativecontrol',str(uuid.uuid4()),{**p,'status':'requested'})
        if action=='native.stop-result':
            control=self.get(c,owner,'nativecontrol',p['controlId'])
            if control['deviceId']!=device:fail('Only the native execution device may confirm exit',403)
            return self.put(c,owner,'nativecontrol',control['id'],{**control,'status':'stopped' if p['exitConfirmed'] else 'unconfirmed'})
        if action=='native.history':
            identity=device+':'+p['sessionId']; native=self.get(c,owner,'native',identity)
            if not native.get('meetingId'): fail('Only selected conversation content may be synchronized',403)
            values=[]
            for message in p['messages']:
                key=hashlib.sha256(encode([device,p['sessionId'],message['id']]).encode()).hexdigest()
                old=self.get(c,owner,'history',key,False)
                if old and old['nativeMessageId']==message['id'] and all(old.get(k)==v for k,v in message.items() if k!='id'):continue
                seq=(old or {}).get('firstSeq') or c.execute(select(accounts.c.cursor).where(accounts.c.owner==owner)).scalar()+1
                values.append(self.put(c,owner,'history',key,{**message,'nativeMessageId':message['id'],'deviceId':device,'sessionId':p['sessionId'],'meetingId':native['meetingId'],'firstSeq':seq}))
            return {'stored':len(values)}
        fail('Unsupported command',400)

    def approval_context(self,c,owner,value):
        if value.get('messageId'):
            message=self.get(c,owner,'message',value['messageId'])
            if message.get('route')!='native' or not message.get('receivedAt'):fail('Acknowledged native continuation required')
            return message
        return self.get(c,owner,'task',value['taskId'])

    def check_inputs(self,c,owner,device,references):
        for ref in references:
            project=next((pr for pr in self.rows(c,owner,'project') if pr.get('repository',{}).get('canonicalUrl')==ref['repository']),None)
            if not project or (self.get(c,owner,'binding',project['id']+':'+device,False) or {}).get('state')!='ready':fail('Input materials repository is not authorized on this execution device')

    def task_notice(self,c,owner,task,status):
        labels={'received':'设备已接收','running':'正在执行','waiting-slot':'等待原设备名额','waiting-desktop':'等待桌面轮次结束','stopped':'已确认停止，等待明确继续','stop-unconfirmed':'停止待确认','delivered':'成果可获取，等待检查'}
        meeting=self.get(c,owner,'meeting',task['meetingId'])
        if meeting.get('hostAuthority')!='original-orchestrator' or status not in labels:return
        identity='notice:'+hashlib.sha256(encode([task['id'],task['attemptId'],status]).encode()).hexdigest()
        if self.get(c,owner,'message',identity,False):return
        device=self.get(c,owner,'device',task['targetDeviceId'])
        text=device['name']+' · '+task['agentId']+'：'+task['title']+' — '+labels[status]
        if status=='delivered':text+='\n'+str(task.get('delivery',{}).get('summary',''))[:1600]
        self.put(c,owner,'message',identity,{'meetingId':meeting['id'],'taskId':task['id'],'attemptId':task['attemptId'],'route':'notice','text':text,'sourceDeviceId':task['targetDeviceId'],'createdAt':int(time.time()*1000)})

    def validate_plan(self,c,owner,meeting,tasks):
        identities=[t['planTaskId'] for t in tasks if t.get('planTaskId')]
        if len(identities)!=len(set(identities)):fail('Duplicate plan task identity',400)
        graph={t['planTaskId']:t['dependencies'] for t in tasks if t.get('planTaskId')}
        existing={t['id']:t for t in self.rows(c,owner,'task') if t['meetingId']==meeting['id']}
        old_plan=meeting.get('plan',[])
        for old in old_plan:
            dispatched=next((t for t in existing.values() if old.get('planTaskId') and old.get('planTaskId')==t.get('planTaskId')),None)
            if dispatched and not any(t.get('planTaskId')==old['planTaskId'] for t in tasks):fail('Keep dispatched work in the plan and approval history')
        for task in tasks:
            if task['meetingId']!=meeting['id']:fail('Foreign plan task',400)
            prior=next((old for old in existing.values() if task.get('planTaskId') and old.get('planTaskId')==task['planTaskId']),None)
            approved=next((t for t in old_plan if task.get('planTaskId') and t.get('planTaskId')==task['planTaskId']),prior)
            if prior and any(approved.get(k)!=task.get(k) for k in ('title','objective','targetDeviceId','agentId','resource','projectId','nativeSessionId','permission','baseCommit','acceptanceCriteria','inputs','dependencies','parentTaskId')):
                fail('Dispatched work keeps its approved identity; use an explicit task supplement or a linked follow-up')
            if task.get('projectId'):self.get(c,owner,'project',task['projectId'])
            for dep in task['dependencies']:
                if dep not in graph and dep not in existing:fail('Unknown or foreign task dependency',400)
            before=next((t for t in old_plan if task.get('planTaskId') and t.get('planTaskId')==task['planTaskId']),None)
            if not prior and task['resource']=='repository' and task['dependencies'] and before and before.get('baseCommit')!=task.get('baseCommit'):
                deps=[existing.get(dep) or next((t for t in existing.values() if t.get('planTaskId')==dep),None) for dep in task['dependencies']]
                if any(not self.verified_delivery_tree(c,owner,t) for t in deps):fail('All dependencies must be verified before revising their execution baseline')
                if task.get('baseCommit')!=meeting.get('verifiedCommit'):fail('Revised baseline must be the exact verified meeting commit')
        visiting=set();finished=set()
        def visit(identity):
            if identity in visiting:fail('Cyclic task dependencies',400)
            if identity in finished:return
            visiting.add(identity)
            for dep in graph.get(identity,[]):
                if dep in graph:visit(dep)
            visiting.remove(identity);finished.add(identity)
        for identity in graph:visit(identity)
        projects={t['projectId'] for t in tasks if t['resource'] in ('repository','directory')}
        if len(projects)>1:fail('Use one main file project per meeting')
        if projects:
            project=next(iter(projects))
            if meeting.get('mainProjectId') not in (None,project):fail('Open another project in its own meeting')
            meeting['mainProjectId']=project

    def create_task(self,c,owner,device,p):
        meeting=self.meeting(c,owner,p); self.coordinator(c,owner,device,meeting)
        if not meeting['planApproved']: fail('Plan approval required')
        fields=('title','objective','agentId','resource','projectId','nativeSessionId','permission','dependencies','inputs','baseCommit','acceptanceCriteria','targetDeviceId','planTaskId','parentTaskId')
        planned=next((t for t in meeting['plan'] if all(t.get(k)==p.get(k) for k in fields)),None)
        if not planned:fail('Task does not match the approved plan')
        if p.get('planTaskId'):
            prior=next((t for t in self.rows(c,owner,'task') if t['meetingId']==meeting['id'] and t.get('planTaskId')==p['planTaskId']),None)
            if prior:
                if any(prior.get(k)!=p.get(k) for k in ('objective','targetDeviceId','agentId','resource','projectId')):fail('Existing business task must be supplemented or explicitly continued, never duplicated or migrated')
                return prior
        if meeting.get('participants') is not None and not any(m['deviceId']==p['targetDeviceId'] and m['agentId']==p['agentId'] and m.get('executionCandidate',True) for m in meeting['participants']):fail('Agent is not selected for execution')
        if meeting.get('accepted') and not p.get('parentTaskId'): fail('Create a follow-up linked to the accepted delivery')
        target=self.get(c,owner,'device',p['targetDeviceId'])
        if target['id'] not in meeting['members'] or not target['acceptingTasks'] or target.get('revoked') or not self.online(c,owner,target['id']): fail('Selected meeting member is not accepting work')
        mode='native-session' if p['resource']=='native' else 'worker'
        if not any(a['agentId']==p['agentId'] and a['available'] and mode in a['executionModes'] for a in target['agents']): fail('Agent unavailable')
        if p.get('projectId'):
            binding=self.get(c,owner,'binding',p['projectId']+':'+target['id'])
            if binding['state']!='ready': fail('Project not ready')
        self.check_inputs(c,owner,target['id'],p['inputs'])
        resolved_dependencies=[]
        for dep in p['dependencies']:
            before=self.get(c,owner,'task',dep,False) or next((t for t in self.rows(c,owner,'task') if t.get('planTaskId')==dep and t['meetingId']==meeting['id']),None)
            if not before:fail('Dependency has not been dispatched')
            if before['meetingId']!=meeting['id'] or not self.verified_delivery_tree(c,owner,before): fail('Dependency has not passed meeting integration')
            resolved_dependencies.append(before['id'])
        if p['resource']=='repository' and p['dependencies'] and p.get('baseCommit')!=meeting.get('verifiedCommit'):fail('Use the latest verified meeting integration commit')
        if p.get('parentTaskId'):
            parent=self.get(c,owner,'task',p['parentTaskId'])
            if parent['meetingId']!=meeting['id'] or parent['status']!='accepted':fail('Follow-up must link an accepted delivery from this meeting')
        if p['resource']=='native':
            native=self.get(c,owner,'native',target['id']+':'+p.get('nativeSessionId',''))
            if native.get('status')=='unavailable':fail('Native conversation is outside current local authorization')
            if native.get('meetingId')!=meeting['id']: fail('Native conversation not selected')
            if any(t.get('nativeSessionId')==p['nativeSessionId'] and t['targetDeviceId']==target['id'] and t['status'] not in ('accepted','stopped') for t in self.rows(c,owner,'task')): fail('Conversation already has a business task')
        dispatch=hashlib.sha256(encode([p,meeting.get('plan')]).encode()).hexdigest()
        prior=next((t for t in self.rows(c,owner,'task') if t.get('dispatchIdentity')==dispatch and t['meetingId']==meeting['id']),None)
        if prior: return prior
        return self.put(c,owner,'task',str(uuid.uuid4()),{**p,'dependencies':resolved_dependencies,'approvedPlanRevision':meeting['revision'],'dispatchIdentity':dispatch,'attemptId':str(uuid.uuid4()),'status':'offered','continueAllowed':True,'stopRequested':False,'pendingFollowups':[],'evidence':[]})

    def control(self,c,owner,device,task,p):
        op=p['operation']; meeting=self.get(c,owner,'meeting',task['meetingId'])
        scope_wait=task.get('exitConfirmed') is True and task.get('scopeVersion',0)>(task.get('delivery') or {}).get('scopeVersion',0)
        if op=='stop':
            if task['status']=='accepted': fail('Accepted delivery requires a linked follow-up task')
            task['stopRequested']=True
        elif op=='revise-scope':
            if task.get('scopeVersion',0)!=p.get('expectedScopeVersion'):fail('Task scope changed; keep edits and inspect current requirements',409,'SCOPE_VERSION_CONFLICT')
            scope=p.get('scope') or {};objective=scope.get('objective','');criteria=scope.get('acceptanceCriteria',[])
            if not objective.strip() or not criteria:fail('Current objective and acceptance criteria are both required',400)
            if task['status']=='accepted':fail('Accepted work requires a linked follow-up task')
            if device!=meeting['coordinatorDeviceId']:
                task['scopeRevisionRequest']={'attemptId':task['attemptId'],'expectedScopeVersion':p['expectedScopeVersion'],'scope':scope,'supersededFollowupIds':p.get('supersededFollowupIds',[]),'requestedBy':device}
                return self.put(c,owner,'task',task['id'],task)
            self.coordinator(c,owner,device,meeting)
            if not task.get('exitConfirmed'):fail('Stop and confirm actual execution exit before replacing delivery scope')
            if objective==task['objective'] and criteria==task.get('acceptanceCriteria',[]):return task
            # Legacy plans have no planTaskId. None == None must never revise every task.
            selected=[i for i,t in enumerate(meeting.get('plan',[])) if
                (t.get('planTaskId')==task['planTaskId'] if task.get('planTaskId') else
                 all(t.get(k)==task.get(k) for k in ('title','objective','targetDeviceId','agentId','resource','projectId','nativeSessionId')))]
            if len(selected)!=1:fail('Original plan task identity is missing or ambiguous; retain scope edits and reconcile the full plan',409,'SCOPE_PLAN_IDENTITY_CHANGED')
            version=task.get('scopeVersion',0)+1
            for identity in p.get('supersededFollowupIds',[]):
                f=next((f for f in task['pendingFollowups'] if f['id']==identity and not f.get('delivered') and not f.get('ignored')),None)
                if not f:fail('Selected scope input was already delivered or changed')
                f.update(ignored=True,supersededByScopeVersion=version)
            task.setdefault('scopeHistory',[]).append({'scopeVersion':task.get('scopeVersion',0),'objective':task['objective'],'acceptanceCriteria':task.get('acceptanceCriteria',[]),'attemptId':task['attemptId'],'delivery':task.get('delivery')})
            task.update(objective=objective,acceptanceCriteria=criteria,scopeVersion=version,integration='revalidation-required')
            task.pop('verificationBinding',None);task.pop('scopeRevisionRequest',None);task.pop('continueRequest',None)
            plan=[{**t,'objective':objective,'acceptanceCriteria':criteria} if i==selected[0] else t for i,t in enumerate(meeting.get('plan',[]))]
            self.write_plan(meeting,plan,meeting.get('planBrief'),meeting.get('planApproved',False),decision=True)
            self.put(c,owner,'meeting',meeting['id'],meeting)
            affected={task['id']};changed=True
            while changed:
                changed=False
                for following in self.rows(c,owner,'task'):
                    if following['id'] not in affected and any(dep in affected for dep in following.get('dependencies',[])):
                        affected.add(following['id']);changed=True
                        self.put(c,owner,'task',following['id'],{**following,'integration':'revalidation-required'})
        elif op=='supplement':
            if task['status']=='accepted':fail('Create a follow-up linked to the accepted delivery')
            task['pendingFollowups'].append({'id':str(uuid.uuid4()),'text':p.get('text',''),'inputs':p.get('inputs',[]),'delivered':False})
        elif op in ('continue','advance'):
            if op=='continue' and not (task['status']=='stopped' or (task.get('stopRequested') or scope_wait) and task.get('exitConfirmed') and task['status'] in ('executed','delivery-pending','delivered')):fail('Execution exit not confirmed')
            if op=='continue' and task.get('scopeVersion',0)>0 and p.get('expectedScopeVersion')!=task['scopeVersion']:fail('Continue must confirm the current scope version',409,'SCOPE_VERSION_CONFLICT')
            if not task.get('continueAllowed',True):fail('Local authorization was revoked')
            if op=='continue' and (device!=meeting['coordinatorDeviceId'] or not self.online(c,owner,meeting['coordinatorDeviceId'])):
                return self.put(c,owner,'task',task['id'],{**task,'continueRequest':{'text':p.get('text',''),'followups':p.get('followups',[]),'inputs':p.get('inputs',[]),'requestedBy':device,**({'expectedScopeVersion':task['scopeVersion']} if task.get('scopeVersion',0)>0 else {})}})
            self.coordinator(c,owner,device,meeting)
            target=self.get(c,owner,'device',task['targetDeviceId'])
            if target.get('revoked'):fail('Execution device has been revoked')
            if task.get('projectId') and self.get(c,owner,'binding',task['projectId']+':'+task['targetDeviceId'])['state']!='ready':fail('Execution project must be authorized again before continuing')
            self.check_inputs(c,owner,task['targetDeviceId'],task.get('inputs',[]))
            if not task.get('continueAllowed',True):fail('Local authorization was revoked')
            if op=='continue' and not (task['status']=='stopped' or (task.get('stopRequested') or scope_wait) and task.get('exitConfirmed') and task['status'] in ('executed','delivery-pending','delivered')):fail('Execution exit not confirmed')
            if op=='advance' and (task['status'] not in ('delivered','delivery-pending') or task.get('stopRequested') or scope_wait):fail('Wait for the current delivery boundary')
            pending=[f for f in task['pendingFollowups'] if not f['delivered'] and not f.get('ignored')]
            if op=='advance' and not pending:fail('No unexecuted follow-up')
            task['evidence'].append({'attemptId':task['attemptId'],'status':task['status'],'delivery':task.get('delivery')})
            if task['resource']=='repository' and (task.get('workspaceCommit') or task.get('delivery',{}).get('commit')):task['baseCommit']=task.get('workspaceCommit') or task['delivery']['commit']
            identity=str(uuid.uuid4());decisions=p.get('followups',[]) if op=='continue' else [{'id':f['id'],'action':'include','text':f['text']} for f in pending]
            additions=[];references=list(task.get('inputs',[]))+p.get('inputs',[])
            for decision in decisions:
                followup=next((f for f in pending if f['id']==decision['id']),None)
                if not followup:fail('Follow-up was already delivered or changed')
                if decision['action']=='ignore':followup['ignored']=True
                else:
                    followup.update(text=decision['text'],includedInAttempt=identity);additions.append(decision['text']);references.extend(followup.get('inputs',[]))
            task['inputs']=list({encode(ref):ref for ref in references}.values())
            if len(task['inputs'])>100:fail('Too many selected input references',400)
            self.check_inputs(c,owner,task['targetDeviceId'],task['inputs'])
            task.setdefault('originalObjective',task['objective'])
            objective=task['objective']
            if 'expectedScopeVersion' in p and p['expectedScopeVersion']!=task.get('scopeVersion',0):fail('Scope changed before continue',409,'SCOPE_VERSION_CONFLICT')
            task['attemptInstructions']='用户已明确允许继续本次执行。当前有效范围版本：'+str(task.get('scopeVersion',0))+'。当前验收条件：'+json.dumps(task.get('acceptanceCriteria',[]),ensure_ascii=False)+'\n用户本次继续说明（不替代当前目标与验收）：\n'+p.get('text','')+'\n本次纳入的普通补充（不替代上述目标与验收；替代请明确范围修订）：\n'+'\n'.join(additions)
            if len(task['attemptInstructions'].encode('utf-8'))>48000:fail('Selected continuation inputs exceed 48000 UTF8 bytes; keep pending inputs and select a smaller set',400,'CONTINUATION_INPUT_LIMIT')
            task.pop('verificationBinding',None)
            task.pop('continueRequest',None)
            task.pop('nativeTurnId',None);task.pop('nativeThreadId',None);task.pop('turnOutcome',None)
            task.update(attemptId=identity,status='offered',stopRequested=False,objective=objective,integration='revalidation-required',exitConfirmed=False)
            affected={task['id']};changed=True
            while changed:
                changed=False
                for following in self.rows(c,owner,'task'):
                    if following['id'] not in affected and any(dep in affected for dep in following['dependencies']):
                        affected.add(following['id']);changed=True
                        self.put(c,owner,'task',following['id'],{**following,'integration':'revalidation-required'})
        elif op=='retry-delivery':
            if task['status']!='delivery-pending': fail('No pending delivery')
            task['retryDelivery']=str(uuid.uuid4())
        elif op in ('review','integrate'):
            self.coordinator(c,owner,device,meeting)
            normal_text_review=task['resource']!='repository' and task.get('turnOutcome')=='completed' and task.get('exitConfirmed') is True
            if task['status']!='delivered' or task.get('stopRequested') and not normal_text_review or not p.get('evidence'): fail('Delivery and verification evidence required')
            delivery=task.get('delivery') or {};report=delivery.get('report') or {}
            if delivery.get('scopeVersion',0)!=task.get('scopeVersion',0):fail('Delivery belongs to a superseded scope; explicitly continue and verify the current scope',409,'SCOPE_DELIVERY_OUTDATED')
            if report.get('taskId')!=task['id'] or report.get('attemptId')!=task['attemptId'] or not report.get('exitConfirmed') or any(t.get('exitCode') not in (None,0) for t in report.get('tests',[])):fail('Current structured report and successful actual tests required',409,'DELIVERY_REPORT_NOT_VERIFIED')
            if task['resource']=='text':TextArtifacts(self).require_complete(c,owner,task,delivery.get('textArtifact'))
            current_hash=delivery_hash(task)
            if not p.get('deliveryHash'):fail('Exact inspected delivery hash required; update the client and inspect the original result',426,'DELIVERY_HASH_REQUIRED')
            if p.get('deliveryHash') and p['deliveryHash']!=current_hash:fail('Delivery changed since human inspection',409,'DELIVERY_IDENTITY_CHANGED')
            binding={'attemptId':task['attemptId'],'deliveryHash':current_hash}
            previous_binding = task.get('verificationBinding') or {}
            review_matches = previous_binding.get('reviewed') is True and all(
                previous_binding.get(k) == v for k,v in binding.items())
            if op == 'review' and task.get('integration') == 'verified' and not review_matches:
                fail('Recorded integration does not match current delivery; explicitly revise or continue with a new attempt',
                     409, 'DELIVERY_IDENTITY_CHANGED')
            if op=='review':task['verificationBinding']={**binding,'reviewed':True,'evidence':p['evidence']}
            if op=='integrate':
                if not review_matches:fail('Review of this exact delivery is required',409,'DELIVERY_NOT_REVIEWED')
                for dep in task['dependencies']:
                    if not self.verified_delivery_tree(c,owner,self.get(c,owner,'task',dep)):fail('Changed predecessor must pass integration before dependent delivery can be released')
            task['evidence'].append({'operation':op,'evidence':p['evidence'],'attemptId':task['attemptId']})
            task['review' if op=='review' else 'integration']='verified'
            if op=='integrate' and task['resource']=='repository':
                if not p.get('commit'):fail('Exact verified integration commit required')
                task['integrationCommit']=p['commit']
                self.put(c,owner,'meeting',meeting['id'],{**meeting,'verifiedCommit':p['commit']})
        elif op=='accept':
            if task['status']!='delivered' or not task.get('exitConfirmed'):fail('Completed delivery required before final acceptance')
            if not self.verified_delivery_tree(c,owner,task):fail('Current delivery and predecessors must be reviewed and integrated before final acceptance',409,'DELIVERY_NOT_REVIEWED')
            if task['resource']=='text':TextArtifacts(self).require_complete(c,owner,task,(task.get('delivery') or {}).get('textArtifact'))
            task['status']='accepted'
            task['acceptedAt']=int(time.time()*1000)
            if all(t['id']==task['id'] or t['status']=='accepted' for t in self.rows(c,owner,'task') if t['meetingId']==meeting['id']):self.put(c,owner,'meeting',meeting['id'],{**meeting,'accepted':True})
        return self.put(c,owner,'task',task['id'],task)
