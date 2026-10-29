"""Own only the two isolated GUI smoke processes and their descendants."""
import json,os,subprocess,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'device'))
from task_process import WindowsJob
request=json.loads(sys.stdin.readline());jobs=[];processes=[]
try:
    for name in ('GUI-A','GUI-B'):
        job=WindowsJob();jobs.append(job)
        env={**os.environ,'AHASTATION_USER_DATA_DIR':str(Path(request['root'])/name),
            'AHASTATION_LAUNCH_LOG_DIR':str(Path(request['root'])/name/'logs'),'AHASTATION_REMOTE_ALLOW_LOOPBACK':'1'}
        env.pop('ELECTRON_RUN_AS_NODE',None)
        log=open(Path(request['root'])/name/'main-stderr.log','wb')
        process=job.spawn([request['exe']],env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,creationflags=4|0x08000000)
        log.close()
        job.attach_and_resume(process);processes.append(process)
    print(json.dumps({'ready':True,'pids':[p.pid for p in processes]}),flush=True)
    sys.stdin.readline()
finally:
    for job in jobs:job.kill();job.close()
    for process in processes:process.wait(timeout=10)
