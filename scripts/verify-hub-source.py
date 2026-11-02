"""Verify current Hub export manifest/modes and import from its own contents."""
import argparse,hashlib,json,subprocess,sys,zipfile,re,importlib.metadata
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--archive',type=Path,default=ROOT/'release/collaboration-candidate/deployment/ahastation-hub-source.zip');parser.add_argument('--evidence',type=Path,default=ROOT/'runtime/collaboration-2026-10-21');args=parser.parse_args()
archive=args.archive.resolve()
target=args.evidence.resolve()/'exported-hub'
target.mkdir(parents=True,exist_ok=False)
with zipfile.ZipFile(archive) as stream:
    manifest=json.loads(stream.read('SOURCE-MANIFEST.json'))['files']
    for name,digest in manifest.items():
        assert '..' not in Path(name).parts and not Path(name).is_absolute()
        assert hashlib.sha256(stream.read(name)).hexdigest()==digest,name
        assert (stream.getinfo(name).external_attr>>16)&0o777==0o644,name
    assert {'Dockerfile','.dockerignore','device/collaboration_store.py','device/collaboration_routes.py','contracts/collaboration/v2.schema.json','deploy/schema-v2.sql'}<=set(manifest)
    assert not any(part in {'runtime','.env','.venv','node_modules','.git'} for name in stream.namelist() for part in Path(name).parts)
    stream.extractall(target)
code="import sys;sys.path.insert(0,'device');import public_hub;paths={r.path for r in public_hub.app.routes};assert '/api/collaboration/v2/commands' in paths;assert '/ws/station' in paths;assert '/api/collaboration/v2/message-receipts' in paths;print('Exported Hub production routes imported')"
subprocess.run([sys.executable,'-c',code],cwd=target,check=True,timeout=20)
from packaging.requirements import Requirement
dependencies=[]
for line in (target/'requirements-public.txt').read_text(encoding='utf-8').splitlines():
    line=line.strip()
    if not line or line.startswith('#'):continue
    requirement=Requirement(line)
    if requirement.marker and not requirement.marker.evaluate():continue
    installed=importlib.metadata.version(requirement.name)
    assert installed in requirement.specifier,'Exported runtime dependency mismatch: '+requirement.name
    dependencies.append({'name':requirement.name,'installed':installed,'required':str(requirement.specifier)})
copies=re.findall(r'^COPY\s+(\S+)\s+', (target/'Dockerfile').read_text(encoding='utf-8'),re.M)
for source in copies:assert (target/source).exists(),'Missing Docker build context source: '+source
startup=r'''
import sys,tempfile,socket,threading,time,json,urllib.request
from pathlib import Path
sys.path.insert(0,'device')
import uvicorn
from sqlalchemy import create_engine
from hub_store import HubStore
from public_hub import create_app
with tempfile.TemporaryDirectory(prefix='exported-hub-startup-') as folder:
 engine=create_engine('sqlite:///'+str(Path(folder)/'isolated.sqlite'))
 store=HubStore(engine,'isolated-export-startup-secret-not-production');store.migrate()
 app=create_app(store);sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 server=uvicorn.Server(uvicorn.Config(app,log_level='critical'));thread=threading.Thread(target=lambda:server.run(sockets=[sock]),daemon=True);thread.start()
 try:
  for _ in range(200):
   if server.started:break
   time.sleep(.025)
  assert server.started,'Exported production app did not start'
  for route in ('/health','/ready'):
   with urllib.request.urlopen('http://127.0.0.1:'+str(port)+route,timeout=5) as response:assert response.status==200
  print('Exported Hub lifespan, health and readiness passed with isolated SQLite')
 finally:server.should_exit=True;thread.join(timeout=15);assert not thread.is_alive();sock.close();engine.dispose()
'''
subprocess.run([sys.executable,'-c',startup],cwd=target,check=True,timeout=30)
report={'pass':True,'archive':str(archive),'files':len(manifest),'manifestAndModes':True,'productionRoutesImport':True,'pinnedDependencies':dependencies,'dockerCopySources':copies,'isolatedStartup':True,'startupDatabase':'owned temporary SQLite; MySQL tested separately','containerBuilt':False}
(args.evidence.resolve()/'deployment-verification.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report))
