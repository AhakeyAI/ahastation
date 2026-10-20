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

def write_json(path,value):
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temp=path.with_name(path.name+f'.{os.getpid()}.{uuid.uuid4().hex}.tmp')
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w',encoding='utf-8') as stream:
        json.dump(value,stream,ensure_ascii=False); stream.flush(); os.fsync(stream.fileno())
    os.replace(temp,path)

def read_json(path,default=None):
    try: return json.loads(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError: return default

def cancelled(spec):
    directory=spec.get('_journal_dir')
    return bool(directory and (Path(directory)/'cancel.json').exists())

def feedback(result):
    parsed=result.get('json'); native=parsed.get('json') if isinstance(parsed,dict) else None
    values=[parsed.get('last_message') if isinstance(parsed,dict) else None,
            native.get('result') if isinstance(native,dict) else None,
            parsed.get('result') if isinstance(parsed,dict) else None,result.get('stdout')]
    last=next((value for value in values if isinstance(value,str) and value.strip()),'')
    last=last.encode('utf-8')[:16000].decode('utf-8',errors='ignore')
    error=result.get('error','')
    if not error and isinstance(parsed,dict) and parsed.get('desktop_session'):
        error=parsed.get('error','')  # Preserve desktop resume/writer errors in durable feedback.
    return {**{key:result[key] for key in ('ok','cancelled','cleanup_confirmed','exit_code') if key in result},
            'error':str(error)[:1000],'json':{'last_message':last},'stderr':str(result.get('stderr',''))[:2000]}

def save_result(spec,result):
    if spec.get('_journal_dir'): write_json(Path(spec['_journal_dir'])/'result.json',feedback(result))

class TaskJournal:
    def __init__(self,task_id,provider):
        task_id=str(uuid.UUID(task_id))
        if provider not in {'codex','claude'}: raise ValueError('Invalid task provider')
        self.path=state_dir()/'remote'/'tasks'/provider/task_id
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
        return read_json(self.path/'result.json') or (read_json(self.path/'ack.json') or {}).get('proof')
    def finish(self,result): write_json(self.path/'result.json',feedback(result))
    def ack(self):
        result=self.result() or {}
        proof={key:result[key] for key in ('ok','cancelled','cleanup_confirmed','error') if key in result}
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
