"""Production discovery/RPC/adapter tests with a real metadata-only stdio fixture.

No official account, user history or model is accessed. OS guardian/transport
regressions remain in test_remote_repairs/test_public_remote.
"""
import contextlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'device'),str(ROOT/'examples')]
import codex_desktop as desktop
import codex_cli_adapter as adapter
from bridge_settings import codex_access,provider_config
from desktop_agent import DesktopBridge

FIXTURE=r'''
import json,sys,os
from pathlib import Path
db=Path(os.environ['DESKTOP_FIXTURE_DB']); data=json.loads(db.read_text())
args=sys.argv[1:]
if args==['--version']: print('codex-cli 0.162.0-alpha.17.2')
elif args==['exec','resume','--help']: print('resume [SESSION_ID]')
elif args==['login','status']: print('Logged in using ChatGPT')
elif args[:2]==['app-server','generate-json-schema']:
 output=Path(args[args.index('--out')+1]);output.mkdir(exist_ok=True)
 fields=['sourceKinds'] if data.get('old_schema') else ['sourceKinds','useStateDbOnly']
 for name,keys in [('ThreadListParams.json',fields),('ThreadReadParams.json',['threadId','includeTurns'])]:
  (output/name).write_text(json.dumps({'properties':{key:{} for key in keys}}))
elif args[0]=='app-server':
 for line in sys.stdin:
  request=json.loads(line);method=request['method'];p=request.get('params',{})
  with Path(os.environ['DESKTOP_FIXTURE_CALLS']).open('a') as f:f.write(json.dumps(request)+'\n')
  if method=='initialized':continue
  if method=='initialize': result={'codexHome':data['home']}
  elif method=='thread/list':
   data=json.loads(db.read_text());rows=[r for r in data['threads'] if r['source'] in p['sourceKinds'] and bool(r.get('archived'))==bool(p.get('archived'))]
   offset=int(p.get('cursor') or '0');limit=min(2,p['limit'])
   result={'data':rows[offset:offset+limit],'nextCursor':str(offset+limit) if len(rows)>offset+limit else None}
  elif method=='thread/read':
   data=json.loads(db.read_text());rows=[r for r in data['threads'] if r['id']==p['threadId']]
   if not rows: print(json.dumps({'id':request['id'],'error':{'message':'session missing'}}),flush=True);continue
   result={'thread':rows[0]}
  else:raise RuntimeError('Query attempted a mutating method: '+method)
  print(json.dumps({'id':request['id'],'result':result}),flush=True)
elif args[0]=='exec':
 task_prompt=sys.stdin.read();native=next(arg for arg in args if len(arg)==36 and arg.count('-')==4)
 with Path('executions.jsonl').open('a') as f:f.write(json.dumps({'native':native,'cwd':os.getcwd(),'command':args})+'\n')
 if data.get('fail'):print('thread-store conflict: active writer',file=sys.stderr);sys.exit(1)
 if data.get('wrong_id'):native='wrong-native-id'
 print(json.dumps({'type':'thread.started','thread_id':native}))
 Path(args[args.index('--output-last-message')+1]).write_text('desktop feedback')
else:raise RuntimeError(args)
'''

class DesktopTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='bridge-desktop-fixture-');self.root=Path(self.temp.name)
        self.home=self.root/'codex';self.project=self.root/'original-project';self.project.mkdir()
        self.native=str(uuid.uuid4());sessions=self.home/'sessions';sessions.mkdir(parents=True)
        self.rollout=sessions/'unrelated-filename.jsonl'
        self.rollout.write_text(json.dumps({'type':'session_meta','payload':{'id':self.native,'cwd':str(self.project)}})+'\n',encoding='utf-8')
        self.thread={'id':self.native,'name':'Desktop test','originator':'Codex Desktop','source':'vscode',
            'cwd':str(self.project),'path':str(self.rollout),'historyMode':'paginated','status':{'type':'notLoaded'}}
        self.db=self.root/'catalog.json';self.calls=self.root/'calls.jsonl';self.fixture=self.root/'runtime.py';self.fixture.write_text(FIXTURE,encoding='utf-8')
        self.binary=self.root/'codex-component';self.binary.touch();self.update([self.thread])
        self.env=patch.dict(os.environ,{'DESKTOP_FIXTURE_DB':str(self.db),'DESKTOP_FIXTURE_CALLS':str(self.calls),
            'POCKET_VIBE_STATE_DIR':str(self.root/'state')});self.env.start()
        original=subprocess.Popen
        def owned_fixture(command,*args,**kwargs):
            if command and str(command[0])==str(self.binary):command=[sys.executable,str(self.fixture),*command[1:]]
            return original(command,*args,**kwargs)
        self.process=patch('subprocess.Popen',side_effect=owned_fixture);self.process.start()

    def tearDown(self):self.process.stop();self.env.stop();self.temp.cleanup()
    def update(self,rows,**values):self.db.write_text(json.dumps({'home':str(self.home),'threads':rows,**values}),encoding='utf-8')
    def info(self):return desktop.probe_runtime(str(self.binary))

    def test_desktop_only_not_in_path_queries_explicit_sources_without_history_or_turn(self):
        with patch.object(desktop,'running_runtimes',return_value=[str(self.binary)]),patch.object(desktop,'installation_candidates',return_value=[]):
            info=desktop.discover_runtime()
        self.assertEqual(info['source'],'running-desktop');self.assertTrue(info['logged_in'])
        rows=desktop.discover_desktop_sessions(info['binary'],True);self.assertEqual(rows[0]['session_id'],self.native)
        self.assertEqual(rows[0]['cwd'],str(self.project));self.assertTrue(rows[0]['available'])
        requests=[json.loads(line) for line in self.calls.read_text().splitlines()]
        self.assertTrue(all(r['method'] in {'initialize','initialized','thread/list','thread/read'} for r in requests))
        self.assertTrue(all(r['params']['useStateDbOnly'] and 'vscode' in r['params']['sourceKinds'] and 'appServer' in r['params']['sourceKinds'] for r in requests if r['method']=='thread/list'))
        self.assertTrue(all(r['params']['includeTurns'] is False for r in requests if r['method']=='thread/read'))

    def test_candidate_priority_version_update_and_manual_configuration_preserved(self):
        other=self.root/'new-component';other.touch()
        def probe(path):return {'binary':str(path),'version':'0.163.0' if Path(path)==other else '0.162.0','logged_in':True}
        with patch.object(desktop,'probe_runtime',side_effect=probe),patch.object(desktop,'running_runtimes',return_value=[str(self.binary)]),patch.object(desktop,'installation_candidates',return_value=[other]):
            self.assertEqual(desktop.discover_runtime()['binary'],str(self.binary))
            self.binary.unlink()  # An update invalidated the old path.
            self.assertEqual(desktop.discover_runtime()['binary'],str(other))

            self.assertEqual(desktop.discover_runtime(str(other))['source'],'manual')
            with patch.object(desktop,'probe_runtime',side_effect=ValueError('manual invalid')):
                with self.assertRaisesRegex(ValueError,'manual invalid'):desktop.discover_runtime(str(other))
        self.assertEqual(codex_access({'binary':'explicit-cli'}),'cli')
        for system,mode in [('win32','desktop'),('darwin','desktop'),('linux','cli')]:
            with patch('bridge_settings.sys.platform',system):self.assertEqual(codex_access({}),mode)
        self.assertEqual(codex_access({'binary':'manual-desktop','access':'desktop'}),'desktop')
        with patch.object(desktop,'probe_runtime',side_effect=probe),patch.object(desktop,'running_runtimes',return_value=[]),patch.object(desktop,'installation_candidates',return_value=[other]):
            self.assertEqual(desktop.discover_runtime()['binary'],str(other))
        self.binary.touch()
        with patch.object(desktop,'probe_runtime',side_effect=probe),patch.object(desktop,'running_runtimes',return_value=[]),patch.object(desktop,'installation_candidates',return_value=[self.binary,other]):
            self.assertEqual(desktop.discover_runtime()['binary'],str(other))

    def test_older_runtime_schema_is_rejected_before_any_catalog_query_or_repair(self):
        self.update([self.thread],old_schema=True)
        with self.assertRaisesRegex(ValueError,'只读会话目录'):self.info()
        self.assertFalse(self.calls.exists())

    def test_pagination_dedup_real_cwd_cloud_archived_invalid_rollout_and_no_project_guess(self):
        self.update([self.thread,self.thread,{**self.thread,'id':str(uuid.uuid4()),'path':None,'cwd':''},
            {**self.thread,'id':str(uuid.uuid4()),'path':None},
            {**self.thread,'id':str(uuid.uuid4()),'cwd':str(self.root)},
            {**self.thread,'id':str(uuid.uuid4()),'archived':True}])
        rows=desktop.discover_desktop_sessions(str(self.binary),True)
        self.assertEqual(len(rows),5);self.assertEqual(sum(r['available'] for r in rows),1)
        self.assertEqual(next(r for r in rows if r['available'])['cwd'],str(self.project))
        self.assertTrue(any('恢复数据' in r['error'] for r in rows));self.assertTrue(any('项目目录' in r['error'] for r in rows))
        self.assertTrue(any('ID不匹配' in r['error'] for r in rows))

    def test_occupancy_unknown_handoff_active_response_and_stale_history_after_cancel(self):
        row=desktop.discover_desktop_sessions(str(self.binary),False)[0]
        self.assertFalse(row['available']);self.assertIn('占用未知',row['error'])
        # A new server's notLoaded does not establish global idle.
        self.assertEqual(row['native_client_status'],'unknown')
        conn=sqlite3.connect(self.home/'thread_history_1.sqlite')
        conn.execute('create table thread_turns(thread_id text,status text,started_at integer)')
        conn.execute('insert into thread_turns values(?,?,?)',(self.native,'inProgress',1));conn.commit();conn.close()
        # A killed Bridge CLI may leave this historical status indefinitely.
        # It neither proves a GUI writer nor overrides our guardian exit proof.
        self.assertTrue(desktop.discover_desktop_sessions(str(self.binary),True)[0]['available'])
        self.assertEqual(desktop.discover_desktop_sessions(str(self.binary),True)[0]['native_client_status'],'unknown')
        self.assertTrue(self.execute()['ok'])
        self.update([{**self.thread,'status':{'type':'active'}}])
        self.assertFalse(desktop.discover_desktop_sessions(str(self.binary),True)[0]['available'])
        with self.assertRaisesRegex(ValueError,'执行中'):desktop.validate_desktop_target(str(self.binary),self.native,str(self.project),True)

    def execute(self,allow_failure=False):
        task={'objective':'fixture','session_id':self.native,'cwd':str(self.project),'turn_options':{'model':'controller-must-not-override'}}
        with patch.object(sys,'argv',['adapter','--desktop','--binary',str(self.binary),'--desktop-control-confirmed','--sandbox','workspace-write']),patch.object(sys,'stdin',io.TextIOWrapper(io.BytesIO(json.dumps(task).encode()))),contextlib.redirect_stdout(io.StringIO()) as output,contextlib.chdir(self.project):
            try:adapter.main()
            except SystemExit:
                if not allow_failure:raise
        return json.loads(output.getvalue())

    def test_production_adapter_two_turns_keep_native_id_cwd_permissions_and_remote_model_defaults(self):
        for _ in range(2):self.assertTrue(self.execute()['ok'])
        records=[json.loads(line) for line in (self.project/'executions.jsonl').read_text().splitlines()]
        self.assertEqual([r['native'] for r in records],[self.native,self.native])
        self.assertTrue(all(Path(r['cwd']).samefile(self.project) for r in records))
        self.assertTrue(all('--last' not in r['command'] and '--model' not in r['command'] for r in records))
        self.assertTrue(all(r['command'].index('--sandbox')<r['command'].index('resume') for r in records))

    def test_writer_conflict_no_retry_no_new_thread_and_identity_failure_is_not_success(self):
        self.update([self.thread],fail=True)
        failed=self.execute(allow_failure=True)
        self.assertFalse(failed['ok']);self.assertIn('active writer',failed['error'])
        from task_journal import feedback
        self.assertIn('active writer',feedback({'ok':False,'cleanup_confirmed':True,'json':failed})['error'])
        self.assertEqual(len((self.project/'executions.jsonl').read_text().splitlines()),1)
        self.update([self.thread],wrong_id=True)
        with self.assertRaises(SystemExit):self.execute()
        self.assertEqual(len((self.project/'executions.jsonl').read_text().splitlines()),2)

    def test_invalidated_reference_rechecked_before_execution_no_fallback(self):
        self.update([])
        with self.assertRaisesRegex(RuntimeError,'session missing'):self.execute()
        self.assertFalse((self.project/'executions.jsonl').exists())
        self.update([self.thread])
        with self.assertRaisesRegex(ValueError,'项目目录'):desktop.validate_desktop_target(str(self.binary),self.native,str(self.root),True)

    def test_provider_configs_and_bridge_catalog_preserve_existing_cli_claude_and_local_metadata(self):
        cli=provider_config('codex','manual-cli',[str(self.project)],'read-only')
        self.assertNotIn('--desktop',cli['command']);self.assertNotIn('codex_access',cli)
        claude=provider_config('claude','manual-claude',[str(self.project)],'workspace-write')
        self.assertIn('--permission-mode',claude['command']);self.assertNotIn('--desktop',claude['command'])
        config=provider_config('codex','',[str(self.project)],'workspace-write',access='desktop',desktop_confirmed=True,runtime=self.info())
        self.assertIn('--desktop-auto',config['command']);self.assertIn('--desktop-control-confirmed',config['command'])
        self.assertNotIn('--binary',config['command']);self.assertNotIn('',config['command'])
        path=self.root/'config.json';path.write_text(json.dumps(config),encoding='utf-8')
        bridge=DesktopBridge('unused','fixture',local_agent_config=str(path))
        # Desktop execution/catalog now comes ONLY from the same resident
        # service. This older metadata fixture isn't shared-GUI acceptance.
        import codex_shared
        async def shared_scan(*args): return [desktop.reference(self.thread,str(self.home),True)]
        with patch.object(codex_shared,'scan_async',shared_scan):catalog=bridge._scan_sessions()
        self.assertEqual(catalog['status'],'ready');row=catalog['sessions'][0]
        self.assertTrue(row['available']);self.assertEqual(row['session_id'],self.native)
        self.assertNotIn('runtime_info',row);self.assertNotIn('path',row);self.assertNotIn('source',row)
        self.assertIn('Codex 桌面版',row['title'])
        self.assertIn('Codex 桌面版',desktop.reference({**self.thread,'name':'x'*300},str(self.home),True)['title'])
        self.assertNotIn('auth',json.dumps(catalog))

    @unittest.skipUnless(os.name=='nt','Windows extended-length paths')
    def test_extended_length_paths_resolve_to_same_codex_home(self):
        row=desktop.reference({**self.thread,'path':'\\\\?\\'+str(self.rollout)},str(self.home),True)
        self.assertTrue(row['available'],row['error'])

if __name__=='__main__':unittest.main()
