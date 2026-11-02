"""Authenticated text-only artifacts. Chunks are bytes; snapshots contain references only."""
import base64,hashlib,json,math,uuid
from sqlalchemy import Table,Column,String,Integer,Text,LargeBinary,select,update,func
from sqlalchemy.dialects.mysql import LONGTEXT
MAX_BYTES=16*1024*1024
CHUNK=32768
MAX_ACCOUNT_BYTES=256*1024*1024

def install_tables(metadata):
    global artifacts,chunks
    artifacts=Table('collab_text_artifacts',metadata,Column('owner',String(36),primary_key=True),Column('id',String(36),primary_key=True),Column('task_id',String(36),nullable=False),Column('attempt_id',String(36),nullable=False),Column('device_id',String(36),nullable=False),Column('byte_length',Integer,nullable=False),Column('data',Text().with_variant(LONGTEXT(),'mysql'),nullable=False))
    chunks=Table('collab_text_chunks',metadata,Column('owner',String(36),primary_key=True),Column('artifact_id',String(36),primary_key=True),Column('part',Integer,primary_key=True),Column('sha256',String(64),nullable=False),Column('data',LargeBinary,nullable=False))

def fail(message,status=409,code='TEXT_ARTIFACT_CONFLICT'):
    from fastapi import HTTPException
    raise HTTPException(status,{'code':code,'message':message})

def digest(data):return hashlib.sha256(data).hexdigest()

def validate_manifest(value):
    keys={'version','artifactId','taskId','attemptId','mediaType','byteLength','sha256','chunkSize','chunkCount','contentComplete'}
    if not isinstance(value,dict) or set(value)!=keys:fail('Invalid text manifest',400)
    for key in ('artifactId','taskId','attemptId'):
        try:
            if str(uuid.UUID(value[key]))!=value[key]:raise ValueError()
        except (ValueError,TypeError,AttributeError):fail('Invalid artifact identity',400)
    length=value['byteLength']
    if type(length)!=int or length<0 or length>MAX_BYTES:fail('Full text exceeds 16MiB transport limit; original local bytes retained',413,'TEXT_ARTIFACT_LIMIT')
    if type(value['version'])!=int or type(value['chunkCount'])!=int or value['version']!=1 or value['mediaType']!='text/plain;charset=utf-8' or value['chunkSize']!=CHUNK or value['chunkCount']!=math.ceil(length/CHUNK) or type(value['contentComplete'])!=bool:fail('Invalid text layout or format',400)
    if not isinstance(value['sha256'],str) or len(value['sha256'])!=64 or any(c not in '0123456789abcdef' for c in value['sha256']):fail('Invalid text SHA256',400)
    return dict(value)

class TextArtifacts:
    def __init__(self,store):self.store=store
    def task(self,c,user,task_id,attempt=None,write=False):
        task=self.store.get(c,user['owner'],'task',task_id)
        meeting=self.store.get(c,user['owner'],'meeting',task['meetingId'])
        device=self.store.get(c,user['owner'],'device',user.get('device'))
        if device.get('revoked'):fail('Device revoked',403,'FORBIDDEN')
        if task['resource']!='text':fail('This channel only transfers text task results',400)
        if write and (task['attemptId']!=attempt or task['targetDeviceId']!=user.get('device')):fail('Original execution device and current attempt required',403,'ARTIFACT_ATTEMPT_MISMATCH')
        if user.get('device') not in set(meeting.get('members',[])+[p['deviceId'] for p in meeting.get('participants',[])]+[meeting['coordinatorDeviceId'],task['targetDeviceId']]):fail('Meeting membership required',403,'FORBIDDEN')
        return task
    def row(self,c,user,identity,write=False):
        row=c.execute(select(artifacts).where(artifacts.c.owner==user['owner'],artifacts.c.id==identity)).mappings().first()
        if not row:fail('Text artifact not found',404)
        self.task(c,user,row['task_id'],row['attempt_id'],write)
        return row,json.loads(row['data'])
    def begin(self,user,value):
        value=validate_manifest(value)
        with self.store.transaction(user['owner']) as c:
            self.task(c,user,value['taskId'],value['attemptId'],True)
            old=c.execute(select(artifacts.c.data).where(artifacts.c.owner==user['owner'],artifacts.c.id==value['artifactId'])).scalar()
            if old:
                saved=json.loads(old)
                if {k:saved[k] for k in value}!=value:fail('Artifact identity reused with different content')
                return self.status(c,user,value['artifactId'],saved)
            total=c.execute(select(func.coalesce(func.sum(artifacts.c.byte_length),0)).where(artifacts.c.owner==user['owner'])).scalar()
            count=c.execute(select(func.count()).select_from(artifacts).where(artifacts.c.owner==user['owner'],artifacts.c.task_id==value['taskId'],artifacts.c.attempt_id==value['attemptId'])).scalar()
            if total+value['byteLength']>MAX_ACCOUNT_BYTES or count>=8:fail('Text artifact quota exceeded; keep local result and select an authorized delivery path',413,'TEXT_ARTIFACT_LIMIT')
            saved={**value,'status':'uploading'}
            c.execute(artifacts.insert().values(owner=user['owner'],id=value['artifactId'],task_id=value['taskId'],attempt_id=value['attemptId'],device_id=user['device'],byte_length=value['byteLength'],data=json.dumps(saved)))
            return self.status(c,user,value['artifactId'],saved)
    def status(self,c,user,identity,manifest):
        parts=set(c.execute(select(chunks.c.part).where(chunks.c.owner==user['owner'],chunks.c.artifact_id==identity)).scalars())
        return {'manifest':manifest,'missing':[i for i in range(manifest['chunkCount']) if i not in parts]}
    def get(self,user,identity):
        with self.store.transaction(user['owner']) as c:
            _,m=self.row(c,user,identity)
            return self.status(c,user,identity,m)
    def put(self,user,identity,index,value):
        if not isinstance(value,dict) or set(value)!={'data','sha256'}:fail('Only encoded text chunk and SHA256 accepted',400)
        try:data=base64.b64decode(value['data'],validate=True)
        except Exception:fail('Invalid Base64 chunk',400)
        if len(data)>CHUNK or digest(data)!=value['sha256']:fail('Text chunk hash or size mismatch',400,'TEXT_CHUNK_HASH_MISMATCH')
        with self.store.transaction(user['owner']) as c:
            _,m=self.row(c,user,identity,True)
            expected=min(CHUNK,m['byteLength']-index*CHUNK)
            if index<0 or index>=m['chunkCount'] or expected!=len(data):fail('Chunk range mismatch',400)
            old=c.execute(select(chunks).where(chunks.c.owner==user['owner'],chunks.c.artifact_id==identity,chunks.c.part==index)).mappings().first()
            if old:
                if old['sha256']!=value['sha256'] or bytes(old['data'])!=data:fail('Conflicting chunk at original index',409,'TEXT_CHUNK_CONFLICT')
                return {'ok':True,'index':index}
            if m['status']!='uploading':fail('Verified text artifact is immutable')
            c.execute(chunks.insert().values(owner=user['owner'],artifact_id=identity,part=index,sha256=value['sha256'],data=data))
            return {'ok':True,'index':index}
    def read(self,user,identity,index):
        with self.store.transaction(user['owner']) as c:
            self.row(c,user,identity)
            part=c.execute(select(chunks).where(chunks.c.owner==user['owner'],chunks.c.artifact_id==identity,chunks.c.part==index)).mappings().first()
            if not part:fail('Text chunk missing',404,'TEXT_CHUNK_MISSING')
            return {'index':index,'data':base64.b64encode(part['data']).decode(),'sha256':part['sha256']}
    def complete(self,user,identity):
        with self.store.transaction(user['owner']) as c:
            _,m=self.row(c,user,identity,True)
            parts=list(c.execute(select(chunks).where(chunks.c.owner==user['owner'],chunks.c.artifact_id==identity).order_by(chunks.c.part)).mappings())
            if len(parts)!=m['chunkCount'] or [p['part'] for p in parts]!=list(range(m['chunkCount'])):fail('Full text still has missing chunks',409,'TEXT_CHUNK_MISSING')
            data=b''.join(bytes(p['data']) for p in parts)
            if any(digest(p['data'])!=p['sha256'] for p in parts) or len(data)!=m['byteLength'] or digest(data)!=m['sha256']:fail('Full text byte length or SHA256 mismatch',409,'TEXT_ARTIFACT_HASH_MISMATCH')
            try:data.decode('utf-8','strict')
            except UnicodeDecodeError:fail('Full text is not valid UTF8',400)
            m={**m,'status':'complete' if m['contentComplete'] else 'partial'}
            c.execute(update(artifacts).where(artifacts.c.owner==user['owner'],artifacts.c.id==identity).values(data=json.dumps(m)))
            return m
    def require_complete(self,c,owner,task,manifest):
        if not isinstance(manifest,dict):fail('Complete text artifact required; legacy preview is not proof of full text',409,'TEXT_ARTIFACT_REQUIRED')
        row=c.execute(select(artifacts).where(artifacts.c.owner==owner,artifacts.c.id==manifest.get('artifactId'))).mappings().first()
        if not row:fail('Complete text artifact not found')
        saved=json.loads(row['data'])
        if row['task_id']!=task['id'] or row['attempt_id']!=task['attemptId'] or row['device_id']!=task['targetDeviceId'] or saved!=manifest or saved['status']!='complete' or not saved['contentComplete']:fail('Full text does not match current execution',409,'ARTIFACT_ATTEMPT_MISMATCH')
        return saved
