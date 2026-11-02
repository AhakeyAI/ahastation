"""Durable per-task receipt, launch intent, cancellation, result and tombstone.

Independent files avoid cancellation/result overwrites across processes. Only
the local Bridge chooses this path; it is never accepted from Hub payloads.
"""
from pathlib import Path
import hashlib
import json
import os
import time
import uuid
from session_runtime import state_dir

RESULT_FIELDS=('executionId','ok','cancelled','cleanup_confirmed','exit_code','exitCode',
               'turnOutcome','not_started','rpcError','fullText','contentComplete')

def native_path(path):
    """Atomic suffixes may exceed MAX_PATH even when the journal itself fits."""
    value=os.path.abspath(path)
    if os.name=='nt' and not value.startswith('\\\\?\\'):
        value='\\\\?\\UNC\\'+value[2:] if value.startswith('\\\\') else '\\\\?\\'+value
    return Path(value)

def write_json(path,value):
    path=native_path(path); path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temp=path.with_name(path.name+f'.{os.getpid()}.{uuid.uuid4().hex}.tmp')
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w',encoding='utf-8') as stream:
        json.dump(value,stream,ensure_ascii=False); stream.flush(); os.fsync(stream.fileno())
    for attempt in range(10):
        try:os.replace(temp,path);break
        except PermissionError:
            if os.name!='nt' or attempt==9:raise
            time.sleep(min(.05*(attempt+1),.25))

def read_json(path,default=None):
    for attempt in range(10):
        try:return json.loads(native_path(path).read_text(encoding='utf-8'))
        except FileNotFoundError:return default
        except PermissionError:
            # A transient Windows file-share/scanner lock is neither absence
            # nor proof that execution has ended. Exhaustion remains an error.
            if os.name!='nt' or attempt==9:raise
            time.sleep(min(.05*(attempt+1),.25))

def cancelled(spec):
    directory=spec.get('_journal_dir')
    return bool(directory and (Path(directory)/'cancel.json').exists())

def feedback(result):
    parsed=result.get('json'); native=parsed.get('json') if isinstance(parsed,dict) else None
    values=[parsed.get('last_message') if isinstance(parsed,dict) else None,
            native.get('result') if isinstance(native,dict) else None,
            parsed.get('result') if isinstance(parsed,dict) else None,result.get('stdout')]
    last=next((value for value in values if isinstance(value,str) and value.strip()),'')
    error=result.get('error','')
    if not error and isinstance(parsed,dict) and parsed.get('desktop_session'):
        error=parsed.get('error','')  # Preserve desktop resume/writer errors in durable feedback.
    return {**{key:result[key] for key in RESULT_FIELDS if key in result},
            'error':str(error)[:1000],'json':{'last_message':last},'stderr':str(result.get('stderr',''))[:2000]}

def write_bytes(path,data):
    path=native_path(path);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    with open(temp,'xb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
    for attempt in range(10):
        try:os.replace(temp,path);return
        except PermissionError:
            if os.name!='nt' or attempt==9:raise
            time.sleep(min(.05*(attempt+1),.25))

def durable_feedback(directory,result):
    value=feedback(result);text=value['json']['last_message'];reference=result.get('fullText')
    if reference:
        data=native_path(reference['path']).read_bytes()
        if len(data)!=reference['byteLength'] or hashlib.sha256(data).hexdigest()!=reference['sha256']:raise RuntimeError('Original full text reference failed verification; preview was not promoted')
        text=data.decode('utf-8','strict')
    else:
        if isinstance(result.get('json'),dict) and result['json'].get('preview'):raise RuntimeError('Preview cannot replace original full text')
        data=text.encode('utf-8')
    directory=native_path(directory);target=directory/'full-result.txt'
    write_bytes(target,data)
    if hashlib.sha256(target.read_bytes()).digest()!=hashlib.sha256(data).digest():raise RuntimeError('Complete text durable verification failed')
    parsed=result.get('json') or {}
    messages=parsed.get('final_messages') if isinstance(parsed,dict) else None
    if messages is None:messages=read_json(native_path(reference['path']).with_name('final-model-messages.json'),[]) if reference else []
    write_json(directory/'final-model-messages.json',messages)
    complete=result.get('ok') is True and result.get('turnOutcome') not in ('failed','interrupted','unknown') and not result.get('cancelled') and (not reference or reference.get('contentComplete') is True)
    value['fullText']={'version':1,'path':str(target),'byteLength':len(data),'sha256':hashlib.sha256(data).hexdigest(),'contentComplete':complete}
    value['contentComplete']=complete
    # Transport preview is explicitly separate from the durable full bytes.
    value['json']={'last_message':text[:4000],'preview':True}
    write_json(directory/'full-result-manifest.json',value['fullText'])
    write_json(directory/'result.json',value)
    return value

def save_result(spec,result):
    if spec.get('_journal_dir'):durable_feedback(spec['_journal_dir'],result)

class TaskJournal:
    def __init__(self,task_id,provider):
        task_id=str(uuid.UUID(task_id))
        if provider not in {'codex','claude'}: raise ValueError('Invalid task provider')
        self.path=native_path(state_dir()/'remote'/'tasks'/provider/task_id)
        self.path.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.task_id=task_id

    def receive(self,msg,binding=None):
        digest=hashlib.sha256(json.dumps(msg['payload'],sort_keys=True,separators=(',',':')).encode()).hexdigest()
        old=read_json(self.path/'receipt.json')
        if old:
            if old.get('binding')!=binding: raise ValueError('Task receipt belongs to another service or owner')
            if old['digest']!=digest: raise ValueError('Task ID reused with different payload')
            return False
        write_json(self.path/'payload.json',msg)
        write_json(self.path/'receipt.json',{'digest':digest,'received_at':time.time(),'binding':binding})
        return True

    def launch_once(self):
        try:
            fd=os.open(self.path/'launch-intent',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            os.close(fd); return True
        except FileExistsError: return False

    def request_cancel(self): write_json(self.path/'cancel.json',{'requested_at':time.time()})
    def result(self):
        result=read_json(self.path/'result.json') or (read_json(self.path/'ack.json') or {}).get('proof')
        if result and result.get('executionId',self.task_id)!=self.task_id:
            raise ValueError('Journal result belongs to another execution attempt')
        if result and 'executionId' not in result:
            request=read_json(self.path/'station-request.json',{})
            payload=self.payload() or {}
            if request.get('executionId')==self.task_id or payload.get('task_id')==self.task_id:
                return {**result,'executionId':self.task_id}
        return result
    def finish(self,result): durable_feedback(self.path,{**result,'executionId':self.task_id})
    def ack(self):
        result=self.result() or {}
        proof={key:result[key] for key in (*RESULT_FIELDS,'error') if key in result}
        write_json(self.path/'ack.json',{'acked_at':time.time(),'proof':proof})
    def payload(self): return read_json(self.path/'payload.json')

    @classmethod
    def all(cls,provider,binding=None):
        root=state_dir()/'remote'/'tasks'/provider
        rows=[cls(path.name,provider) for path in root.glob('*') if path.is_dir() and (path/'receipt.json').exists()]
        return rows if binding is None else [row for row in rows if read_json(row.path/'receipt.json',{}).get('binding')==binding]

    def purge_feedback(self,days=7):
        ack=read_json(self.path/'ack.json')
        if ack and ack.get('proof',{}).get('cleanup_confirmed') is True and ack['acked_at']<time.time()-days*86400:
            for name in ('payload.json','result.json'): (self.path/name).unlink(missing_ok=True)
            # Receipt + launch intent + ack remain: a duplicate cannot execute.
