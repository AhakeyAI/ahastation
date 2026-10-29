"""Desktop-owned runtime discovery and metadata-only Codex RPC queries.

No shared GUI backend is killed or controlled here. Queries never resume/start
threads or send turns; exec resume remains an independently owned task process.
"""
from __future__ import annotations
import json
import os
import queue
import re
import shlex
import subprocess
import sys
import threading
import uuid
import tempfile
from pathlib import Path

SOURCE_KINDS=['cli','vscode','appServer','exec','unknown']
CREATE_FLAGS=0x08000000 if os.name=='nt' else 0

def local_path(value):
    path=str(Path(value).resolve(strict=True))
    # RPC and Windows Store components may use extended-length paths while
    # codexHome uses ordinary paths. Compare the same real filesystem location.
    if os.name=='nt':
        if path.startswith('\\\\?\\UNC\\'): path='\\\\'+path[8:]
        elif path.startswith('\\\\?\\'): path=path[4:]
    return Path(path)

def running_runtimes():
    """Only children of a desktop installation, not arbitrary PATH processes."""
    if os.name=='nt':
        script="[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $p=Get-CimInstance Win32_Process; $p | Where-Object {$_.Name -ieq 'codex.exe' -and $_.CommandLine -match 'app-server'} | ForEach-Object { $c=$_; $parent=$p | Where-Object {$_.ProcessId -eq $c.ParentProcessId}; [pscustomobject]@{path=$c.ExecutablePath;parent=$parent.ExecutablePath}} | ConvertTo-Json -Compress"
        result=subprocess.run(['powershell','-NoProfile','-Command',script],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=12,creationflags=CREATE_FLAGS)
        rows=json.loads(result.stdout or '[]'); rows=rows if isinstance(rows,list) else [rows]
        return [r['path'] for r in rows if r.get('path') and re.search(r'(?i)(WindowsApps[\\/]OpenAI\.Codex_|OpenAI[\\/]Codex|(?:Codex|ChatGPT)\.app)',r.get('parent') or '')]
    result=subprocess.run(['ps','-axo','pid=,ppid=,comm='],capture_output=True,text=True,timeout=8)
    paths=[]
    for line in result.stdout.splitlines():
        parts=line.strip().split(None,2)
        if len(parts)!=3 or 'codex' not in parts[2].lower(): continue
        args=subprocess.run(['ps','-p',parts[0],'-o','args='],capture_output=True,text=True,timeout=3).stdout
        if 'app-server' not in args: continue
        parent=subprocess.run(['ps','-p',parts[1],'-o','comm='],capture_output=True,text=True,timeout=3).stdout
        if not re.search(r'/(Codex|ChatGPT)\.app/',parent): continue
        candidate=Path(parts[2])  # Keep spaces in macOS bundle paths intact.
        if not candidate.is_file():
            command=shlex.split(args)
            if command: candidate=Path(command[0])
        if candidate.is_file(): paths.append(str(candidate))
    return paths

def installation_candidates():
    if sys.platform=='win32':
        base=Path(os.environ.get('LOCALAPPDATA',str(Path.home()/'AppData/Local')))/'OpenAI'/'Codex'/'bin'
        return list(base.glob('*/codex.exe'))
    if sys.platform=='darwin':
        candidates=[]
        for base in (Path('/Applications'),Path.home()/'Applications'):
            for app in ('Codex.app','ChatGPT.app'):
                for relative in ('Contents/Resources/codex','Contents/Resources/bin/codex'):
                    candidates.append(base/app/relative)
        for base in ('Codex','OpenAI/Codex','com.openai.codex'):
            candidates.extend((Path.home()/'Library'/'Application Support'/base/'bin').glob('*/codex'))
        return candidates
    return []  # Linux keeps its existing independent CLI setup.

class ReadOnlyRPC:
    def __init__(self,binary): self.binary=binary; self.proc=None; self.seq=0; self.messages=queue.Queue()
    def __enter__(self):
        self.proc=subprocess.Popen([self.binary,'app-server','--listen','stdio://'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8',errors='replace',creationflags=CREATE_FLAGS)
        def read():
            for line in self.proc.stdout:
                if len(line)>2*1024*1024: self.messages.put({'error':'RPC response exceeds limit'}); return
                try: self.messages.put(json.loads(line))
                except ValueError: continue
            self.messages.put({'error':'RPC process ended'})
        self.reader=threading.Thread(target=read,daemon=True); self.reader.start()
        try:
            self.info=self.call('initialize',{'clientInfo':{'name':'ahastation_bridge_catalog','version':'0.2.0'},'capabilities':{'experimentalApi':True}})
            self.proc.stdin.write('{"method":"initialized"}\n'); self.proc.stdin.flush()
            return self
        except Exception:
            self.__exit__(None,None,None); raise
    def call(self,method,params):
        if method not in {'initialize','thread/list','thread/read'}: raise ValueError('Only metadata query methods are allowed')
        self.seq+=1
        self.proc.stdin.write(json.dumps({'id':self.seq,'method':method,'params':params})+'\n'); self.proc.stdin.flush()
        while True:
            msg=self.messages.get(timeout=20)
            if msg.get('id')==self.seq:
                if 'error' in msg: raise RuntimeError(str(msg['error'])[:300])
                return msg['result']
            if 'error' in msg and 'id' not in msg: raise RuntimeError(str(msg['error']))
    def __exit__(self,*_):
        if self.proc:
            try: self.proc.stdin.close()
            except OSError: pass
            try: self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired: self.proc.kill(); self.proc.wait()
            self.reader.join(timeout=2)
            self.proc.stdout.close()

def probe_runtime(binary):
    path=Path(binary).resolve(strict=True)
    version=subprocess.run([str(path),'--version'],capture_output=True,text=True,timeout=8,creationflags=CREATE_FLAGS)
    match=re.search(r'codex-cli\s+(\d+\.\d+\.\d+[^\s]*)',version.stdout)
    if version.returncode or not match: raise ValueError('候选程序不是可用的 Codex 运行组件')
    help_result=subprocess.run([str(path),'exec','resume','--help'],capture_output=True,text=True,timeout=8,creationflags=CREATE_FLAGS)
    if help_result.returncode or 'SESSION_ID' not in help_result.stdout: raise ValueError('该运行组件不支持显式原生会话恢复')
    # Older servers may silently ignore unknown JSON fields. Verify the actual
    # executable's schema BEFORE using useStateDbOnly, not just an HTTP/RPC OK.
    with tempfile.TemporaryDirectory(prefix='bridge-codex-schema-') as directory:
        generated=subprocess.run([str(path),'app-server','generate-json-schema','--experimental','--out',directory],
            capture_output=True,timeout=15,creationflags=CREATE_FLAGS)
        if generated.returncode: raise ValueError('该组件无法确认只读会话目录协议；请更新桌面版或使用原独立 CLI 接入')
        for name,required in [('ThreadListParams.json',{'sourceKinds','useStateDbOnly'}),('ThreadReadParams.json',{'threadId','includeTurns'})]:
            schema=next(Path(directory).rglob(name),None)
            if not schema or not required.issubset(json.loads(schema.read_text(encoding='utf-8')).get('properties',{})):
                raise ValueError('该组件缺少只读会话目录能力；请更新桌面版或使用原独立 CLI 接入')
    with ReadOnlyRPC(str(path)) as rpc:
        rpc.call('thread/list',{'limit':1,'sourceKinds':SOURCE_KINDS,'useStateDbOnly':True})
        home=rpc.info.get('codexHome')
        if not home: raise ValueError('运行组件没有返回本地会话存储位置')
    login=subprocess.run([str(path),'login','status'],capture_output=True,text=True,timeout=12,creationflags=CREATE_FLAGS)
    return {'binary':str(path),'version':match[1],'codex_home':home,'logged_in':login.returncode==0,'protocol':'thread/list+thread/read+exec/resume','readonly_schema_verified':True}

def discover_runtime(manual=''):
    if manual: return {**probe_runtime(manual),'source':'manual'}  # Never silently replace an explicit path.
    candidates=[]
    try: candidates.extend((0,Path(p),'running-desktop') for p in running_runtimes())
    except (OSError,ValueError,subprocess.TimeoutExpired): pass
    candidates.extend((1,Path(p),'desktop-installation') for p in installation_candidates())
    seen=set(); valid=[]
    for rank,path,source in candidates:
        if not path.is_file(): continue
        canonical=str(path.resolve())
        if canonical.lower() in seen: continue
        seen.add(canonical.lower())
        try:
            info=probe_runtime(canonical); modified=path.stat().st_mtime
        except (OSError,ValueError,RuntimeError,subprocess.TimeoutExpired,queue.Empty): continue
        numbers=tuple(int(n) for n in re.findall(r'\d+',info['version']))
        valid.append((rank,numbers,modified,canonical,{**info,'source':source}))
    if not valid: raise ValueError('未发现兼容的 Codex 桌面版运行组件，请安装并登录桌面版；高级设置仍可使用独立 CLI')
    best_rank=min(row[0] for row in valid)
    return max((row for row in valid if row[0]==best_rank),key=lambda row:(row[1],row[2],row[3]))[4]

def reference(thread,home,confirmed):
    native=str(thread.get('id','')); cwd=str(thread.get('cwd') or '')
    desktop='desktop' in str(thread.get('originator','')).lower() or thread.get('source')=='appServer'
    label='Codex 桌面版' if desktop else 'Codex 本地会话'
    row={'session_id':native,'provider':'codex','title':f"{str(thread.get('name') or native)[:140]} · {label}",'cwd':cwd,'source':'desktop' if desktop else 'local',
         'native_client_status':'unknown','available':False,'error':''}
    try:
        uuid.UUID(native)
        if thread.get('ephemeral'): raise ValueError('临时会话没有本地恢复数据')
        if not cwd or not Path(cwd).is_absolute() or not Path(cwd).is_dir(): raise ValueError('原会话未提供有效的本地项目目录')
        raw=thread.get('path')
        if not raw: raise ValueError('云端或仅标题记录缺少本地恢复数据')
        path=local_path(raw); base=local_path(home)
        if not any(path.is_relative_to(base/name) for name in ('sessions','archived_sessions')): raise ValueError('恢复数据不在该组件的本地会话目录')
        if thread.get('archived') or path.is_relative_to(base/'archived_sessions'): raise ValueError('会话已归档，请在桌面版恢复后再切换控制')
        with path.open('r',encoding='utf-8') as stream:
            meta=json.loads(stream.readline(2*1024*1024))
        if meta.get('type')!='session_meta' or meta.get('payload',{}).get('id')!=native: raise ValueError('本地恢复记录与原生会话ID不匹配')
        original=meta['payload'].get('cwd')
        if original and not Path(original).samefile(cwd): raise ValueError('原会话项目目录与恢复记录不匹配')
        if thread.get('historyMode') not in (None,'legacy','paginated'): raise ValueError('该版本不支持此会话历史格式')
        # Persisted inProgress can outlive a killed CLI. It is not live ownership
        # proof. The native engine enforces its writer claim during exec resume;
        # conflicts fail before a turn, while GUI occupancy remains unknown.
        if thread.get('status',{}).get('type')=='active': raise ValueError('会话查询报告执行中任务，请先在桌面结束任务')
        if not confirmed: raise ValueError('占用未知：请在 Bridge 本地确认结束桌面任务并切换控制')
        row['available']=True
    except (ValueError,OSError,TypeError) as exc: row['error']=str(exc)[:300]
    return row

def discover_desktop_sessions(binary,confirmed=False,limit=100):
    with ReadOnlyRPC(binary) as rpc:
        home=rpc.info['codexHome']; rows={}
        for archived in (False,True):
            cursor=None; cursors=set()
            while len(rows)<limit:
                page=rpc.call('thread/list',{'limit':min(60,limit-len(rows)),'sourceKinds':SOURCE_KINDS,'useStateDbOnly':True,'archived':archived,'cursor':cursor})
                for item in page.get('data',[]):
                    if item['id'] in rows: continue
                    try:
                        full=rpc.call('thread/read',{'threadId':item['id'],'includeTurns':False})['thread']
                        if full.get('id')!=item['id']: raise ValueError('会话引用不匹配')
                        rows[item['id']]=reference({**full,'archived':archived},home,confirmed)
                    except (RuntimeError,ValueError) as exc:
                        rows[item['id']]={**reference(item,home,False),'available':False,'error':'会话摘要读取失败：'+str(exc)[:180]}
                cursor=page.get('nextCursor')
                if not cursor or cursor in cursors: break
                cursors.add(cursor)
        return list(rows.values())

def validate_desktop_target(binary,native,cwd,confirmed):
    with ReadOnlyRPC(binary) as rpc:
        thread=rpc.call('thread/read',{'threadId':native,'includeTurns':False})['thread']
        if thread.get('id')!=native: raise ValueError('原生会话ID不匹配；本次未执行')
        row=reference(thread,rpc.info['codexHome'],confirmed)
        if not row['available']: raise ValueError(row['error'])
        if not Path(row['cwd']).samefile(cwd): raise ValueError('所选项目目录与原会话不匹配；本次未执行')
        return row
