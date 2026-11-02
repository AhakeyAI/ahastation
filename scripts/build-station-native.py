"""Build the internal receiver runtime; users never install or launch Python."""
import hashlib
import json
import os
import platform
from importlib.metadata import version as package_version
import subprocess
import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
DEVICE=ROOT/'services/remote/device'
output=ROOT/'build'
command=[sys.executable,'-m','PyInstaller','--noconfirm','--onedir','--console','--noupx','--name','station-native',
    '--distpath',str(output),'--workpath',str(ROOT/'runtime/native-build/work'),'--specpath',str(ROOT/'runtime/native-build'),
    '--paths',str(DEVICE)]
for module in ('codex_shared_service','codex_shared_rpc','codex_shared','codex_desktop','session_runtime','task_journal',
    'runtime_entry','project_policy','bridge_settings','task_process','task_ownership','idle_probe','macos_task','station_codex'):
    command+=['--hidden-import',module]
command.append(str(DEVICE/'station_native.py'))
subprocess.run(command,check=True,cwd=ROOT)
binary=output/'station-native'/('station-native.exe' if os.name=='nt' else 'station-native')
result=subprocess.run([str(binary)],input=json.dumps({'operation':'self-test'})+'\n',text=True,capture_output=True,check=True,timeout=30)
print(result.stdout)
manifest={'format':2,'gitHead':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'dirty':bool(subprocess.check_output(['git','status','--porcelain'],cwd=ROOT)),'codexRuntime':'0.164.0','dependencyLockSha256':hashlib.sha256((ROOT/'package-lock.json').read_bytes()).hexdigest(),'platform':sys.platform,'machine':platform.machine(),'python':sys.version.split()[0],'protocol':2,
    'version':json.loads((ROOT/'package.json').read_text(encoding='utf-8'))['version'],'files':{
    p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(DEVICE.glob('*.py'))}}
manifest['sourceDigest']=hashlib.sha256(json.dumps(manifest['files'],sort_keys=True).encode()).hexdigest()
manifest['pyinstallerVersion']=package_version('pyinstaller')
manifest['requirementsSha256']=hashlib.sha256((ROOT/'services/remote/requirements-station-native.txt').read_bytes()).hexdigest()
manifest['payloadFiles']={p.relative_to(binary.parent).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(binary.parent.rglob('*')) if p.is_file() and p.name!='SOURCE-MANIFEST.json'}
manifest['payloadDigest']=hashlib.sha256(json.dumps(manifest['payloadFiles'],sort_keys=True).encode()).hexdigest()
(binary.parent/'SOURCE-MANIFEST.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
