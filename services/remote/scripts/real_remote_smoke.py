"""Explicit opt-in paid Codex check: new temp project/native session only.

Uses production adapters, guardian, public Bridge/Hub. DB/transport are isolated
loopback fixtures, not cloud or GUI acceptance. Never changes CLI auth/config.
"""
import argparse
import asyncio
import json
import os
import shutil
import socket
import sys
import tempfile
import time
import uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]; sys.path[:0]=[str(ROOT/'device'),str(ROOT/'examples')]
from bridge_settings import cli_status,provider_config,desktop_runtime
from desktop_agent import LocalAgentRunner
from public_bridge import PublicBridge
from public_hub import create_app
from hub_store import HubStore
from session_runtime import device_id
from sqlalchemy import create_engine
import httpx
import uvicorn

async def main(args):
    if not args.run_paid: raise ValueError('Use --run-paid only with explicit authorization for isolated model calls')
    desktop=bool(args.desktop_session)
    info=desktop_runtime(args.codex or '') if desktop else None
    binary=info['binary'] if desktop else (args.codex or shutil.which('codex'))
    if not binary or not cli_status(binary,'codex')['ok']: raise RuntimeError('Codex login unavailable; no login attempted')
    root=Path(tempfile.mkdtemp(prefix='station-real-public-')); project=root/'project'; project.mkdir()
    if desktop:
        if not args.desktop_project or not args.confirm_desktop_handoff: raise ValueError('Desktop smoke requires an explicitly created isolated desktop project and confirmed handoff')
        project=Path(args.desktop_project).resolve(strict=True)
    os.environ['POCKET_VIBE_STATE_DIR']=str(root/'state')  # Local test identity only; native CLI auth/home untouched.
    config=root/'config.json'; config.write_text(json.dumps(provider_config('codex',args.codex or '' if desktop else binary,[str(project)],'workspace-write',
        access='desktop' if desktop else 'cli',desktop_confirmed=desktop,runtime=info)))
    runner=LocalAgentRunner(str(config))
    initial=await runner.run({'task_id':str(uuid.uuid4()),'payload':{'objective':
        ('Recall the marker from the original desktop turn context (do not read SECOND.md). Create REMOTE_ONE.md containing that marker and REMOTE_ROUND_ONE, each on its own line. Reply with the marker. ' if desktop else 'Create README.md containing exactly REMOTE_ROUND_ONE and a newline. Reply ROUND_ONE_OK. ')
        +'Work only inside this isolated test project; do not touch other directories.',
        'provider':'codex','cwd':str(project),'session_id':args.desktop_session or '',
        'turn_options':{'mode':'resume' if desktop else 'exec','session_id':args.desktop_session or '', 'cwd':str(project)}}})
    (root/'bootstrap-result.json').write_text(json.dumps(initial,ensure_ascii=False,indent=2),encoding='utf-8')
    if not initial.get('ok') or initial.get('cleanup_confirmed') is not True: raise RuntimeError('Initial isolated CLI call failed; evidence: '+str(root/'bootstrap-result.json'))
    native=None
    for line in initial.get('json',{}).get('stdout','').splitlines():
        try:
            row=json.loads(line)
            if row.get('type')=='thread.started': native=row.get('thread_id')
        except ValueError: pass
    if not native: raise RuntimeError('Native session ID was not returned; refusing --last guess')
    if desktop and native!=args.desktop_session: raise RuntimeError('Desktop native ID changed')
    (root/'bootstrap-evidence.json').write_text(json.dumps({'native_session':native,'cleanup_confirmed':initial.get('cleanup_confirmed'),
        'feedback':initial.get('json',{}).get('last_message',''),'project':str(project)},ensure_ascii=False,indent=2))
    first_file=project/('REMOTE_ONE.md' if desktop else 'README.md')
    if not first_file.exists():
        raise RuntimeError('CLI exited but did not create the requested test artifact; inspect bootstrap-evidence.json. No permission elevation or repeated model call attempted.')
    if desktop:
        assert 'REMOTE_ROUND_ONE' in first_file.read_text()
        if args.expect_context_marker: assert args.expect_context_marker in first_file.read_text()
    else: assert first_file.read_text().strip()=='REMOTE_ROUND_ONE'
    engine=create_engine('sqlite:///'+str(root/'hub-test.sqlite')); store=HubStore(engine,'real-smoke-isolated-test-secret-only-123456789'); store.migrate()
    identity=store.identity('temporary-smoke','isolated-smoke-password-123',register=True)
    pair=store.claim_pair(store.create_pair(identity['owner_id'])['pair_code'],device_id(),'Isolated Codex smoke')
    listener=socket.socket(); listener.bind(('127.0.0.1',0)); url=f'http://127.0.0.1:{listener.getsockname()[1]}'
    app=create_app(store); server=uvicorn.Server(uvicorn.Config(app,log_level='critical')); server_task=asyncio.create_task(server.serve(sockets=[listener]))
    bridge=PublicBridge(url,pair['device_token'],'codex',config,allow_local=True,owner_id=identity['owner_id']); connection=None
    try:
        while not server.started: await asyncio.sleep(.02)
        connection=asyncio.create_task(bridge._connect_once())
        async with httpx.AsyncClient(base_url=url,headers={'Authorization':'Bearer '+identity['control_token']},trust_env=False,timeout=20) as http:
            target=None
            for _ in range(300):
                response=await http.get('/v1/remote-sessions?refresh=true'); rows=response.json().get('sessions',[])
                target=next((row for row in rows if row['session_id']==native),None)
                if target: break
                await asyncio.sleep(.1)
            if not target: raise RuntimeError('Actual native session was not discovered in the authorized temporary root')
            async def submit(prompt):
                body={'prompt':prompt,'idempotency_key':str(uuid.uuid4()),'remote_target':target,'target_agent_id':target['agent_id'],
                    'provider':'codex','session_id':native,'cwd':str(project),'turn_options':{'mode':'resume','session_id':native,'cwd':str(project)}}
                response=await http.post('/v1/turns',json=body); response.raise_for_status(); return response.json()['turn_id']
            async def finished(key):
                deadline=time.monotonic()+330
                while time.monotonic()<deadline:
                    row=(await http.get('/v1/turns/'+key)).json()['task']
                    if row['status'] in {'done','failed','cancelled','cleanup-unconfirmed'}: return row
                    await asyncio.sleep(.2)
                raise RuntimeError('Remote smoke wait exceeded; inspect retained task journal')
            second=await finished(await submit(('Read REMOTE_ONE.md' if desktop else 'Read README.md')+' and confirm it contains REMOTE_ROUND_ONE. Create REMOTE_TWO.md containing exactly REMOTE_ROUND_TWO and a newline. Work only in this temporary project. Reply ROUND_TWO_OK.'))
            assert second['status']=='done' and second['result']['cleanup_confirmed'] is True,second.get('error')
            assert (project/'REMOTE_TWO.md').read_text().strip()=='REMOTE_ROUND_TWO'
            third=await submit('In this temporary project, run a shell command that appends pulse to pulse.txt every second for 90 seconds, keeping the command in the foreground. Do not touch paths outside this project. No background service.')
            deadline=time.monotonic()+90
            while not (project/'pulse.txt').exists() and time.monotonic()<deadline:
                row=(await http.get('/v1/turns/'+third)).json()['task']
                if row['status'] in {'done','failed','cleanup-unconfirmed'}: break
                await asyncio.sleep(.2)
            observed=(project/'pulse.txt').exists()
            response=await http.post('/v1/turns/'+third+'/cancel'); response.raise_for_status(); stopped=await finished(third)
            assert stopped['status']=='cancelled' and stopped['result']['cleanup_confirmed'] is True,stopped.get('error')
            if observed:
                before=(project/'pulse.txt').read_bytes(); await asyncio.sleep(2); assert before==(project/'pulse.txt').read_bytes()
            after=await finished(await submit('Create AFTER_CANCEL.md containing AFTER_CANCEL_OK and a newline. Work only in this isolated test project. Reply AFTER_CANCEL_OK.'))
            assert after['status']=='done' and after['result']['cleanup_confirmed'] is True
            assert (project/'AFTER_CANCEL.md').read_text().strip()=='AFTER_CANCEL_OK'
            report={'ok':True,'native_session':native,'project':str(project),'round_one':True,'round_two':True,'text_feedback':second['result']['json']['last_message'],
                'cancel_exit_confirmed':True,'actual_cli_command_writing_before_cancel':observed,'next_turn_after_cancel':True,
                'desktop_native_session':desktop,'desktop_runtime':info if desktop else None,
                'transport':'loopback HTTP/WS','database':'injected test SQLite','gui_cloud_cross_network':False}
            (root/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)); print(json.dumps(report,ensure_ascii=False))
    finally:
        await bridge.exit_gracefully()
        if connection: connection.cancel(); await asyncio.gather(connection,return_exceptions=True)
        server.should_exit=True; await server_task; listener.close(); engine.dispose()
        print(json.dumps({'evidence_directory':str(root),'services_stopped':True}))
if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--run-paid',action='store_true'); parser.add_argument('--codex')
    parser.add_argument('--desktop-session',default=''); parser.add_argument('--desktop-project',default='')
    parser.add_argument('--confirm-desktop-handoff',action='store_true'); parser.add_argument('--expect-context-marker',default='')
    asyncio.run(main(parser.parse_args()))
