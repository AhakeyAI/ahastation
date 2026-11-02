"""Native, Python-free onedir bundle. Never cross-compile or touch user settings."""
import argparse
import hashlib
import json
import os
import platform
import plistlib
import shutil
import subprocess
import sys
import uuid
import zipfile
import stat
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(); parser.add_argument('--output',type=Path,default=ROOT/'runtime'/'packages'); parser.add_argument('--service-url',default='')
args=parser.parse_args()
if args.service_url:
    sys.path.insert(0,str(ROOT/'device'))
    from public_bridge import service_url
    service_url(args.service_url)
output=args.output.resolve(); output.mkdir(parents=True,exist_ok=True)
work=ROOT/'runtime'/'bridge-build'/uuid.uuid4().hex; work.mkdir(parents=True)
name='AhaStationBridge'
command=[sys.executable,'-m','PyInstaller','--noconfirm','--onedir','--console','--noupx','--name',name,
    '--distpath',str(work/'dist'),'--workpath',str(work/'build'),'--specpath',str(work),'--paths',str(ROOT/'device'),'--paths',str(ROOT/'examples'),
    '--add-data',str(ROOT/'web_control_panel')+os.pathsep+'web_control_panel', '--collect-submodules','pystray']
for module in ['task_process','task_ownership','macos_task','idle_probe','session_runtime','task_journal','runtime_entry','project_policy',
    'desktop_control_panel','codex_desktop','codex_shared','codex_shared_rpc','codex_shared_service','codex_cli_adapter','claude_code_adapter','bridge_settings','public_bridge']:
    command+=['--hidden-import',module]
command.append(str(ROOT/'device'/'bridge_app.py')); subprocess.run(command,check=True,cwd=ROOT)
bundle=work/'dist'/name
(bundle/'remote-service.json').write_text(json.dumps({'serviceUrl':args.service_url,'protocol':2}),encoding='utf-8')
shutil.copy2(ROOT/'docs'/'BRIDGE_PRODUCT.md',bundle/'README.md')
shutil.copy2(ROOT/'docs'/'ACCEPTANCE_PUBLIC.md',bundle/'ACCEPTANCE_PUBLIC.md')
shutil.copy2(ROOT/'docs'/'SHARED_DESKTOP_ACCEPTANCE.md',bundle/'SHARED_DESKTOP_ACCEPTANCE.md')
source_paths=sorted(set([*ROOT.glob('device/*.py'),*ROOT.glob('examples/*.py'),ROOT/'scripts'/'build_bridge.py',
    ROOT/'scripts'/'frozen_smoke.py',*ROOT.glob('requirements*.txt'),
    ROOT/'docs'/'BRIDGE_PRODUCT.md',ROOT/'docs'/'ACCEPTANCE_PUBLIC.md',ROOT/'docs'/'SHARED_DESKTOP_ACCEPTANCE.md']))
source_manifest={'platform':sys.platform,'files':{path.relative_to(ROOT).as_posix():hashlib.sha256(path.read_bytes()).hexdigest()
    for path in source_paths}}
(bundle/'BRIDGE-SOURCE-MANIFEST.json').write_text(json.dumps(source_manifest,indent=2),encoding='utf-8')
exe=bundle/(name+'.exe' if sys.platform=='win32' else name)
subprocess.run([str(exe),'--self-test'],check=True)
subprocess.run([str(exe),'--component','task_process','--probe'],check=True,timeout=30)
subprocess.run([str(exe),'--component','codex_shared_service','--probe'],check=True,timeout=30)
if sys.platform=='darwin':
    app=work/'dist'/(name+'.app'); mac=app/'Contents'/'MacOS'; mac.mkdir(parents=True)
    for path in bundle.iterdir(): shutil.move(str(path),str(mac/path.name))
    plist={'CFBundleExecutable':name,'CFBundleIdentifier':'com.ahastation.bridge','CFBundleName':'AhaStation Bridge',
           'CFBundleShortVersionString':'0.2.0','LSUIElement':True,'NSHighResolutionCapable':True}
    (app/'Contents'/'Info.plist').write_bytes(plistlib.dumps(plist)); bundle=app
archive=output/f'ahastation-bridge-0.2.0-{sys.platform}-{platform.machine().lower()}.zip'
if archive.exists(): raise SystemExit('Output already exists; choose another output directory to preserve prior packages')
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as stream:
    for file in sorted(bundle.rglob('*')):
        if file.is_symlink():
            entry=zipfile.ZipInfo(str(file.relative_to(bundle.parent)).replace('\\','/'))
            entry.create_system=3; entry.external_attr=(stat.S_IFLNK|0o777)<<16
            stream.writestr(entry,os.readlink(file))  # macOS frameworks/Linux onedir require their native symbolic links.
        elif file.is_file(): stream.write(file,file.relative_to(bundle.parent))
print(json.dumps({'archive':str(archive),'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'native_platform':sys.platform}))
