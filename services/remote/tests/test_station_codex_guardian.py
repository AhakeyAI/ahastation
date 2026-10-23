"""Real owned-process tests with a deterministic app-server protocol fixture."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
import shutil
from pathlib import Path
DEVICE=Path(__file__).resolve().parents[1]/'device'

SERVER=r'''
import json,sys,subprocess
thread='native-fixture-thread';turn='native-fixture-turn'
def send(v):print(json.dumps(v),flush=True)
for raw in sys.stdin:
 m=json.loads(raw);method=m.get('method');p=m.get('params') or {};identity=m.get('id')
 if method=='initialize':send({'id':identity,'result':{'userAgent':'fixture/0.144.1','codexHome':'fixture'}})
 elif method=='account/read':send({'id':identity,'result':{'requiresOpenaiAuth':False,'account':{'type':'fixture'}}})
 elif method=='model/list':send({'id':identity,'result':{'data':[{'model':'fixture-model','isDefault':True}]}})
 elif method in ('thread/start','thread/resume'):send({'id':identity,'result':{'thread':{'id':thread}}})
 elif method=='turn/start':
  subprocess.Popen([sys.executable,'-c',"import time;time.sleep(2);open('late-child.txt','w').write('must not survive')"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  send({'id':identity,'result':{'turn':{'id':turn}}})
  text=p['input'][0]['text']
  if 'approval' in text:send({'id':10000,'method':'item/fileChange/requestApproval','params':{'threadId':thread,'turnId':turn,'reason':'write two files'}})
  elif 'wait' not in text:
   send({'method':'item/agentMessage/delta','params':{'threadId':thread,'delta':'completed fixture'}})
   send({'method':'turn/completed','params':{'threadId':thread,'turn':{'id':turn,'status':'completed'}}})
 elif method=='turn/interrupt':
  send({'id':identity,'result':{}});send({'method':'turn/completed','params':{'threadId':thread,'turn':{'id':turn,'status':'interrupted'}}})
 elif identity==10000:
  send({'method':'turn/completed','params':{'threadId':thread,'turn':{'id':turn,'status':'completed'}}})
'''

@unittest.skipUnless(sys.platform=='win32' or sys.platform.startswith('linux'),'native containment tests')
class GuardianTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='station-guardian-');self.root=Path(self.temp.name)
        self.server=self.root/'server.py';self.server.write_text(SERVER,encoding='utf-8')
        self.env={**os.environ,'POCKET_VIBE_STATE_DIR':str(self.root/'state'),'PYTHONPATH':str(DEVICE)}
        self.identity=str(uuid.uuid4());self.request={'operation':'worker-run','executionId':self.identity,'command':[sys.executable,str(self.server)],
            'cwd':str(self.root),'objective':'complete whole fixture','permission':'workspace-write'}
    def tearDown(self):
        if os.name=='nt':
            self.assertEqual(self.root.parent,Path(tempfile.gettempdir()));self.assertTrue(self.root.name.startswith('station-guardian-'))
            shutil.rmtree('\\\\?\\'+str(self.root))
        self.temp.cleanup()
    def invoke(self,request):
        return subprocess.run([sys.executable,str(DEVICE/'station_native.py')],input=json.dumps(request,ensure_ascii=False)+'\n',text=True,encoding='utf-8',capture_output=True,timeout=20,env=self.env)
    def result(self,process):
        rows=[json.loads(line) for line in process.stdout.splitlines()]
        self.assertEqual(process.returncode,0,process.stderr+'\n'+process.stdout)
        return next(row['value'] for row in rows if row['type']=='result')
    def test_completion_proves_entire_owned_tree_exit_and_duplicate_never_runs_again(self):
        result=self.result(self.invoke(self.request));self.assertTrue(result['ok']);self.assertTrue(result['cleanup_confirmed'])
        time.sleep(2.2);self.assertFalse((self.root/'late-child.txt').exists())
        duplicate=self.result(self.invoke(self.request));self.assertEqual(duplicate,result)
        state=self.result(self.invoke({'operation':'worker-inspect','executionId':self.identity}))
        self.assertEqual(state['result'],result);self.assertEqual(state['threadId'],'native-fixture-thread')
    def test_H10_normal_native_end_after_interrupt_request_keeps_actual_result(self):
        self.request['objective']='wait for exact stop race'
        self.server.write_text(SERVER.replace("'status':'interrupted'", "'status':'completed'"),encoding='utf-8')
        process=subprocess.Popen([sys.executable,str(DEVICE/'station_native.py')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=self.env)
        process.stdin.write(json.dumps(self.request)+'\n');process.stdin.flush()
        try:
            while True:
                line=process.stdout.readline();self.assertTrue(line,'guardian ended before native identity')
                row=json.loads(line)
                if row['type']=='identity' and row.get('turnId'):break
            stop=self.result(self.invoke({'operation':'worker-stop','executionId':self.identity}))
            self.assertTrue(stop['cleanup_confirmed']);self.assertTrue(stop['ok']);self.assertFalse(stop['cancelled']);self.assertEqual(stop['turnOutcome'],'completed')
            rows=[json.loads(line) for line in process.stdout];result=next(r['value'] for r in rows if r['type']=='result')
            self.assertEqual(result,stop);process.wait(timeout=10)
            repeated=self.result(self.invoke({'operation':'worker-stop','executionId':self.identity}));self.assertEqual(repeated,result)
        finally:
            if process.poll() is None:process.kill();process.wait(timeout=10)
            for stream in (process.stdin,process.stdout,process.stderr):stream.close()
    def test_recovery_fences_unstarted_execution_and_delayed_run_cannot_launch(self):
        state=self.result(self.invoke({'operation':'worker-inspect','executionId':self.identity,'sealUnstarted':True}))
        self.assertTrue(state['result']['not_started']);self.assertFalse(state['result']['ok']);self.assertTrue(state['result']['cleanup_confirmed'])
        delayed=self.result(self.invoke(self.request));self.assertEqual(delayed,state['result'])
        self.assertFalse((self.root/'state/remote/tasks/codex'/self.identity/'station-request.json').exists())
        repeated=self.result(self.invoke({'operation':'worker-inspect','executionId':self.identity,'sealUnstarted':True}))
        self.assertEqual(repeated,state)
    def test_recorded_unknown_launch_is_never_sealed_or_falsely_completed(self):
        journal=self.root/'state/remote/tasks/codex'/self.identity;journal.mkdir(parents=True)
        (journal/'launch-intent').write_text('',encoding='utf-8')
        state=self.result(self.invoke({'operation':'worker-inspect','executionId':self.identity,'sealUnstarted':True}))
        self.assertIsNone(state['result'])
        delayed=self.invoke(self.request);self.assertIn('Original launch already recorded',delayed.stdout)
        self.assertFalse((journal/'station-request.json').exists())
    @unittest.skipUnless(os.name=='nt','Windows file share boundary')
    def test_journal_retries_transient_windows_read_and_atomic_replace_locks(self):
        code=r'''
import ctypes,json,sys,threading,time
from pathlib import Path
from task_journal import write_json,read_json
path=Path(sys.argv[1]);write_json(path,{'original':True})
k=ctypes.WinDLL('kernel32',use_last_error=True)
k.CreateFileW.restype=ctypes.c_void_p
k.CreateFileW.argtypes=[ctypes.c_wchar_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p]
k.CloseHandle.argtypes=[ctypes.c_void_p]
def lock(share):
 h=k.CreateFileW(str(path),0x80000000,share,None,3,0,None)
 assert h and h!=ctypes.c_void_p(-1).value
 thread=threading.Thread(target=lambda:(time.sleep(.18),k.CloseHandle(h)));thread.start();return thread
thread=lock(0);assert read_json(path)=={'original':True};thread.join()
thread=lock(1);write_json(path,{'replacement':True});thread.join();assert read_json(path)=={'replacement':True}
print('read and replacement locks handled without losing the original record')
'''
        result=subprocess.run([sys.executable,'-c',code,str(self.root/'locked.json')],env=self.env,text=True,capture_output=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr);self.assertIn('without losing',result.stdout)
    def test_long_windows_journal_path_keeps_atomic_receipt_and_stop_usable(self):
        self.env['POCKET_VIBE_STATE_DIR']=str(self.root/('long-state-'+'x'*65)/('owned-'+'y'*65))
        self.assertGreater(len(self.env['POCKET_VIBE_STATE_DIR'])+120,260)
        result=self.result(self.invoke(self.request));self.assertTrue(result['ok']);self.assertTrue(result['cleanup_confirmed'])
        stopped=self.result(self.invoke({'operation':'worker-stop','executionId':self.identity}))
        self.assertEqual(stopped,result)
    def test_stop_marker_reaches_exact_owned_turn_and_requires_real_cleanup(self):
        self.request['objective']='wait for exact stop'
        process=subprocess.Popen([sys.executable,str(DEVICE/'station_native.py')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=self.env)
        process.stdin.write(json.dumps(self.request)+'\n');process.stdin.flush()
        try:
            deadline=time.monotonic()+10
            while time.monotonic()<deadline:
                line=process.stdout.readline();self.assertTrue(line,'Guardian exited before native turn')
                if json.loads(line).get('turnId'):break
            stopped=self.result(self.invoke({'operation':'worker-stop','executionId':self.identity}))
            self.assertTrue(stopped['cleanup_confirmed']);self.assertTrue(stopped['cancelled'])
            process.wait(timeout=10)
            time.sleep(2.2);self.assertFalse((self.root/'late-child.txt').exists())
        finally:
            if process.poll() is None:process.kill();process.wait(timeout=10)
            for stream in (process.stdin,process.stdout,process.stderr):stream.close()
    def test_protocol_mismatch_never_starts_a_native_turn(self):
        self.server.write_text(SERVER.replace('fixture/0.144.1','fixture/999.0.0'),encoding='utf-8')
        result=self.result(self.invoke(self.request));self.assertFalse(result['ok']);self.assertTrue(result['cleanup_confirmed'])
        self.assertIn('incompatible',result['error']);self.assertFalse((self.root/'late-child.txt').exists())
    def test_utf8_chinese_objective_survives_windows_packaged_stdio_boundary(self):
        self.request['objective']='中文任务：生成两个文件并验证 UTF-8 😀'
        result=self.result(self.invoke(self.request));self.assertTrue(result['ok'])
        saved=json.loads((self.root/'state/remote/tasks/codex'/self.identity/'station-request.json').read_text(encoding='utf-8'))
        self.assertEqual(saved['objective'],self.request['objective'])

    def test_local_validation_command_preserves_output_and_cleans_owned_descendants(self):
        self.request.update(operation='worker-check',command=[sys.executable,'-c',
            "import subprocess,sys;subprocess.Popen([sys.executable,'-c',\"import time;time.sleep(2);open('late-child.txt','w').write('bad')\"]);print('actual-check-passed')"])
        result=self.result(self.invoke(self.request));self.assertTrue(result['ok']);self.assertTrue(result['cleanup_confirmed'])
        self.assertIn('actual-check-passed',result['json']['last_message'])
        time.sleep(2.2);self.assertFalse((self.root/'late-child.txt').exists())
        self.assertEqual(result['exitCode'],0)
    def test_H11_stop_before_validation_invocation_never_starts_the_command(self):
        journal=self.root/'state/remote/tasks/codex'/self.identity;journal.mkdir(parents=True)
        (journal/'cancel.json').write_text('{}',encoding='utf-8')
        self.request.update(operation='worker-check',command=[sys.executable,'-c',"open('must-not-start.txt','w').write('bad')"])
        result=self.result(self.invoke(self.request));self.assertTrue(result['not_started']);self.assertTrue(result['cleanup_confirmed']);self.assertFalse((self.root/'must-not-start.txt').exists())
    def test_selected_image_input_reaches_the_turn_without_enabling_file_tools(self):
        image=self.root/'selected.png';image.write_bytes(b'fixture-image')
        self.server.write_text(SERVER.replace("text=p['input'][0]['text']","open('input.json','w').write(json.dumps(p['input']));text=p['input'][0]['text']"),encoding='utf-8')
        self.request.update(images=[str(image)],textOnly=True)
        result=self.result(self.invoke(self.request));self.assertTrue(result['ok'])
        inputs=json.loads((self.root/'input.json').read_text());self.assertEqual(inputs[1],{'type':'localImage','path':str(image.resolve())})
    def test_image_outside_owned_workspace_never_reaches_a_turn(self):
        self.request['images']=[str(self.root.parent/'private.png')]
        result=self.result(self.invoke(self.request));self.assertFalse(result['ok']);self.assertTrue(result['cleanup_confirmed']);self.assertIn('outside',result['error'])

    def test_native_approval_single_decision_is_reported_after_forwarding(self):
        self.request['objective']='approval'
        process=subprocess.Popen([sys.executable,str(DEVICE/'station_native.py')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=self.env)
        process.stdin.write(json.dumps(self.request)+'\n');process.stdin.flush()
        try:
            while True:
                row=json.loads(process.stdout.readline())
                if row['type']=='approval':break
            self.result(self.invoke({'operation':'worker-approval','executionId':self.identity,'approvalId':row['id'],'decision':'allow'}))
            rows=[json.loads(line) for line in process.stdout]
            self.assertEqual(sum(r['type']=='approval-observed' for r in rows),1)
            self.assertTrue(next(r['value'] for r in rows if r['type']=='result')['cleanup_confirmed'])
            process.wait(timeout=10)
        finally:
            if process.poll() is None:process.kill();process.wait(timeout=10)
            for stream in (process.stdin,process.stdout,process.stderr):stream.close()

    def test_interrupt_ack_without_native_end_still_requires_owned_tree_cleanup(self):
        self.request.update(objective='wait',stopGraceSeconds=.3)
        self.server.write_text(SERVER.replace("send({'id':identity,'result':{}});send({'method':'turn/completed','params':{'threadId':thread,'turn':{'id':turn,'status':'interrupted'}}})","send({'id':identity,'result':{}})"),encoding='utf-8')
        process=subprocess.Popen([sys.executable,str(DEVICE/'station_native.py')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=self.env)
        process.stdin.write(json.dumps(self.request)+'\n');process.stdin.flush()
        try:
            while True:
                row=json.loads(process.stdout.readline())
                if row.get('turnId'):break
            stopped=self.result(self.invoke({'operation':'worker-stop','executionId':self.identity}));self.assertTrue(stopped['cleanup_confirmed']);self.assertTrue(stopped['cancelled'])
            process.wait(timeout=10);time.sleep(2.2);self.assertFalse((self.root/'late-child.txt').exists())
        finally:
            if process.poll() is None:process.kill();process.wait(timeout=10)
            for stream in (process.stdin,process.stdout,process.stderr):stream.close()

if __name__=='__main__':unittest.main()
