"""Allowlist export of current working-tree sources (including untracked work)."""
import argparse
import hashlib
import json
import stat
import zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(); parser.add_argument('--output',type=Path,default=ROOT/'runtime'/'deploy'); args=parser.parse_args()
output=args.output.resolve(); output.mkdir(parents=True,exist_ok=True)
hub=['device/public_hub.py','device/hub_store.py','device/device_hub.py','device/protocol.py','device/qwen_router.py',
     'requirements-public.txt','deploy/Dockerfile','deploy/Dockerfile.dockerignore','deploy/migrate.py','deploy/schema-v1.sql','deploy/hub.env.example','deploy/compose.yaml',
     'docs/WEIXIN_CLOUD_DEPLOY.md','docs/PUBLIC_REMOTE_CONTROL.md','docs/BRIDGE_PRODUCT.md','docs/ACCEPTANCE_PUBLIC.md']
hub += [str(path.relative_to(ROOT)).replace('\\','/') for path in (ROOT/'web').rglob('*') if path.is_file()]
probe=['probe/app.py','probe/client.py','probe/requirements.txt','probe/README.md']
def write_entry(stream,name,data):
    entry=zipfile.ZipInfo(name)
    entry.create_system=3  # Unix permissions, also when exported on Windows.
    directory=name.endswith('/')
    entry.external_attr=((stat.S_IFDIR|0o755) if directory else (stat.S_IFREG|0o644)) << 16
    if directory: entry.external_attr |= 0x10
    entry.compress_type=zipfile.ZIP_DEFLATED
    stream.writestr(entry,data)

def package(name,files,docker,ignore):
    archive=output/name
    if archive.exists(): raise SystemExit('Output already exists: '+str(archive))
    hashes={}
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as stream:
        for source,target in [(file,file) for file in files]+[(docker,'Dockerfile'),(ignore,'.dockerignore')]:
            data=(ROOT/source).read_bytes(); write_entry(stream,target,data); hashes[target]=hashlib.sha256(data).hexdigest()
        write_entry(stream,'SOURCE-MANIFEST.json',json.dumps({'format':1,'files':hashes},indent=2))
    print(json.dumps({'archive':str(archive),'files':len(hashes),'sha256':hashlib.sha256(archive.read_bytes()).hexdigest()}))
package('ahastation-hub-source.zip',hub,'deploy/Dockerfile','deploy/.dockerignore')
package('ahastation-wss-probe-source.zip',probe,'probe/Dockerfile','deploy/.dockerignore')
