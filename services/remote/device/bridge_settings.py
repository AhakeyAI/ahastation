"""User-scoped product settings, credential protection and provider setup."""
import ctypes
import json
import os
import subprocess
import sys
from pathlib import Path
from session_runtime import state_dir
from task_journal import write_json,read_json
from runtime_entry import python_command

def root():
    path=state_dir()/'remote'; path.mkdir(exist_ok=True,mode=0o700)
    if os.name!='nt': path.chmod(0o700)
    return path

def dpapi(data,encrypt=True):
    from ctypes import wintypes
    class Blob(ctypes.Structure): _fields_=[('size',wintypes.DWORD),('data',ctypes.POINTER(ctypes.c_ubyte))]
    source=ctypes.create_string_buffer(data); incoming=Blob(len(data),ctypes.cast(source,ctypes.POINTER(ctypes.c_ubyte))); outgoing=Blob()
    crypt=ctypes.WinDLL('crypt32',use_last_error=True); kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    operation=crypt.CryptProtectData if encrypt else crypt.CryptUnprotectData
    operation.argtypes=[ctypes.POINTER(Blob),ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,wintypes.DWORD,ctypes.POINTER(Blob)]
    kernel.LocalFree.argtypes=[ctypes.c_void_p]
    if not operation(ctypes.byref(incoming),None,None,None,None,1,ctypes.byref(outgoing)):
        raise ctypes.WinError(ctypes.get_last_error())
    try: return ctypes.string_at(outgoing.data,outgoing.size)
    finally: kernel.LocalFree(outgoing.data)

def load():
    values=read_json(root()/'settings.json',{'schema':1,'providers':{},'autostart':False})
    if values.get('device_token_dpapi'):
        values['device_token']=dpapi(bytes.fromhex(values['device_token_dpapi']),False).decode()
    return values

def save(values):
    disk={key:value for key,value in values.items() if key not in {'device_token','device_token_dpapi'}}
    token=values.get('device_token')
    if token:
        if os.name=='nt': disk['device_token_dpapi']=dpapi(token.encode()).hex()
        else: disk['device_token']=token  # 0700 directory, atomic 0600 file; no permissive fallback.
    write_json(root()/'settings.json',disk)

def cli_status(binary,provider):
    try:
        from claude_code_adapter import platform_command
        command=[binary]+(['login','status'] if provider=='codex' else ['auth','status'])
        result=subprocess.run(platform_command(command),capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=15,
            creationflags=0x08000000 if os.name=='nt' else 0)
        logged=result.returncode==0
        if provider=='claude':
            try: logged=logged and json.loads(result.stdout).get('loggedIn') is True
            except ValueError: logged=False
        return {'ok':logged,'error':'' if logged else f'{provider} CLI 未登录或认证检查失败；请先在官方 CLI 完成登录'}
    except (OSError,subprocess.TimeoutExpired): return {'ok':False,'error':f'{provider} CLI 不可执行或检查超时'}

def codex_access(saved):
    # Existing explicit CLI settings are never silently migrated to auto discovery.
    return saved.get('access') or ('cli' if saved.get('binary') or sys.platform not in {'win32','darwin'} else 'desktop')


def mode_settings(previous, mode, binary):
    """Migrate legacy binary into its old mode before saving the new mode."""
    value=dict(previous)
    old=codex_access(previous)
    value.setdefault(old+'_binary',previous.get('binary',''))
    value.update(access=mode,binary=binary)
    value[mode+'_binary']=binary
    return value


def mode_binary(saved,mode):
    if mode+'_binary' in saved: return saved[mode+'_binary']
    return saved.get('binary','') if codex_access(saved)==mode else ''

def desktop_runtime(manual=''):
    from codex_desktop import discover_runtime
    info=discover_runtime(manual)
    write_json(root()/'codex-desktop-runtime.json',info)  # Local metadata only, never credentials.
    if not info['logged_in']: raise ValueError('Codex 桌面版运行组件尚未登录；请在官方桌面版完成登录')
    return info

def provider_config(provider,binary,roots,permission,*,access='cli',desktop_confirmed=False,runtime=None):
    if not roots: raise ValueError('至少选择一个允许访问的项目根目录')
    if provider not in {'codex','claude'}: raise ValueError('Unsupported CLI provider')
    from project_policy import authorized_cwd
    policy={'confirmed':True,'roots':[str(Path(path).resolve(strict=True)) for path in roots]}
    for path in policy['roots']: authorized_cwd(path,policy)
    if permission not in {'read-only','workspace-write'}: raise ValueError('Invalid local execution permission')
    examples=Path(__file__).resolve().parents[1]/'examples'
    adapter=examples/('codex_cli_adapter.py' if provider=='codex' else 'claude_code_adapter.py')
    args=[] if provider=='codex' and access=='desktop' and not binary else ['--binary',binary]
    if provider=='codex': args+=['--sandbox',permission,'--approval','never']
    else: args+=['--permission-mode','plan' if permission=='read-only' else 'default']
    if provider=='codex' and access=='desktop':
        args+=['--desktop']
        if not binary: args+=['--desktop-auto']
        if desktop_confirmed: args+=['--desktop-control-confirmed']
    config={'command':python_command(adapter)+args,'cli_binary':binary,'capabilities':[provider+'.exec'],
        'project_policy':policy,'working_dir':policy['roots'][0],'timeout_seconds':300,
        'display_name':provider.title(),'route_by_default':True}
    if provider=='codex' and access=='desktop':
        config.update(codex_access='desktop',desktop_manual_binary=binary,
            desktop_permission=permission,
            desktop_control_confirmed=desktop_confirmed,runtime_info=runtime or {},
            cli_binary=(runtime or {}).get('binary',binary),display_name='Codex 桌面版')
    return config

def apply_pairing(values,url,claimed):
    result={**values,'providers':dict(values.get('providers',{}))}
    if claimed.get('protocol')!=2 or claimed.get('device_id')!=__import__('session_runtime').device_id():
        raise ValueError('配对协议或设备身份不匹配')
    if values.get('owner_id')!=claimed['owner_id'] or values.get('service_url')!=url:
        result['providers']={}  # A new owner/service must authorize each provider locally again.
    result.update(device_token=claimed['device_token'],owner_id=claimed['owner_id'])
    return result

def save_provider(provider,config):
    path=root()/(provider+'.json'); write_json(path,config); return path

def set_autostart(enabled,executable=None):
    command=python_command(Path(__file__).with_name('bridge_app.py'))+['--background']
    if executable: command=[executable,'--background']
    if os.name=='nt':
        import winreg
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER,r'Software\Microsoft\Windows\CurrentVersion\Run') as key:
            if enabled: winreg.SetValueEx(key,'AhaStationBridge',0,winreg.REG_SZ,subprocess.list2cmdline(command))
            else:
                try: winreg.DeleteValue(key,'AhaStationBridge')
                except FileNotFoundError: pass
    elif sys.platform=='darwin':
        import plistlib
        path=Path.home()/'Library'/'LaunchAgents'/'com.ahastation.bridge.plist'
        if enabled:
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_bytes(plistlib.dumps({'Label':'com.ahastation.bridge','ProgramArguments':command,'RunAtLoad':True,
                'ProcessType':'Interactive','StandardOutPath':str(root()/'startup.log'),'StandardErrorPath':str(root()/'startup.log')}))
            path.chmod(0o600)
        else: path.unlink(missing_ok=True)
    else:
        path=Path.home()/'.config'/'autostart'/'ahastation-bridge.desktop'
        if enabled:
            # Desktop-entry escaping, no shell interpretation of selected paths.
            quoted=' '.join('"'+value.replace('\\','\\\\').replace('"','\\"').replace('`','\\`').replace('$','\\$').replace('%','%%')+'"' for value in command)
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text('[Desktop Entry]\nType=Application\nName=AhaStation Bridge\nExec='+quoted+'\nTerminal=false\n',encoding='utf-8'); path.chmod(0o600)
        else: path.unlink(missing_ok=True)
