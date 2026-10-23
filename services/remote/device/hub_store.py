"""Public Hub persistence. Production accepts MySQL only; tests inject their DB.

No container-file/SQLite fallback. Secrets are random bearer credentials, stored
as keyed hashes. Transactions serialize pairing and quota admission per owner.
"""
from __future__ import annotations
import hashlib
import hmac
import json
import os
import secrets
import time
import uuid
import threading
from contextlib import contextmanager
from sqlalchemy import (create_engine, MetaData, Table, Column, String, Text, Integer,
                        Float, UniqueConstraint, select, update, delete, func, text, inspect)
from sqlalchemy.engine import URL
from sqlalchemy.exc import IntegrityError
from sqlalchemy.dialects.mysql import LONGTEXT, insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from fastapi import HTTPException

Epoch = Float(53)
metadata = MetaData()
schema = Table('hub_schema', metadata, Column('id', Integer, primary_key=True), Column('version', Integer, nullable=False))
users = Table('hub_users', metadata, Column('id', String(36), primary_key=True),
    Column('login', String(80), unique=True, nullable=False), Column('password', String(220), nullable=False),
    Column('recovery', String(64), nullable=False), Column('created', Epoch, nullable=False))
devices = Table('hub_devices', metadata, Column('id', String(36), primary_key=True),
    Column('owner', String(36), nullable=False, index=True), Column('name', String(160), nullable=False),
    Column('revoked', Integer, nullable=False, default=0), Column('created', Epoch, nullable=False))
credentials = Table('hub_credentials', metadata, Column('digest', String(64), primary_key=True),
    Column('owner', String(36), nullable=False, index=True), Column('device', String(36)),
    Column('scope', String(16), nullable=False), Column('expires', Epoch, nullable=False),
    Column('revoked', Integer, nullable=False, default=0))
pairs = Table('hub_pairs', metadata, Column('digest', String(64), primary_key=True),
    Column('owner', String(36), nullable=False), Column('expires', Epoch, nullable=False), Column('used', Integer, nullable=False, default=0))
tasks = Table('hub_tasks', metadata, Column('id', String(36), primary_key=True),
    Column('owner', String(36), nullable=False, index=True), Column('device', String(36), nullable=False, index=True),
    Column('agent', String(160), nullable=False), Column('status', String(32), nullable=False),
    Column('data', Text().with_variant(LONGTEXT(), 'mysql'), nullable=False), Column('created', Epoch, nullable=False), Column('updated', Epoch, nullable=False),
    Column('revision', Integer, nullable=False, default=1))
keys = Table('hub_task_keys', metadata, Column('owner', String(36), primary_key=True),
    Column('key', String(80), primary_key=True), Column('digest', String(64), nullable=False),
    Column('task', String(36), nullable=False))
rates = Table('hub_rates', metadata, Column('key', String(64), primary_key=True),
    Column('window', Integer, primary_key=True), Column('count', Integer, nullable=False))
FINAL = {'done', 'failed', 'cancelled'}  # Unconfirmed cleanup is deliberately not final.
for table in metadata.tables.values():
    table.dialect_options['mysql'].update(engine='InnoDB',charset='utf8mb4',collate='utf8mb4_bin')

def password_hash(value: str) -> str:
    salt = secrets.token_hex(16)
    return salt + ':' + hashlib.pbkdf2_hmac('sha256', value.encode(), bytes.fromhex(salt), 600_000).hex()

def password_matches(value: str, stored: str) -> bool:
    salt, digest = stored.split(':')
    return hmac.compare_digest(digest, hashlib.pbkdf2_hmac('sha256', value.encode(), bytes.fromhex(salt), 600_000).hex())

class HubStore:
    def __init__(self, engine, secret: str):
        if len(secret) < 32: raise RuntimeError('HUB_SECRET must have at least 32 random characters')
        self.engine, self.secret = engine, secret.encode()
        self.collaboration_lock=threading.RLock()

    @classmethod
    def production(cls):
        if os.environ.get('HUB_SECRET','').startswith('replace-'):
            raise RuntimeError('Replace the Hub secret placeholder with a privately generated random secret')
        address = os.getenv('MYSQL_HOST') or os.getenv('MYSQL_ADDRESS', '')
        host, separator, port = address.rpartition(':')
        if not separator: host, port = address, os.getenv('MYSQL_PORT', '3306')
        username = os.getenv('MYSQL_USER') or os.getenv('MYSQL_USERNAME', '')
        password = os.getenv('MYSQL_PASSWORD', '')
        if not host or not username or not password or username.lower() == 'root':
            raise RuntimeError('Configure a dedicated MySQL application account and internal address; root is refused')
        options={'connect_timeout':5, 'read_timeout':10, 'write_timeout':10}
        if os.getenv('MYSQL_SSL_CA'):
            options.update(ssl_ca=os.environ['MYSQL_SSL_CA'],ssl_verify_cert=True,ssl_verify_identity=True)
        engine = create_engine(URL.create('mysql+pymysql', username=username, password=password,
            host=host, port=int(port), database=os.getenv('MYSQL_DATABASE', 'station_hub'),
            query={'charset':'utf8mb4'}), pool_pre_ping=True, pool_size=5, max_overflow=5,
            connect_args=options)
        return cls(engine, os.environ.get('HUB_SECRET', ''))

    def migrate(self):
        if inspect(self.engine).has_table(schema.name):
            with self.engine.connect() as conn:
                if conn.execute(select(schema.c.version).where(schema.c.id==1)).scalar() not in {None,1,2}:
                    raise RuntimeError('Unknown Hub schema version; no DDL was applied')
        metadata.create_all(self.engine)  # Explicit migration command, never automatic fallback.
        from collaboration_store import metadata as collaboration_metadata
        collaboration_metadata.create_all(self.engine)
        with self.engine.begin() as conn:
            version = conn.execute(select(schema.c.version).where(schema.c.id == 1)).scalar()
            if version is None: conn.execute(schema.insert().values(id=1, version=2))
            elif version == 1: conn.execute(update(schema).where(schema.c.id==1,schema.c.version==1).values(version=2))
            elif version != 2: raise RuntimeError('Unknown Hub schema version')

    def ready(self):
        with self.engine.connect() as conn:
            if conn.execute(select(schema.c.version).where(schema.c.id == 1)).scalar() != 2:
                raise RuntimeError('Run the explicit Hub database migration first')
            if conn.dialect.name=='mysql':
                rows=conn.execute(text('SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=:db'),{'db':conn.engine.url.database})
                engines={name:engine for name,engine in rows}
                from collaboration_store import metadata as collaboration_metadata
                if any(engines.get(table.name,'').lower()!='innodb' for table in [*metadata.tables.values(),*collaboration_metadata.tables.values()]):
                    raise RuntimeError('Hub tables must use InnoDB transactions; startup refused')

    def digest(self, value: str):
        return hmac.new(self.secret, value.encode(), hashlib.sha256).hexdigest()

    def rate(self, key: str, limit: int, seconds: int = 60):
        window = int(time.time()) // seconds
        digest = self.digest(key)
        with self.engine.begin() as conn:
            values=dict(key=digest,window=window,count=1)
            if conn.dialect.name=='mysql':
                statement=mysql_insert(rates).values(**values).on_duplicate_key_update(count=rates.c.count+1)
            else:  # Explicitly injected test database, never production fallback.
                statement=sqlite_insert(rates).values(**values).on_conflict_do_update(index_elements=['key','window'],set_={'count':rates.c.count+1})
            conn.execute(statement)
            count=conn.execute(select(rates.c.count).where(rates.c.key==digest,rates.c.window==window)).scalar()
        if count>limit: raise HTTPException(429,'Too many requests; try later')

    def issue(self, conn, owner: str, scope='control', device=None):
        token = secrets.token_urlsafe(32)
        conn.execute(credentials.insert().values(digest=self.digest(token), owner=owner, scope=scope, device=device,
            expires=time.time()+(180 if scope=='device' else 30)*86400, revoked=0))
        return token

    def authenticate(self, token: str, scope: str):
        if not token or len(token)>256: raise HTTPException(401, 'Remote credentials are missing or expired')
        with self.engine.connect() as conn:
            row = conn.execute(select(credentials).where(credentials.c.digest==self.digest(token), credentials.c.revoked==0,
                credentials.c.scope==scope, credentials.c.expires>time.time())).mappings().first()
            if not row: raise HTTPException(401, 'Remote credentials are missing, expired or revoked')
            if row['device']:
                valid = conn.execute(select(devices.c.id).where(devices.c.id==row['device'], devices.c.owner==row['owner'], devices.c.revoked.in_([0,2]))).scalar()
                if not valid: raise HTTPException(401, 'Device has been unpaired')
            return dict(row)

    def identity(self, login: str, password: str, *, register=False, recovery=''):
        login = login.strip().lower()
        if not 3 <= len(login) <= 80 or not all(c.isalnum() or c in '-_.' for c in login): raise HTTPException(400, 'Use a 3–80 character account name')
        if not 12 <= len(password) <= 128: raise HTTPException(400, 'Password must contain 12–128 characters')
        recovery_code = secrets.token_urlsafe(24) if register or recovery else None
        try:
            with self.engine.begin() as conn:
                user = conn.execute(select(users).where(users.c.login==login).with_for_update()).mappings().first()
                if register:
                    if user: raise HTTPException(409, 'Account name is unavailable')
                    owner = str(uuid.uuid4())
                    conn.execute(users.insert().values(id=owner,login=login,password=password_hash(password),recovery=self.digest(recovery_code),created=time.time()))
                else:
                    if not user or not (hmac.compare_digest(user['recovery'], self.digest(recovery)) if recovery else password_matches(password,user['password'])):
                        # Do an expensive hash for absent users too; no password recovery oracle.
                        if not user: password_hash(password)
                        raise HTTPException(401, 'Account credentials are invalid')
                    owner = user['id']
                    if recovery:
                        conn.execute(update(users).where(users.c.id==owner).values(password=password_hash(password),recovery=self.digest(recovery_code)))
                        conn.execute(update(credentials).where(credentials.c.owner==owner,credentials.c.scope=='control').values(revoked=1))
                token = self.issue(conn,owner)
                return {'ok':True,'owner_id':owner,'login':login,'control_token':token,'recovery_code':recovery_code}
        except IntegrityError: raise HTTPException(409, 'Account name is unavailable')

    def create_pair(self, owner):
        code = secrets.token_urlsafe(18)  # 144 bits; short-lived, never an admin credential.
        with self.engine.begin() as conn:
            conn.execute(select(users.c.id).where(users.c.id==owner).with_for_update())
            conn.execute(pairs.insert().values(digest=self.digest(code),owner=owner,expires=time.time()+600,used=0))
        return {'ok':True,'pair_code':code,'expires_in':600}

    def claim_pair(self, code, device, name):
        try: device = str(uuid.UUID(device))
        except (ValueError, TypeError): raise HTTPException(400,'Invalid stable device identity')
        with self.engine.begin() as conn:
            pair = conn.execute(select(pairs).where(pairs.c.digest==self.digest(code)).with_for_update()).mappings().first()
            if not pair or pair['used'] or pair['expires']<time.time(): raise HTTPException(409,'Pairing code is invalid, expired or already used')
            # The conditional update is essential even when a test dialect has no FOR UPDATE.
            count = conn.execute(update(pairs).where(pairs.c.digest==pair['digest'],pairs.c.used==0,pairs.c.expires>=time.time()).values(used=1)).rowcount
            if count != 1: raise HTTPException(409,'Pairing code has already been claimed')
            conn.execute(select(users.c.id).where(users.c.id==pair['owner']).with_for_update())
            old = conn.execute(select(devices).where(devices.c.id==device).with_for_update()).mappings().first()
            if not old or old['revoked']==1:
                count=conn.execute(select(func.count()).select_from(devices).where(devices.c.owner==pair['owner'],devices.c.revoked.in_([0,2]))).scalar()
                if count>=10: raise HTTPException(429,'Paired device limit reached; unpair an old device first')
            if old and old['owner']!=pair['owner'] and old['revoked']!=1: raise HTTPException(409,'This OS-user device is paired to another owner; unpair locally first')
            values = dict(owner=pair['owner'],name=str(name)[:160] or device,revoked=0,created=time.time())
            if old:
                conn.execute(update(devices).where(devices.c.id==device).values(**values))
                conn.execute(update(credentials).where(credentials.c.device==device).values(revoked=1))
            else: conn.execute(devices.insert().values(id=device,**values))
            return {'ok':True,'device_id':device,'owner_id':pair['owner'],'device_token':self.issue(conn,pair['owner'],'device',device),'protocol':2}

    def owned_device(self, owner, device):
        with self.engine.connect() as conn:
            row=conn.execute(select(devices).where(devices.c.id==device,devices.c.owner==owner,devices.c.revoked==0)).mappings().first()
            if not row: raise HTTPException(404,'Device not found')
            return dict(row)

    def list_devices(self, owner):
        with self.engine.connect() as conn:
            return [dict(row) for row in conn.execute(select(devices).where(devices.c.owner==owner,devices.c.revoked==0)).mappings()]

    def revoke(self, owner, device=None, token=None):
        with self.engine.begin() as conn:
            where = credentials.c.owner==owner
            if device:
                if not conn.execute(select(devices.c.id).where(devices.c.id==device,devices.c.owner==owner)).scalar(): raise HTTPException(404,'Device not found')
                conn.execute(update(devices).where(devices.c.id==device,devices.c.owner==owner).values(revoked=1))
                where = where & (credentials.c.device==device)
            elif token: where = where & (credentials.c.digest==self.digest(token))
            else: where = where & (credentials.c.scope=='control')
            conn.execute(update(credentials).where(where).values(revoked=1))

    def drain_device(self,owner,device):
        self.owned_device(owner,device)
        with self.engine.begin() as conn:
            conn.execute(update(devices).where(devices.c.id==device,devices.c.owner==owner).values(revoked=2))

    @staticmethod
    def task_value(row):
        return {**json.loads(row['data']),'task_id':row['id'],'status':row['status'],'revision':row['revision']}

    def get_task(self, owner, task_id):
        with self.engine.connect() as conn:
            row=conn.execute(select(tasks).where(tasks.c.id==task_id,tasks.c.owner==owner)).mappings().first()
            if not row: raise HTTPException(404,'Task not found')
            return self.task_value(row)

    def by_key(self,owner,key):
        with self.engine.connect() as conn:
            row=conn.execute(select(keys).where(keys.c.owner==owner,keys.c.key==key)).mappings().first()
            if not row: raise HTTPException(404,'No durable receipt for this submission')
        return self.get_task(owner,row['task'])

    def existing_submission(self,owner,key,payload):
        with self.engine.connect() as conn:
            old=conn.execute(select(keys).where(keys.c.owner==owner,keys.c.key==key)).mappings().first()
            if not old: return None
            digest=hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            if old['digest'] not in {digest,'cancel-before-submit'}: raise HTTPException(409,'Idempotency key belongs to another request')
            row=conn.execute(select(tasks).where(tasks.c.id==old['task'],tasks.c.owner==owner)).mappings().first()
            if not row: raise HTTPException(410,'Feedback expired; this request will not execute again')
            return self.task_value(row)

    def cancel_key(self,owner,key):
        if not isinstance(key,str) or not 8<=len(key)<=80: raise HTTPException(400,'Invalid idempotency key')
        with self.engine.begin() as conn:
            conn.execute(select(users.c.id).where(users.c.id==owner).with_for_update())
            old=conn.execute(select(keys).where(keys.c.owner==owner,keys.c.key==key)).mappings().first()
            if old: return old['task']
            if conn.execute(select(func.count()).select_from(keys).where(keys.c.owner==owner)).scalar()>=20000:
                raise HTTPException(429,'Submission history limit reached; contact the operator')
            task_id=str(uuid.uuid4()); now=time.time()
            data={'owner_id':owner,'device_id':'','target_agent':'','cancel_requested':True,
                  'result':{'ok':False,'cancelled':True,'cleanup_confirmed':True},'error':'Cancelled before submission was admitted'}
            conn.execute(tasks.insert().values(id=task_id,owner=owner,device='',agent='',status='cancelled',data=json.dumps(data),created=now,updated=now,revision=1))
            conn.execute(keys.insert().values(owner=owner,key=key,digest='cancel-before-submit',task=task_id))
            return task_id

    def list_tasks(self, owner, device=None, active=False):
        where=tasks.c.owner==owner
        if device: where=where & (tasks.c.device==device)
        if active: where=where & tasks.c.status.not_in(FINAL)
        with self.engine.connect() as conn:
            return [self.task_value(row) for row in conn.execute(select(tasks).where(where).order_by(tasks.c.created.desc()).limit(100)).mappings()]

    def submit(self, owner, device, agent, key, payload):
        if not isinstance(key,str) or not 8 <= len(key) <= 80: raise HTTPException(400,'A stable idempotency_key is required')
        digest=hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        with self.engine.begin() as conn:
            conn.execute(select(users.c.id).where(users.c.id==owner).with_for_update())
            old=conn.execute(select(keys).where(keys.c.owner==owner,keys.c.key==key)).mappings().first()
            if old:
                if old['digest'] not in {digest,'cancel-before-submit'}: raise HTTPException(409,'Idempotency key belongs to another request')
                row=conn.execute(select(tasks).where(tasks.c.id==old['task'],tasks.c.owner==owner)).mappings().first()
                if not row: raise HTTPException(410,'Task feedback expired; this request will not execute again')
                return self.task_value(row),False
            if conn.execute(select(func.count()).select_from(keys).where(keys.c.owner==owner)).scalar()>=20000:
                raise HTTPException(429,'Submission history limit reached; contact the operator')
            target=conn.execute(select(devices).where(devices.c.id==device,devices.c.owner==owner,devices.c.revoked==0).with_for_update()).mappings().first()
            if not target: raise HTTPException(404,'Device not found')
            total=conn.execute(select(func.count()).select_from(tasks).where(tasks.c.owner==owner,tasks.c.status.not_in(FINAL))).scalar()
            count=conn.execute(select(func.count()).select_from(tasks).where(tasks.c.device==device,tasks.c.status.not_in(FINAL))).scalar()
            if total >= 16 or count >= 4: raise HTTPException(429,'Remote task queue limit reached')
            task_id=str(uuid.uuid4()); now=time.time()
            data={**payload,'owner_id':owner,'device_id':device,'target_agent':agent,'created_at':now,'execution_status':'waiting'}
            conn.execute(tasks.insert().values(id=task_id,owner=owner,device=device,agent=agent,status='queued',data=json.dumps(data),created=now,updated=now,revision=1))
            conn.execute(keys.insert().values(owner=owner,key=key,digest=digest,task=task_id))
            return {**data,'task_id':task_id,'status':'queued','revision':1},True

    def transition(self, owner, task_id, status=None, **patch):
        verified_delivery=patch.pop('verified_delivery',False)
        with self.engine.begin() as conn:
            row=conn.execute(select(tasks).where(tasks.c.id==task_id,tasks.c.owner==owner).with_for_update()).mappings().first()
            if not row: raise HTTPException(404,'Task not found')
            value=self.task_value(row)
            if row['status'] in FINAL: return value  # Late cancel/duplicate result never resurrect a task.
            data={**json.loads(row['data']),**patch}
            current=status or row['status']
            order={'queued':0,'dispatching':1,'delivered':2,'received':3,'waiting':4,'running':5,
                   'cancelling':6,'delivery-uncertain':7,'cleanup-unconfirmed':8}
            if current not in FINAL and order.get(current,0)<order.get(row['status'],0):
                if not (verified_delivery and row['status']=='delivery-uncertain' and current in {'received','waiting','running'}): current=row['status']
            if row['status']=='cancelling' and current not in FINAL|{'cleanup-unconfirmed'}: current='cancelling'
            conn.execute(update(tasks).where(tasks.c.id==task_id).values(status=current,data=json.dumps(data),updated=time.time(),revision=row['revision']+1))
            return {**data,'task_id':task_id,'status':current,'revision':row['revision']+1}

    def request_cancel(self, owner, task_id):
        # Use the same owner -> task lock order as dispatch admission. The
        # queued decision is made from the locked row, never an HTTP snapshot.
        with self.engine.begin() as conn:
            conn.execute(select(users.c.id).where(users.c.id==owner).with_for_update())
            row=conn.execute(select(tasks).where(tasks.c.id==task_id,tasks.c.owner==owner).with_for_update()).mappings().first()
            if not row: raise HTTPException(404,'Task not found')
            if row['status'] in FINAL: return self.task_value(row)
            data={**json.loads(row['data']),'cancel_requested':True}
            if row['status']=='queued':
                status='cancelled'
                data.update(result={'ok':False,'cancelled':True,'cleanup_confirmed':True},execution_status='idle')
            else:
                # Admission commits dispatching before any network delivery.
                # Even uncertain delivery needs the Bridge's exit evidence.
                status='cleanup-unconfirmed' if row['status']=='cleanup-unconfirmed' else 'cancelling'
            conn.execute(update(tasks).where(tasks.c.id==task_id).values(status=status,data=json.dumps(data),updated=time.time(),revision=row['revision']+1))
            return {**data,'task_id':task_id,'status':status,'revision':row['revision']+1}

    def admit_dispatch(self, owner, task_id):
        with self.engine.begin() as conn:
            conn.execute(select(users.c.id).where(users.c.id==owner).with_for_update())
            row=conn.execute(select(tasks).where(tasks.c.id==task_id,tasks.c.owner==owner).with_for_update()).mappings().first()
            if not row or row['status']!='queued' or json.loads(row['data']).get('cancel_requested'): return False
            conn.execute(select(devices.c.id).where(devices.c.id==row['device']).with_for_update())
            active=tasks.c.status.not_in(FINAL|{'queued'})
            total=conn.execute(select(func.count()).select_from(tasks).where(tasks.c.owner==owner,active)).scalar()
            count=conn.execute(select(func.count()).select_from(tasks).where(tasks.c.device==row['device'],active)).scalar()
            if total>=4 or count>=2: return False
            conn.execute(update(tasks).where(tasks.c.id==task_id).values(status='dispatching',updated=time.time(),revision=tasks.c.revision+1))
            return True

    def cleanup(self, days=7):
        with self.engine.begin() as conn:
            conn.execute(delete(tasks).where(tasks.c.status.in_(FINAL),tasks.c.updated<time.time()-days*86400))
            conn.execute(delete(pairs).where(pairs.c.expires<time.time()-86400))
            conn.execute(delete(rates).where(rates.c.window<int(time.time())//60-1440))
            conn.execute(delete(credentials).where(credentials.c.expires<time.time()-86400))

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description='Explicit Hub schema migration; never touches other databases')
    parser.add_argument('action',choices=['migrate','check'])
    args=parser.parse_args(); store=HubStore.production()
    store.migrate() if args.action=='migrate' else store.ready()
    print('Hub database schema v1 ready')
