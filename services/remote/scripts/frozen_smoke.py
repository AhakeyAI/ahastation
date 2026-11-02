"""Test only frozen helpers and OS commands; no models, GUI or user state."""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
parser=argparse.ArgumentParser(); parser.add_argument('--exe',type=Path,required=True); args=parser.parse_args()
exe=args.exe.resolve(strict=True)
with tempfile.TemporaryDirectory(prefix='bridge-frozen-') as directory:
    root=Path(directory); journal=root/'journal'; journal.mkdir(); native=str(uuid.uuid4())
    env={**os.environ,'POCKET_VIBE_STATE_DIR':str(root/'state'),'HOME':str(root/'home'),'USERPROFILE':str(root/'home')}
    # Frozen Codex adapter build/permission/native-ID/cwd logic, never a real CLI.
    task={'objective':'frozen fixture','session_id':native,'cwd':str(root),'turn_options':{'mode':'resume','session_id':native,'cwd':str(root)}}
    dry=subprocess.run([str(exe),'--component','codex_cli_adapter','--dry-run','--sandbox','workspace-write','--approval','never'],input=json.dumps(task),text=True,capture_output=True,env=env,check=True)
    command=json.loads(dry.stdout)['would_run']
    assert native in command and command.index(native)>command.index('resume')
    assert command[command.index('--sandbox')+1]=='workspace-write'
    # Resume applies effective_cwd to subprocess.run, rather than an unsupported resume flag.
    if os.name=='nt':
        cli=root/'fixture-cli.cmd'; cli.write_text('@echo off\ncd > cwd.txt\necho frozen feedback\n')
    else:
        cli=root/'fixture-cli'; cli.write_text('#!/bin/sh\npwd > cwd.txt\necho frozen feedback\n'); cli.chmod(0o700)
    executed=subprocess.run([str(exe),'--component','codex_cli_adapter','--binary',str(cli),'--sandbox','workspace-write','--approval','never'],
        input=json.dumps(task),text=True,capture_output=True,env=env,check=True)
    result=json.loads(executed.stdout); assert result['ok'] and 'frozen feedback' in result['stdout']
    assert Path((root/'cwd.txt').read_text().strip()).resolve()==root.resolve()
    # Root + subprocess ownership uses the bundled Python runtime, no system Python in commands.
    def run(command,timeout=3,cancel=False):
        spec={'task':{**task,'task_id':str(uuid.uuid4())},'command':command,'working_dir':str(root),'provider':'codex','session_id':native,
            'timeout':timeout,'project_policy':{'confirmed':True,'roots':[str(root)]},'_journal_dir':str(journal)}
        proc=subprocess.Popen([str(exe),'--component','task_process'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
        proc.stdin.write(json.dumps(spec).encode()); proc.stdin.close(); proc.stdin=None
        if cancel:
            deadline=time.monotonic()+15
            while not (journal/'status.json').exists() or json.loads((journal/'status.json').read_text())['status']!='running':
                if proc.poll() is not None or time.monotonic()>deadline: raise RuntimeError('Frozen task did not start')
                time.sleep(.03)
            (journal/'cancel.json').write_text('{}')
        out,err=proc.communicate(timeout=25)
        frames=[json.loads(line) for line in out.splitlines()]
        result=next(frame['result'] for frame in frames if frame['type']=='result')
        assert proc.returncode==0 and result['cleanup_confirmed'] is True,(result,err)
        assert json.loads((journal/'result.json').read_text())['cleanup_confirmed'] is True
        return result
    result=run([str(exe),'--component','idle_probe','--quick']); assert result['ok']
    (journal/'status.json').unlink(); result=run([str(exe),'--component','idle_probe'],cancel=True)
    assert result.get('cancelled') is True
    # A next native task starts only after guardian has produced exit proof.
    (journal/'cancel.json').unlink(); result=run([str(exe),'--component','idle_probe','--quick']); assert result['ok']
    print(json.dumps({'ok':True,'frozen_execution':True,'native_session':native,'cancel_exit_confirmed':True,'system_python_used_by_tasks':False}))
