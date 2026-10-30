"""Python-free distributable Bridge entry: local settings/tray and background transport.

Helper components run this same packaged executable with normal stdio. No GUI
or user login is invoked by an execution/capability-check component.
"""
from __future__ import annotations
import argparse
import asyncio
import json
import os
import queue
import runpy
import shutil
import sys
import threading
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'examples'))

def service_default():
    value=os.getenv('AHASTATION_REMOTE_SERVICE_URL','')
    if value: return value
    path=Path(sys.executable).parent/'remote-service.json' if getattr(sys,'frozen',False) else ROOT/'remote-service.json'
    try: return json.loads(path.read_text(encoding='utf-8')).get('serviceUrl','')
    except (OSError,ValueError): return ''  # Unconfigured, never pretend an undeployed example is connected.

def component(name,args):
    allowed={'task_process','macos_task','idle_probe','codex_cli_adapter','claude_code_adapter','codex_shared_service'}
    if name not in allowed: raise ValueError('Unknown Bridge component')
    sys.argv=[name]+args
    runpy.run_module(name,run_name='__main__')

class Controller:
    def __init__(self,events): self.events=events; self.loop=None; self.bridges=[]; self.thread=None
    def start(self,settings):
        if self.thread and self.thread.is_alive(): return
        if not settings.get('device_token') or not settings.get('providers'): return
        def background():
            from public_bridge import PublicBridge
            from bridge_settings import root
            async def serve():
                self.loop=asyncio.get_running_loop()
                self.bridges=[PublicBridge(settings['service_url'],settings['device_token'],provider,root()/(provider+'.json'),self.events.put,owner_id=settings.get('owner_id'))
                    for provider in settings['providers']]
                await asyncio.gather(*(bridge.run_forever() for bridge in self.bridges))
            try: asyncio.run(serve())
            except Exception as exc: self.events.put('Bridge 未启动：'+type(exc).__name__)
        self.thread=threading.Thread(target=background,daemon=True); self.thread.start()
    def exit(self):
        if self.loop and self.loop.is_running():
            async def finish(): await asyncio.gather(*(bridge.exit_gracefully() for bridge in self.bridges))
            return asyncio.run_coroutine_threadsafe(finish(),self.loop)

class TrayWindow:
    """Only a visible, ready tray may hide the settings window.

    pystray's setup callback runs after its backend loop starts, on another
    thread. Queue readiness/failure for Tk; never touch widgets there.
    """
    def __init__(self,window,report_error):
        self.window=window; self.report_error=report_error
        self.tray=None; self.started=False; self.events=queue.Queue()

    def start(self,tray):
        self.tray=tray
        def ready(icon):
            if self.tray is not icon: return
            try: icon.visible=True
            except Exception: self.events.put((tray,False))
            else: self.events.put((tray,True))
        try: tray.run_detached(setup=ready)
        except Exception: self.fail()

    def fail(self):
        self.stop()
        self.report_error('当前桌面无可用托盘；窗口保持最小化，可从任务栏恢复或重新打开程序显示设置')

    def poll(self):
        while not self.events.empty():
            tray,ready=self.events.get()
            if tray is not self.tray: continue  # Ignore a late callback after failed startup.
            if ready: self.started=True
            else: self.fail()

    def hide(self):
        self.poll()
        if self.started: self.window.withdraw()
        else: self.window.iconify()

    def stop(self):
        tray=self.tray; self.tray=None; self.started=False
        if tray:
            try: tray.stop()
            except Exception: pass
            # Pinned pystray 0.19.5 starts a non-daemon setup thread before
            # _run_detached. stop() alone cannot wake it if startup raises
            # before _mark_ready; release that queue without showing the icon.
            setup=getattr(tray,'_setup_thread',None)
            ready_queue=getattr(tray,'_Icon__queue',None)
            if setup and ready_queue and setup.is_alive() and not getattr(tray,'_running',False):
                ready_queue.put(None)

def gui(background=False):
    import tkinter as tk
    from tkinter import ttk,filedialog,messagebox
    import httpx
    from bridge_settings import load,save,root,provider_config,save_provider,set_autostart,cli_status,apply_pairing,codex_access,desktop_runtime,mode_settings,mode_binary
    from public_bridge import service_url
    from session_runtime import device_id,SessionLock
    instance=SessionLock('bridge-product','settings')
    if not instance.try_acquire():
        (root()/'open-settings').touch(); instance.close(); return
    settings=load(); events=queue.Queue(); controller=Controller(events)
    window=tk.Tk(); window.title('AhaStation Bridge'); window.geometry('720x800')
    service=tk.StringVar(value=settings.get('service_url',service_default()))
    pair=tk.StringVar(); provider=tk.StringVar(value='codex'); binary=tk.StringVar(value=shutil.which('codex') or '')
    permission=tk.StringVar(value='read-only'); auto=tk.BooleanVar(value=settings.get('autostart',False))
    consent=tk.BooleanVar(value=False); status=tk.StringVar(value='未配对' if not settings.get('device_token') else '启动中')
    access=tk.StringVar(); handoff=tk.BooleanVar(value=False); runtime_status=tk.StringVar(value='尚未识别运行组件')
    frame=ttk.Frame(window,padding=16); frame.pack(fill='both',expand=True)
    ttk.Label(frame,text='AhaStation Bridge · 远端电脑',font=('',16)).pack(anchor='w')
    ttk.Label(frame,text='关闭此窗口后保持后台运行；退出请使用“退出 Bridge”。').pack(anchor='w',pady=6)
    for label,var in [('远端服务 HTTPS 地址',service),('Station 生成的十分钟配对码',pair)]:
        ttk.Label(frame,text=label).pack(anchor='w'); ttk.Entry(frame,textvariable=var).pack(fill='x',pady=4)
    row=ttk.Frame(frame); row.pack(fill='x',pady=6)
    selection=ttk.Combobox(row,textvariable=provider,values=['codex','claude'],state='readonly',width=12); selection.pack(side='left')
    access_box=ttk.Combobox(row,textvariable=access,values=['Codex 桌面版','独立 CLI'],state='readonly',width=18); access_box.pack(side='left',padx=6)
    ttk.Label(frame,textvariable=runtime_status,wraplength=680).pack(anchor='w')
    advanced=ttk.Frame(frame)
    def toggle_advanced():
        if advanced.winfo_manager(): advanced.pack_forget()
        else: advanced.pack(fill='x',after=advanced_toggle)
    advanced_toggle=ttk.Button(frame,text='高级：手工运行程序路径（留空自动识别桌面版）',command=toggle_advanced); advanced_toggle.pack(anchor='w',pady=3)
    ttk.Entry(advanced,textvariable=binary).pack(side='left',fill='x',expand=True,padx=6)
    ttk.Button(advanced,text='选择程序',command=lambda:binary.set(filedialog.askopenfilename() or binary.get())).pack(side='left')
    ttk.Label(frame,text='桌面版无需另装 CLI；组件路径与登录检查留在本机，不上传登录凭证。').pack(anchor='w')
    ttk.Label(frame,text='桌面联动通过同一个本机执行服务接续；桌面运行中按会话等待，结束后直接执行。首次启用需自行退出旧桌面实例，再使用下方入口；不会自动关闭桌面。',wraplength=680).pack(anchor='w')
    permission_box=ttk.Combobox(frame,textvariable=permission,values=['read-only','workspace-write'],state='readonly'); permission_box.pack(fill='x',pady=4)
    ttk.Label(frame,text='独立 Codex CLI 使用 sandbox/never；桌面联动保留原会话模型和审批，所选权限为授权上限；Claude 使用 plan/default。',wraplength=680).pack(anchor='w')
    ttk.Label(frame,text='授权项目根目录（子目录新项目可刷新发现）').pack(anchor='w',pady=4)
    roots=tk.Listbox(frame,height=5); roots.pack(fill='x')
    mode_paths={};previous_mode=''
    def selected_provider(_=None):
        item=settings.get('providers',{}).get(provider.get(),{})
        mode=codex_access(item) if provider.get()=='codex' else 'cli'
        access.set('Codex 桌面版' if mode=='desktop' else '独立 CLI')
        access_box.configure(state='readonly' if provider.get()=='codex' else 'disabled')
        nonlocal previous_mode
        mode_paths.update(desktop=mode_binary(item,'desktop'),cli=mode_binary(item,'cli'))
        binary.set(mode_paths[mode] or (shutil.which(provider.get()) or '' if mode=='cli' else ''))
        previous_mode=access.get()
        handoff.set(item.get('desktop_control_confirmed',False)); runtime_status.set('点击“识别 / 检查登录”获取本机状态')
        permission.set(item.get('permission','read-only')); roots.delete(0,'end')
        for path in item.get('roots',[]): roots.insert('end',path)
    selection.bind('<<ComboboxSelected>>',selected_provider); selected_provider()
    def change_mode(_=None):
        nonlocal previous_mode
        old='desktop' if previous_mode=='Codex 桌面版' else 'cli'
        mode_paths[old]=binary.get()
        chosen='desktop' if access.get()=='Codex 桌面版' else 'cli'
        item=settings.get('providers',{}).get('codex',{})
        binary.set(mode_paths.get(chosen) or item.get(chosen+'_binary','') or (shutil.which('codex') or '' if chosen=='cli' else ''))
        previous_mode=access.get(); runtime_status.set('接入方式已切换，请重新识别；独立 CLI 路径不会覆盖桌面自动发现')
    access_box.bind('<<ComboboxSelected>>',change_mode)
    row=ttk.Frame(frame); row.pack(fill='x',pady=5)
    def add_root():
        path=filedialog.askdirectory()
        if path and path not in roots.get(0,'end'): roots.insert('end',path)
    ttk.Button(row,text='新增授权目录',command=add_root).pack(side='left')
    ttk.Button(row,text='移除选中目录',command=lambda:[roots.delete(i) for i in reversed(roots.curselection())]).pack(side='left',padx=5)
    ttk.Checkbutton(frame,text='确认只授权这些目录，并了解所选 CLI 的执行权限',variable=consent).pack(anchor='w')
    ttk.Checkbutton(frame,text='登录电脑后自动启动（仅当前 OS 用户）',variable=auto).pack(anchor='w',pady=3)
    ttk.Label(frame,textvariable=status,wraplength=600).pack(anchor='w',pady=7)
    tray_error=tk.StringVar()
    ttk.Label(frame,textvariable=tray_error,wraplength=600).pack(anchor='w')
    tray_window=TrayWindow(window,tray_error.set)
    busy=False
    update_link=''
    def work(operation):
        nonlocal busy
        if busy: return
        busy=True
        def run():
            try: result=operation(); events.put(('complete',result))
            except Exception as exc: events.put(('error',str(exc)[:300]))
        threading.Thread(target=run,daemon=True).start()
    def configure():
        if not consent.get(): return messagebox.showerror('授权','请先确认项目和执行权限')
        # Capture Tk values on its own thread; background work never reads widgets.
        chosen=provider.get(); cli=binary.get(); directories=list(roots.get(0,'end')); allowed=permission.get()
        mode='desktop' if chosen=='codex' and access.get()=='Codex 桌面版' else 'cli'; confirmed=handoff.get()
        url=service.get(); code=pair.get().strip(); startup=auto.get()
        def perform():
            info=desktop_runtime(cli) if mode=='desktop' else None
            if mode=='cli':
                check=cli_status(cli,chosen)
                if not check['ok']: raise ValueError(check['error'])
            config=provider_config(chosen,cli,directories,allowed,access=mode,desktop_confirmed=confirmed,runtime=info)
            values=dict(settings); values['providers']=dict(settings.get('providers',{}))
            validated=service_url(url)
            if values.get('device_token') and validated!=values.get('service_url') and not code:
                raise ValueError('切换服务需在新的服务重新配对，不能将旧设备凭证发送到其他地址')
            if code:
                response=httpx.post(validated+'/v2/pairings/claim',json={'pair_code':code,'device_id':device_id(),
                    'name':__import__('socket').gethostname(),'projects_confirmed':True},timeout=20)
                if not response.is_success: raise ValueError('配对失败：HTTP '+str(response.status_code))
                values=apply_pairing(values,validated,response.json())
            if not values.get('device_token'): raise ValueError('请在 Station 登录远端身份并生成配对码')
            save_provider(chosen,config)
            values.update(service_url=validated,autostart=startup)
            previous=settings.get('providers',{}).get(chosen,{})
            values['providers'][chosen]={**mode_settings(previous,mode,cli),'roots':directories,'permission':allowed,'access':mode,
                'desktop_control_confirmed':confirmed,**({'runtime_info':info} if info else {})}
            save(values); set_autostart(startup)
            return values
        work(perform)
    def check_login():
        chosen=provider.get(); cli=binary.get()
        mode='desktop' if chosen=='codex' and access.get()=='Codex 桌面版' else 'cli'
        def check():
            if mode=='desktop':
                info=desktop_runtime(cli)
                from codex_shared import support_error
                error=support_error()
                return {'message':f"Codex 桌面版组件 {info['version']} · {info['source']} · 已登录；"+(error or '联动桌面已连接共享服务'),'runtime_info':info}
            return {'message':cli_status(cli,chosen).get('error') or chosen+' 已登录'}
        work(check)
    def start_linked_desktop():
        manual=binary.get() if access.get()=='Codex 桌面版' else ''
        def perform():
            from codex_shared import launch_desktop
            return {'message':launch_desktop(desktop_runtime(manual))}
        work(perform)
    ttk.Button(frame,text='启动联动桌面（首次启用 / 以后打开桌面）',command=start_linked_desktop).pack(anchor='w',pady=4)
    def unpair():
        if not messagebox.askyesno('解除配对','停止本 Bridge 的任务并解除此电脑配对？'): return
        def perform():
            future=controller.exit()
            if future: future.result(timeout=30)
            values=dict(settings)
            if values.get('device_token'):
                response=httpx.post(values['service_url']+'/v2/device/unpair',headers={'Authorization':'Bearer '+values['device_token']},timeout=20)
                if not response.is_success and response.status_code!=401: raise ValueError('云端解除配对未确认；保留凭证供重试')
            values.pop('device_token',None); values.pop('device_token_dpapi',None); save(values)
            return values
        work(perform)
    def check_update():
        url=settings.get('service_url')
        if not url: return status.set('尚未配置服务')
        def perform():
            response=httpx.get(url+'/v2/version',timeout=15); response.raise_for_status(); data=response.json()
            link=data.get('download_url','')
            return {'message':f"服务协议 {data.get('protocol')}；本机 Bridge 0.2.0；服务版本 {data.get('bridge_version','未知')}。"+('可点击下载页面安装运营者提供的版本。' if link else '运营者尚未配置下载地址。'), 'download_url':link}
        work(perform)
    def open_update():
        from urllib.parse import urlsplit
        parsed=urlsplit(update_link)
        if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password:
            return status.set('没有有效的 HTTPS 更新下载地址')
        import webbrowser
        webbrowser.open(update_link)  # Only explicit user click; never silent install.
    quitting=False
    def quit_bridge():
        nonlocal quitting
        if quitting: return
        quitting=True; status.set('正在退出并请求任务清理；退出未确认记录会保留')
        future=controller.exit()
        def poll_exit():
            if future and not future.done(): window.after(200,poll_exit); return
            tray_window.stop()
            instance.close(); window.destroy()
        poll_exit()
    row=ttk.Frame(frame); row.pack(fill='x',pady=5)
    for label,handler in [('识别 / 检查登录',check_login),('配对 / 保存授权',configure),('解除配对',unpair),('检查更新',check_update),('下载页面',open_update),('退出 Bridge',quit_bridge)]:
        ttk.Button(row,text=label,command=handler).pack(side='left',padx=2)
    try:
        import pystray
        from PIL import Image,ImageDraw
        icon=Image.new('RGB',(64,64),'#1f2430'); draw=ImageDraw.Draw(icon); draw.text((14,23),'Aha',fill='#74dcba')
        tray=pystray.Icon('AhaStationBridge',icon,'AhaStation Bridge',menu=pystray.Menu(
            pystray.MenuItem('设置 / 状态',lambda:window.after(0,window.deiconify)),
            pystray.MenuItem('退出 Bridge',lambda:window.after(0,quit_bridge))))
        tray_window.start(tray)
    except Exception: tray_window.fail()
    window.protocol('WM_DELETE_WINDOW',tray_window.hide)
    def drain():
        nonlocal busy,settings,update_link
        tray_window.poll()
        marker=root()/'open-settings'
        if marker.exists(): marker.unlink(); window.deiconify()
        while not events.empty():
            event=events.get()
            if isinstance(event,tuple):
                busy=False
                if event[0]=='error': status.set(event[1])
                elif 'message' in event[1]:
                    status.set(event[1]['message']); update_link=event[1].get('download_url',update_link)
                    if event[1].get('runtime_info'):
                        info=event[1]['runtime_info']; runtime_status.set(f"已识别 {info['version']} · {info['source']}\n{info['binary']}")
                else:
                    settings=event[1]; pair.set(''); consent.set(False); status.set('已保存；后台重启连接')
                    future=controller.exit()
                    def restart():
                        if future and not future.done(): window.after(100,restart); return
                        if controller.thread and controller.thread.is_alive(): window.after(100,restart); return
                        controller.start(settings)
                    restart()
            else: status.set(event)
        if not quitting: window.after(200,drain)
    controller.start(settings); window.after(200,drain)
    if access.get()=='Codex 桌面版': window.after(0,check_login)
    if background and settings.get('device_token'): tray_window.hide()
    window.mainloop()

def main():
    if '--component' in sys.argv:
        index=sys.argv.index('--component'); return component(sys.argv[index+1],sys.argv[index+2:])
    parser=argparse.ArgumentParser(); parser.add_argument('--background',action='store_true'); parser.add_argument('--background-child',action='store_true'); parser.add_argument('--self-test',action='store_true')
    args=parser.parse_args()
    if args.self_test:
        import tkinter
        tcl_version=tkinter.Tcl().eval('info patchlevel')
        from bridge_settings import provider_config
        from public_bridge import PublicBridge
        from runtime_entry import python_command
        from codex_desktop import SOURCE_KINDS
        from codex_shared_service import Admission,Gateway
        from codex_shared import run_task,launch_desktop
        print(json.dumps({'ok':True,'protocol':2,'version':'0.2.0','frozen':bool(getattr(sys,'frozen',False)),'tcl':tcl_version,'helper':python_command('task_process.py'),'desktop_catalog_sources':SOURCE_KINDS,'shared_desktop_modules':True})); return
    if os.name=='nt' and getattr(sys,'frozen',False) and not args.background_child:
        import subprocess
        subprocess.Popen([sys.executable,'--background-child']+(['--background'] if args.background else []),creationflags=0x08000000)
        return
    gui(args.background)

if __name__=='__main__': main()
