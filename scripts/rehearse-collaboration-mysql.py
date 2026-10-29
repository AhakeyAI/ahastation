"""Run a private, portable MySQL; never install a service or touch cloud data."""
import argparse,asyncio,json,os,secrets,socket,subprocess,sys,time,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
DEVICE=ROOT/'services/remote/device';sys.path.insert(0,str(DEVICE))
from task_process import WindowsJob
from hub_store import HubStore,metadata,schema,devices
from collaboration_store import metadata as collaboration_metadata
from sqlalchemy import select
import pymysql
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--mysql-base',type=Path,default=ROOT/'runtime/collaboration-2026-10-21/mysql-portable/distribution/mysql-8.4.13-winx64')
parser.add_argument('--output',type=Path,default=ROOT/'runtime/collaboration-2026-10-21/mysql-portable')
parser.add_argument('--navicat-upgrade-checks',action='store_true')
args=parser.parse_args()
base=args.mysql_base.resolve()
binary=base/'bin/mysqld.exe'
version_output=subprocess.run([str(binary),'--no-defaults','--version'],capture_output=True,text=True,check=True,timeout=15).stdout.strip()
mysql8='Ver 8.' in version_output
folder=args.output.resolve()/('rehearsal-'+str(uuid.uuid4()));folder.mkdir(parents=True)
data=folder/'data';log=open(folder/'mysqld.log','wb');job=WindowsJob();process=None;admin=None
report={'pass':False,'root':str(folder),'binaryVersion':version_output,'scope':'Owned loopback MySQL/InnoDB, schema v1 to v2 preservation and production HTTP/WSS integrations; no cloud mutation'}
try:
    subprocess.run([str(binary),'--no-defaults','--initialize-insecure','--basedir='+str(base),'--datadir='+str(data)],stdout=log,stderr=log,check=True,timeout=90)
    listener=socket.socket();listener.bind(('127.0.0.1',0));port=listener.getsockname()[1];listener.close()
    options=['--mysqlx=OFF'] if mysql8 else []
    process=job.spawn([str(binary),'--no-defaults','--console','--basedir='+str(base),'--datadir='+str(data),'--bind-address=127.0.0.1','--port='+str(port),*options],stdout=log,stderr=log,stdin=subprocess.DEVNULL,creationflags=4|0x08000000)
    job.attach_and_resume(process)
    for _ in range(120):
        if process.poll() is not None:raise RuntimeError('Owned MySQL exited; inspect its local log')
        try:admin=pymysql.connect(host='127.0.0.1',port=port,user='root',password='',autocommit=True);break
        except pymysql.MySQLError as error:last_error=str(error);time.sleep(.25)
    if not admin:raise RuntimeError('Owned MySQL startup timed out: '+last_error)
    database='station_fixture_'+uuid.uuid4().hex[:16];password=secrets.token_urlsafe(32)
    with admin.cursor() as c:
        c.execute('SELECT @@datadir,VERSION()');actual,report['mysqlVersion']=c.fetchone()
        if Path(actual).resolve()!=data.resolve():raise RuntimeError('Database ownership mismatch; no mutations applied')
        c.execute("ALTER USER 'root'@'localhost' IDENTIFIED BY %s",(secrets.token_urlsafe(32),))
        c.execute('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin')
        c.execute("CREATE USER 'station_fixture'@'127.0.0.1' IDENTIFIED BY %s",(password,))
        c.execute('GRANT ALL ON `'+database+"`.* TO 'station_fixture'@'127.0.0.1'")
    config={'fixture':'owned-local-mysql','host':'127.0.0.1','port':port,'database':database,'user':'station_fixture','password':password}
    config_file=folder/'private-test-connection.json';config_file.write_text(json.dumps(config),encoding='utf-8')
    env={**os.environ,'MYSQL_HOST':'127.0.0.1','MYSQL_PORT':str(port),'MYSQL_DATABASE':database,'MYSQL_USER':'station_fixture','MYSQL_PASSWORD':password,'HUB_SECRET':secrets.token_urlsafe(48),'COLLABORATION_TEST_MYSQL_FILE':str(config_file),'COLLABORATION_PYTHON':sys.executable,'POCKET_VIBE_TEST_PYTHON':sys.executable,'PYTHONUTF8':'1'}
    saved_env=os.environ.copy();os.environ.update({k:v for k,v in env.items() if k.startswith(('MYSQL_','HUB_SECRET'))})
    try:
        store=HubStore.production();metadata.create_all(store.engine)
        with store.engine.begin() as c:c.execute(schema.insert().values(id=1,version=1))
        identity=store.identity('preserved-account','local-rehearsal-password',register=True)
        device_id=str(uuid.uuid4())
        with store.engine.begin() as c:c.execute(devices.insert().values(id=device_id,owner=identity['owner_id'],name='Preserved legacy device',revoked=0,created=time.time()))
        store.migrate();store.ready();store.authenticate(identity['control_token'],'control')
        with store.engine.connect() as c:
            assert c.execute(select(schema.c.version)).scalar()==2
            assert c.execute(select(devices.c.name).where(devices.c.id==device_id)).scalar()=='Preserved legacy device'
        report['migrationPreservedIdentityCredentialAndDevice']=True;store.engine.dispose()
    finally:os.environ.clear();os.environ.update(saved_env)
    if args.navicat_upgrade_checks:
        from mysql57_upgrade_checks import verify_upgrade_sql
        report['operatorSql']=verify_upgrade_sql(admin,config,env['HUB_SECRET'],ROOT/'services/remote/deploy/mysql57-upgrade',data)
    checks=[('python-ui-fixes.log',[sys.executable,'-m','unittest','discover','-s','services/remote/tests','-p','test_ui_fixes_hub.py','-v']),('python-hardening.log',[sys.executable,'-m','unittest','discover','-s','services/remote/tests','-p','test_collaboration_hardening.py','-v']),('python-stability.log',[sys.executable,'-m','unittest','discover','-s','services/remote/tests','-p','test_collaboration_stability.py','-v']),('python-review-fixes.log',[sys.executable,'-m','unittest','discover','-s','services/remote/tests','-p','test_collaboration_review_fixes.py','-v']),('python-unified.log',[sys.executable,'-m','unittest','discover','-s','services/remote/tests','-p','test_unified_meeting.py','-v']),('python-hub.log',[sys.executable,'-m','unittest','discover','-s','services/remote/tests','-p','test_station_collaboration.py','-v']),
        ('node-two-stations.log',['node','--test','--test-timeout=120000','--import',"data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));",'tests/station-collaboration.test.mjs'])]
    checks.insert(0, ('python-p1.log', [sys.executable, '-m', 'unittest', 'discover',
                                     '-s', 'services/remote/tests', '-p', 'test_collaboration_p1.py', '-v']))
    for name,command in checks:
        with open(folder/name,'wb') as output:result=subprocess.run(command,cwd=ROOT,env=env,stdout=output,stderr=output,timeout=300)
        if result.returncode:raise RuntimeError('MySQL integration check failed: '+name)
    report['pass']=True
except Exception as error:report['error']=str(error);sys.exitCode=1
finally:
    if admin:
        try:
            with admin.cursor() as c:c.execute('SHUTDOWN')
        except pymysql.MySQLError:pass
        admin.close()
    if process:
        try:process.wait(timeout=20)
        except subprocess.TimeoutExpired:job.kill();process.wait(timeout=10)
    job.close();log.close();(folder/'RESULT.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report))
if not report['pass']:raise SystemExit(1)
