"""Opt-in native MySQL tests; only a dedicated EMPTY station_hub_test* schema.

No production fallback and no touching other schemas. CI supplies an ephemeral
MySQL 8.4 service; local runs without its URL are explicitly skipped.
"""
import json
import os
import sys
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'device'))
from sqlalchemy import create_engine,inspect,select,delete
from sqlalchemy.engine import make_url
from fastapi import HTTPException
from hub_store import HubStore,metadata
URL=os.getenv('HUB_TEST_MYSQL_URL','')
@unittest.skipUnless(URL,'Dedicated native MySQL unavailable; injected SQLite is not native MySQL acceptance')
class MySQLNativeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        parsed=make_url(URL)
        if parsed.get_backend_name()!='mysql' or not (parsed.database or '').startswith('station_hub_test') or parsed.username=='root':
            raise RuntimeError('Tests require a dedicated station_hub_test* schema and non-root account')
        cls.engine=create_engine(URL,pool_pre_ping=True)
        if inspect(cls.engine).get_table_names(): raise RuntimeError('Refuse to use a nonempty test database')
        cls.store=HubStore(cls.engine,'isolated-mysql-test-secret-only-1234567890'); cls.store.migrate(); cls.store.ready()

    @classmethod
    def tearDownClass(cls):
        # Only tables created by this test in the verified-empty dedicated schema.
        metadata.drop_all(cls.engine); cls.engine.dispose()

    def identity(self): return self.store.identity('test-'+uuid.uuid4().hex[:14],'test-password-123',register=True)
    def paired(self):
        user=self.identity(); code=self.store.create_pair(user['owner_id']); device=str(uuid.uuid4())
        pair=self.store.claim_pair(code['pair_code'],device,'native-mysql'); return user,pair

    def test_atomic_pair_and_scoped_recovery(self):
        user=self.identity(); code=self.store.create_pair(user['owner_id'])
        def race(_):
            try: return self.store.claim_pair(code['pair_code'],str(uuid.uuid4()),'race')
            except HTTPException as exc: return exc.status_code
        with ThreadPoolExecutor(4) as pool: values=list(pool.map(race,range(4)))
        self.assertEqual(sum(isinstance(value,dict) for value in values),1); self.assertEqual(values.count(409),3)
        restored=self.store.identity(user['login'],'new-password-123',recovery=user['recovery_code'])
        with self.assertRaises(HTTPException): self.store.authenticate(user['control_token'],'control')
        self.assertEqual(self.store.authenticate(restored['control_token'],'control')['owner'],user['owner_id'])

    def test_concurrent_idempotency_queue_rate_and_durable_restore(self):
        user,pair=self.paired(); owner=user['owner_id']; device=pair['device_id']; agent=device+'-codex'
        payload={'objective':'测试中文'*3000,'provider':'codex','session_id':'native-fixture','cwd':'fixture','remote_target':{'device_id':device}}
        key=str(uuid.uuid4())
        with ThreadPoolExecutor(4) as pool: values=list(pool.map(lambda _:self.store.submit(owner,device,agent,key,payload),range(4)))
        self.assertEqual(len({value[0]['task_id'] for value in values}),1); self.assertEqual(sum(value[1] for value in values),1)
        task=values[0][0]['task_id']; self.store.transition(owner,task,'running')
        self.store.transition(owner,task,'cancelling',cancel_requested=True)
        # Re-open real MySQL engine, without relying on memory/container files.
        reopened=HubStore(create_engine(URL,pool_pre_ping=True),'isolated-mysql-test-secret-only-1234567890')
        try:
            reopened.ready(); self.assertEqual(reopened.by_key(owner,key)['status'],'cancelling')
            self.assertEqual(reopened.get_task(owner,task)['objective'],payload['objective'])
            reopened.transition(owner,task,'cancelled',result={'cleanup_confirmed':True,'cancelled':True})
            self.assertFalse(reopened.submit(owner,device,agent,key,payload)[1])
        finally: reopened.engine.dispose()
        rate_key=uuid.uuid4().hex
        def rate(_):
            try: self.store.rate(rate_key,3); return 200
            except HTTPException as exc: return exc.status_code
        with ThreadPoolExecutor(8) as pool: result=list(pool.map(rate,range(8)))
        self.assertEqual(result.count(200),3); self.assertEqual(result.count(429),5)

    def test_logical_backup_restore_in_dedicated_database(self):
        user,pair=self.paired(); snapshot={}
        with self.engine.begin() as conn:
            for table in metadata.sorted_tables: snapshot[table.name]=[dict(row) for row in conn.execute(select(table)).mappings()]
            for table in reversed(metadata.sorted_tables): conn.execute(delete(table))
            for table in metadata.sorted_tables:
                if snapshot[table.name]: conn.execute(table.insert(),snapshot[table.name])
        self.store.ready(); self.assertEqual(self.store.authenticate(user['control_token'],'control')['owner'],user['owner_id'])
        self.assertEqual(self.store.authenticate(pair['device_token'],'device')['device'],pair['device_id'])
        # This verifies app data round-trip; platform snapshot/mysqldump restore remains an operator acceptance.

    def test_cancel_and_dispatch_admission_share_native_transaction_locks(self):
        user,pair=self.paired(); owner=user['owner_id']; device=pair['device_id']; agent=device+'-codex'
        payload={'objective':'race fixture','provider':'codex','session_id':'native-fixture','cwd':'fixture'}
        for attempt in range(16):
            with self.subTest(attempt=attempt):
                task,_=self.store.submit(owner,device,agent,str(uuid.uuid4()),payload)
                barrier=threading.Barrier(2)
                def dispatch(): barrier.wait(5); return self.store.admit_dispatch(owner,task['task_id'])
                def cancel(): barrier.wait(5); return self.store.request_cancel(owner,task['task_id'])
                with ThreadPoolExecutor(2) as pool:
                    admission=pool.submit(dispatch); cancellation=pool.submit(cancel)
                    admitted=admission.result(10); row=cancellation.result(10)
                if admitted:
                    self.assertEqual(row['status'],'cancelling')
                    self.assertIsNot(row.get('result',{}).get('cleanup_confirmed'),True)
                    self.store.transition(owner,task['task_id'],'cancelled',result={'cancelled':True,'cleanup_confirmed':True})
                else:
                    self.assertEqual(row['status'],'cancelled'); self.assertTrue(row['result']['cleanup_confirmed'])
                self.assertFalse(self.store.admit_dispatch(owner,task['task_id']))
                self.assertEqual(self.store.request_cancel(owner,task['task_id'])['status'],'cancelled')

if __name__=='__main__': unittest.main()
