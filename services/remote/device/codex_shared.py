"""Bridge-side shared service discovery, explicit Desktop launch and recovery."""
from __future__ import annotations
import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from codex_shared_rpc import RPC
from task_journal import read_json,write_json,TaskJournal
from session_runtime import state_dir


def directory(): return state_dir()/'remote'/'codex-shared'


def private_file(path, text):
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    path.write_text(text,encoding='utf-8'); path.chmod(0o600)
    if os.name=='nt':
        # Native token file must also be readable only by this OS account, not
        # merely chmod(0600), which doesn't restrict Windows ACLs.
        import ctypes
        from ctypes import wintypes
        adv=ctypes.WinDLL('advapi32',use_last_error=True); kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.GetCurrentProcess.restype=wintypes.HANDLE
        handle=wintypes.HANDLE()
        adv.OpenProcessToken.argtypes=[wintypes.HANDLE,wintypes.DWORD,ctypes.POINTER(wintypes.HANDLE)]
        if not adv.OpenProcessToken(kernel.GetCurrentProcess(),8,ctypes.byref(handle)): raise ctypes.WinError()
        try:
            size=wintypes.DWORD(); adv.GetTokenInformation(handle,1,None,0,ctypes.byref(size))
            buffer=ctypes.create_string_buffer(size.value)
            if not adv.GetTokenInformation(handle,1,buffer,size,ctypes.byref(size)): raise ctypes.WinError()
            sid=ctypes.cast(buffer,ctypes.POINTER(ctypes.c_void_p))[0]; string=wintypes.LPWSTR()
            adv.ConvertSidToStringSidW.argtypes=[ctypes.c_void_p,ctypes.POINTER(wintypes.LPWSTR)]
            if not adv.ConvertSidToStringSidW(sid,ctypes.byref(string)): raise ctypes.WinError()
            try: identity=string.value
            finally: kernel.LocalFree(ctypes.cast(string,ctypes.c_void_p))
        finally: kernel.CloseHandle(handle)
        subprocess.run(['icacls',str(path),'/inheritance:r','/grant:r','*'+identity+':(F)'],
            check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,creationflags=0x08000000)


def save_endpoint(folder, value):
    from bridge_settings import dpapi
    raw=json.dumps(value).encode()
    write_json(Path(folder)/'endpoint.json',{'dpapi':dpapi(raw).hex()} if os.name=='nt' else value)


def endpoint(folder=None):
    from bridge_settings import dpapi
    value=read_json(Path(folder or directory())/'endpoint.json')
    if not value: raise RuntimeError('共享执行服务尚未启动；请使用 Bridge 的“启动联动桌面”入口')
    if 'dpapi' in value: value=json.loads(dpapi(bytes.fromhex(value['dpapi']),False))
    if not value.get('url','').startswith('ws://127.0.0.1:'): raise RuntimeError('共享服务必须使用受保护的本机连接')
    return value


async def status(folder=None):
    info=endpoint(folder)
    async with RPC(info['url']) as rpc:
        result=await rpc.call('bridge/status',{},timeout=5)
        if result['generation']!=info['generation']: raise RuntimeError('共享服务实例身份不匹配')
        return result


def support_error():
    try:
        # Synchronous hello paths also run inside asyncio. A local heartbeat
        # advertises availability; catalog/admission use real RPC before turns.
        shared=endpoint(); value=read_json(directory()/'status.json') or {}
        age=time.monotonic()-value.get('heartbeat',0)
        if value.get('generation')!=shared['generation'] or not 0<=age<3:
            return '共享执行服务心跳失效，执行状态未确认'
        if not value['desktop_connected']: return '桌面尚未连接共享执行服务；首次启用请自行结束桌面工作后使用“启动联动桌面”'
        return ''
    except Exception as exc: return '桌面联动不可用：'+str(exc)[:230]


def ensure_service(info):
    try:
        asyncio.run(status()); return endpoint()
    except Exception: pass
    help_text=subprocess.run([info['binary'],'app-server','--help'],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=10,
        creationflags=0x08000000 if os.name=='nt' else 0).stdout
    if not all(flag in help_text for flag in ('--ws-auth','--ws-token-file')):
        raise RuntimeError('当前桌面运行组件缺少受保护的共享 WebSocket 能力；不会回退独立 exec')
    # No replacement while an earlier generation's native turns are unknown.
    # Session records retain their proof requirements across service restarts.
    from runtime_entry import python_command
    command=python_command(Path(__file__).with_name('codex_shared_service.py'))+['--binary',info['binary'],'--directory',str(directory())]
    folder=directory(); folder.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (folder/'launcher.log').open('ab') as log:
        subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=log,stderr=log,
            creationflags=0x08000000|0x200 if os.name=='nt' else 0,start_new_session=os.name!='nt')
    for _ in range(150):
        try: asyncio.run(status()); return endpoint()
        except Exception: time.sleep(.1)
    raise RuntimeError('共享服务未就绪；请查看本机 codex-shared/service.log')


def desktop_installation():
    """Trusted installation discovery, without version/username literals."""
    if sys.platform=='win32':
        script="[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); Get-AppxPackage -Name OpenAI.Codex | Select-Object -ExpandProperty InstallLocation"
        result=subprocess.run(['powershell','-NoProfile','-Command',script],capture_output=True,text=True,encoding='utf-8',timeout=15,creationflags=0x08000000)
        candidates=[Path(line.strip())/'app'/'ChatGPT.exe' for line in result.stdout.splitlines() if line.strip()]
    elif sys.platform=='darwin':
        candidates=[base/name/'Contents'/'MacOS'/binary for base in (Path('/Applications'),Path.home()/'Applications')
            for name in ('Codex.app','ChatGPT.app') for binary in ('Codex','ChatGPT')]
    else: raise RuntimeError('此平台保留独立 CLI；尚未验证桌面联动安装入口')
    found=[path for path in candidates if path.is_file()]
    if len(found)!=1: raise RuntimeError('未找到唯一的可信 Codex 桌面安装；请检查安装状态')
    app=found[0]; asar=app.parent/'resources'/'app.asar' if sys.platform=='win32' else app.parent.parent/'Resources'/'app.asar'
    # This hook is internal/version-sensitive. Discover it in the currently
    # installed bundle, never patch or inject code into the installation.
    if not asar.is_file() or b'CODEX_APP_SERVER_WS_URL' not in asar.read_bytes():
        raise RuntimeError('当前桌面版本未提供已验证的共享执行接入入口')
    return app


def launch_desktop(info):
    app=desktop_installation()
    try:
        value=asyncio.run(status())
        if value['desktop_connected']: return '联动桌面已连接同一个执行服务'
    except Exception: pass
    # Explicit first enable, never kill/restart the user's working Desktop.
    from codex_desktop import running_runtimes
    if running_runtimes(): raise RuntimeError('已有非联动桌面运行中；请在合适时机自行退出桌面版，再点击本入口。不会自动退出或接管现有会话。')
    shared=ensure_service(info)
    launch_env={**os.environ,'CODEX_APP_SERVER_WS_URL':shared['url']}
    # The current Desktop's internal CLI override disables WS even when a URL
    # is supplied. Clear it only for this explicit linked launch, not globally.
    launch_env.pop('CODEX_APP_SERVER_FORCE_CLI',None)
    subprocess.Popen([str(app)],env=launch_env,
        stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
        creationflags=0x08000000 if os.name=='nt' else 0,start_new_session=os.name!='nt')
    return '已启动联动桌面；待桌面连接服务后刷新 Station 会话目录'


async def scan_async(config=None):
    from codex_desktop import SOURCE_KINDS,reference
    shared=endpoint(); rows={}
    async with RPC(shared['url']) as rpc:
        state=await rpc.call('bridge/status',{})
        if not state['desktop_connected']: raise RuntimeError('桌面未连接同一个执行服务，不能接续')
        for archived in (False,True):
            cursor=None; seen=set()
            while len(rows)<100:
                page=await rpc.call('thread/list',{'sourceKinds':SOURCE_KINDS,'useStateDbOnly':True,
                    'archived':archived,'limit':min(60,100-len(rows)),'cursor':cursor})
                for item in page['data']:
                    if item['id'] in rows: continue
                    full=(await rpc.call('thread/read',{'threadId':item['id'],'includeTurns':False}))['thread']
                    # Local recovery data/cwd are still validated. Occupancy is
                    # from this SAME resident service, not a newly created one.
                    row=reference({**full,'archived':archived,'status':{'type':'notLoaded'}},rpc.info['codexHome'],True)
                    live=await rpc.call('bridge/status',{'threadId':item['id']})
                    row.update(title=row['title'].replace('Codex 桌面版','Codex 桌面联动').replace('Codex 本地会话','Codex 桌面联动'),
                        execution_status=live['execution_status'],error=row['error'] or live['detail'])
                    if row['available'] and full.get('status',{}).get('type')!='notLoaded':
                        from codex_shared_service import check_permissions
                        try: check_permissions(live.get('configuration',{}),config or {},Path(row['cwd']))
                        except ValueError as exc: row.update(available=False,error=str(exc))
                    if live['execution_status']=='cleanup-unconfirmed': row.update(available=False)
                    rows[item['id']]=row
                cursor=page.get('nextCursor')
                if not cursor or cursor in seen: break
                seen.add(cursor)
    return list(rows.values())


async def run_task(config,msg,on_state=None):
    shared=endpoint(); journal=TaskJournal(msg['task_id'],'codex')
    if not journal.payload():
        # Preserve LAN transport: its received task is recorded locally too,
        # without changing Hub pairing/protocol or inventing a native session.
        journal.receive(msg,{'local_lan':True})
    async with RPC(shared['url']) as rpc:
        await rpc.call('bridge/task/submit',{'taskId':msg['task_id'],'config':config})
        previous=None
        while not journal.result():
            state=read_json(journal.path/'status.json',{}).get('status','waiting')
            if state!=previous and on_state: await on_state(state)
            previous=state
            state=await rpc.call('bridge/status',{'threadId':journal.payload()['payload']['session_id']},timeout=5)
            if state['generation']!=shared['generation']:
                raise RuntimeError('共享服务实例已换代，原任务状态未确认；不会重新提交')
            await asyncio.sleep(.2)
    return journal.result()


async def reconcile_task(journal):
    shared=endpoint()
    async with RPC(shared['url']) as rpc:
        return await rpc.call('bridge/task/reconcile',{'taskId':journal.task_id})
