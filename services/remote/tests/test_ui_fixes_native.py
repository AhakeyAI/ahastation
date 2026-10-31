import hashlib,json,tempfile,unittest,uuid
from pathlib import Path
from unittest.mock import patch
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'device'))
from station_codex import Guardian,CodexRpcError
from task_journal import feedback,TaskJournal,durable_feedback

class UIFixesNative(unittest.TestCase):
    def test_K01_journal_rejects_copied_attempt_and_old_unbound_result_is_not_completion_proof(self):
        from task_journal import write_json
        with tempfile.TemporaryDirectory() as tmp,patch('task_journal.state_dir',return_value=Path(tmp)):
            original=TaskJournal(str(uuid.uuid4()),'codex')
            original.finish({'ok':True,'turnOutcome':'completed','cleanup_confirmed':True})
            other=TaskJournal(str(uuid.uuid4()),'codex')
            (other.path/'result.json').write_bytes((original.path/'result.json').read_bytes())
            with self.assertRaisesRegex(ValueError,'another execution attempt'):other.result()
            write_json(other.path/'result.json',{'ok':True,'turnOutcome':'completed','cleanup_confirmed':True})
            self.assertNotIn('executionId',other.result())
            write_json(other.path/'station-request.json',{'executionId':original.task_id})
            self.assertNotIn('executionId',other.result())
            write_json(other.path/'station-request.json',{'executionId':other.task_id})
            self.assertEqual(other.result()['executionId'],other.task_id)
    def test_rpc_method_code_message_stage_and_exact_identity_survive(self):
        g=Guardian.__new__(Guardian);g.sequence=0;g.replies={};g.stage='thread-resume';g.thread='original-thread';g.turn=None
        g.send=lambda request:g.replies.update({request['id']:{'error':{'code':-32601,'message':'paginated_threads is not supported yet'}}})
        with self.assertRaises(CodexRpcError) as caught:g.call('thread/resume',{'threadId':'original-thread'})
        d=caught.exception.diagnostic;self.assertEqual(d['code'],-32601);self.assertEqual(d['method'],'thread/resume');self.assertEqual(d['threadId'],'original-thread');self.assertIn('paginated_threads',d['message'])
        self.assertEqual(feedback({'ok':False,'rpcError':d})['rpcError'],d)
    def test_rpc_error_redacts_bearer_without_discarding_original_code(self):
        g=Guardian.__new__(Guardian);g.sequence=0;g.replies={}
        g.send=lambda request:g.replies.update({request['id']:{'error':{'code':-32600,'message':'denied bearer test-secret-credential'}}})
        with self.assertRaises(CodexRpcError) as caught:g.call('thread/resume',{'threadId':'t'})
        self.assertNotIn('test-secret-credential',str(caught.exception));self.assertEqual(caught.exception.diagnostic['code'],-32600)
    def test_feedback_preserves_complete_utf8_not_only_16000_bytes(self):
        text=('中文🧭e\u0301\n'*18000)+'FULL-END';r=feedback({'ok':True,'turnOutcome':'completed','json':{'last_message':text}})
        self.assertEqual(r['json']['last_message'].encode(),text.encode())
    def test_journal_full_bytes_and_final_model_message_survive_reopen(self):
        with tempfile.TemporaryDirectory() as tmp,patch('task_journal.state_dir',return_value=Path(tmp)):
            text=('双机成果🧭e\u0301\n'*12000)+'FULL-END';j=TaskJournal(str(uuid.uuid4()),'codex')
            j.finish({'ok':True,'cleanup_confirmed':True,'turnOutcome':'completed','json':{'last_message':text,'final_messages':[{'itemId':'i','phase':'final_answer','text':text}]}})
            r=TaskJournal(j.task_id,'codex').result();full=Path(r['fullText']['path']).read_bytes();self.assertEqual(full,text.encode());self.assertEqual(r['fullText']['sha256'],hashlib.sha256(full).hexdigest());self.assertTrue(r['contentComplete']);self.assertLess(len(r['json']['last_message']),len(text));self.assertTrue(r['json']['preview'])
            self.assertEqual(json.loads((j.path/'final-model-messages.json').read_text(encoding='utf-8'))[0]['text'],text)
    def test_interrupted_partial_is_retained_without_complete_claim(self):
        with tempfile.TemporaryDirectory() as tmp:
            r=durable_feedback(tmp,{'ok':False,'cancelled':True,'turnOutcome':'interrupted','cleanup_confirmed':True,'json':{'last_message':'partial🧭'}})
            self.assertFalse(r['contentComplete']);self.assertEqual(Path(r['fullText']['path']).read_text(encoding='utf-8'),'partial🧭');self.assertTrue(r['cleanup_confirmed'])
    def test_failed_atomic_save_never_publishes_new_complete_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            durable_feedback(tmp,{'ok':True,'json':{'last_message':'original'}})
            old=(Path(tmp)/'result.json').read_bytes()
            with patch('task_journal.os.replace',side_effect=PermissionError('owned write fault')):
                with self.assertRaises(PermissionError):durable_feedback(tmp,{'ok':True,'json':{'last_message':'new'}})
            self.assertEqual((Path(tmp)/'result.json').read_bytes(),old)
    def test_guardian_accumulates_long_final_output_without_48000_loss(self):
        with tempfile.TemporaryDirectory() as tmp,patch('task_journal.state_dir',return_value=Path(tmp)):
            g=Guardian({'executionId':str(uuid.uuid4())},lambda _:None);text='长🧭e\u0301'*20000+'END'
            for n in range(0,len(text),1000):g.handle({'method':'item/agentMessage/delta','params':{'delta':text[n:n+1000]}})
            self.assertEqual(g.summary,text)
            g.handle({'method':'item/completed','params':{'item':{'id':'final','type':'agentMessage','phase':'final_answer','text':text}}})
            self.assertEqual(g.final_message,text);self.assertEqual(g.final_messages[-1]['text'],text)
    def test_repeated_compact_feedback_cannot_overwrite_the_original_full_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            text='完整正文🧭'*14000+'END';first=durable_feedback(tmp,{'ok':True,'turnOutcome':'completed','json':{'last_message':text,'final_messages':[{'text':text}]}})
            second=durable_feedback(tmp,first)
            self.assertEqual(Path(second['fullText']['path']).read_bytes(),text.encode())
            self.assertEqual(json.loads((Path(tmp)/'final-model-messages.json').read_text(encoding='utf-8'))[0]['text'],text)

    def test_ack_retains_full_reference_after_old_transport_feedback_is_purged(self):
        with tempfile.TemporaryDirectory() as tmp,patch('task_journal.state_dir',return_value=Path(tmp)):
            j=TaskJournal(str(uuid.uuid4()),'codex');j.finish({'ok':True,'cleanup_confirmed':True,'json':{'last_message':'whole body🧭'}});j.ack()
            (j.path/'result.json').unlink();r=j.result();self.assertTrue(r['contentComplete']);self.assertEqual(Path(r['fullText']['path']).read_text(encoding='utf-8'),'whole body🧭')

    def test_resumed_old_turn_completion_cannot_complete_the_new_owned_turn(self):
        with tempfile.TemporaryDirectory() as tmp,patch('task_journal.state_dir',return_value=Path(tmp)):
            g=Guardian({'executionId':str(uuid.uuid4())},lambda _:None);g.thread='same-original-thread';g.stage='thread-resume'
            g.handle({'method':'turn/completed','params':{'threadId':g.thread,'turn':{'id':'old-turn','status':'completed'}}})
            self.assertFalse(g.complete);self.assertEqual(len(g.pending_turn_messages),1)
            g.turn='new-owned-turn';g.stage='turn-running'
            for message in g.pending_turn_messages:g.handle(message)
            self.assertFalse(g.complete)
            g.handle({'method':'turn/completed','params':{'threadId':g.thread,'turn':{'id':g.turn,'status':'completed'}}});self.assertTrue(g.complete)
