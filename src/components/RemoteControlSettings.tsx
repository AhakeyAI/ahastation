import { useEffect, useState } from 'react';
import type { RemoteControlView, RemoteDeviceView, RemoteTaskView } from '../../electron/remote-control-types';

/** Identity and pairing are separate from model authentication. No long-term secret enters this panel. */
export function RemoteControlSettings({compact=false,onAuthenticated}:{compact?:boolean;onAuthenticated?:()=>Promise<unknown>}={}) {
  const [settings, setSettings] = useState<RemoteControlView>();
  const [url, setUrl] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [recovery, setRecovery] = useState('');
  const [devices, setDevices] = useState<RemoteDeviceView[]>([]);
  const [tasks, setTasks] = useState<RemoteTaskView[]>([]);
  const [message, setMessage] = useState('');
  const [pair, setPair] = useState('');
  const [busy, setBusy] = useState(false);
  const [legacyUrl, setLegacyUrl] = useState('');
  const [legacyToken, setLegacyToken] = useState('');
  const [legacyAgent, setLegacyAgent] = useState('');
  async function request(action: string, payload?: Record<string, unknown>) {
    setBusy(true); setMessage('');
    try {
      if(compact&&['login','register','recover'].includes(action)){const configured=await window.vibeMeet.remoteControl.request('configure',{enabled:true,mode:'public',serviceUrl:url||settings?.serviceUrl});if(!configured.ok)throw new Error(configured.error);}
      const reply = await window.vibeMeet.remoteControl.request(action, payload);
      if (!reply.ok) { setMessage(reply.error ?? '请求失败'); return; }
      if (reply.settings) { setSettings(reply.settings); setUrl(reply.settings.serviceUrl); setLogin(reply.settings.login ?? ''); }
      if (reply.devices) setDevices(reply.devices);
      if (reply.tasks) setTasks(reply.tasks);
      if (reply.pair_code) { setPair(reply.pair_code); setMessage(`配对码 ${reply.expires_in ?? 600} 秒内单次有效，请在 Bridge 中输入。`); }
      else if (action !== 'status') setMessage(action === 'cancel' ? '取消请求已记录；等待进程退出确认后才算结束。' : '操作成功');
      if (['login', 'register', 'recover'].includes(action)) { setPassword(''); setRecovery(''); }
      if(compact&&['login','register','recover'].includes(action))await onAuthenticated?.();
    } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
  }
  useEffect(() => { void request('status'); }, []);
  const configure = (enabled: boolean, mode = settings?.mode ?? 'public') => request('configure', { enabled, mode, serviceUrl: url });
  if(compact)return <div className="unified-account">{settings?.loggedIn?<p>Station 已登录：{settings.login} <button disabled={busy} onClick={()=>void request('logout')}>退出登录</button></p>:<><label>Station 账号<input autoComplete="username" value={login} onChange={e=>setLogin(e.target.value)}/></label><label>密码<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/></label><button disabled={busy||!login||!password} onClick={()=>void request('login',{login,password})}>登录并接入本机</button><button disabled={busy||!login||!password} onClick={()=>void request('register',{login,password})}>创建账号并接入本机</button></>}{message&&<p role="status">{message}</p>}<details><summary>高级账号恢复、撤销与旧连接</summary><RemoteControlSettings/></details></div>;
  return <section id="remote-control-settings" className="backend-settings-panel">
    <h2>远端控制（可选）</h2>
    <p>配对自己的电脑，选择已有 Codex / Claude 会话。项目、模型及 CLI 登录保留在远端电脑。</p>
    <label><input type="checkbox" checked={settings?.enabled ?? false} disabled={busy} onChange={(e) => void configure(e.target.checked)} />启用远端控制</label>
    <p>{settings?.mode === 'legacy' ? '当前为 LAN 兼容模式' : settings?.loggedIn ? `已登录远端身份：${settings.login}` : '公网远端身份未登录'}</p>
    {!settings?.securePersistence && <p role="status">系统安全存储不可用，长期凭证只保留在本次进程内；重启后需要登录。</p>}
    {settings?.mode !== 'legacy' && <>
      <p>服务：{settings?.serviceUrl || '尚未配置运营服务地址，请查看高级设置。'}</p>
      <div className="backend-field"><label>远端账号<input autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} /></label></div>
      <div className="backend-field"><label>密码（至少 12 位）<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label></div>
      <button disabled={busy || !login || !password} onClick={() => void request('login', { login, password })}>登录</button>{' '}
      <button disabled={busy || !login || !password} onClick={() => void request('register', { login, password })}>创建远端身份</button>
      <details><summary>凭恢复码恢复身份</summary><p>会撤销全部控制端登录，保留电脑绑定。新恢复码在系统窗口中展示。</p><input type="password" aria-label="恢复码" value={recovery} onChange={(e) => setRecovery(e.target.value)} /><button disabled={busy || !recovery || !password} onClick={() => void request('recover', { login, password, recoveryCode: recovery })}>恢复并设置密码</button></details>
      {settings?.loggedIn && <>
        <button disabled={busy} onClick={() => void request('connection')}>检查服务连接</button>{' '}
        <button disabled={busy} onClick={() => void request('pair')}>添加电脑</button>{' '}
        <button disabled={busy} onClick={() => void request('devices')}>刷新已配对电脑</button>{' '}
        <button disabled={busy} onClick={() => void request('tasks')}>刷新任务</button>
        {pair && <p>短时配对码：<code>{pair}</code>（在远端 Bridge 输入并确认项目授权）</p>}
        {devices.map((device) => <p key={device.id}>{device.name} · {device.online ? '在线' : '离线'} <button disabled={busy} onClick={() => { if (window.confirm('解除配对会请求停止该电脑的远端任务并撤销设备凭证。退出无法确认的任务仍需在电脑端恢复。')) void request('unpair', { deviceId: device.id }); }}>解除配对</button></p>)}
        {tasks.map((task) => <p key={task.task_id}><code>{task.task_id.slice(0, 8)}</code> · {task.status}{task.error && ` · ${task.error}`} {!['done', 'failed', 'cancelled'].includes(task.status) && <button disabled={busy} onClick={() => void request('cancel', { taskId: task.task_id })}>请求停止</button>}</p>)}
        <button disabled={busy} onClick={() => void request('logout')}>退出此登录</button>{' '}<button disabled={busy} onClick={() => void request('logout', { all: true })}>撤销全部控制端登录</button>
      </>}
    </>}
    <details><summary>高级：自托管地址和 LAN 兼容模式</summary>
      <label>模式 <select value={settings?.mode ?? 'public'} disabled={busy} onChange={(e) => void configure(settings?.enabled ?? false, e.target.value as 'public' | 'legacy')}><option value="public">公网身份 / HTTPS</option><option value="legacy">旧 LAN / Tool Token</option></select></label>
      <label>公网服务地址<input type="url" placeholder="运营者提供的 HTTPS 地址" value={url} onChange={(e) => setUrl(e.target.value)} /></label><button disabled={busy} onClick={() => void configure(settings?.enabled ?? false)}>保存地址</button>
      {settings?.mode === 'legacy' && <><p>仅用于可信 LAN 或自行保护的服务。旧配置仍保留；LAN 的停止只停止等待。</p><label>LAN Hub 地址<input value={legacyUrl} placeholder="http://电脑地址:8787" onChange={(e) => setLegacyUrl(e.target.value)} /></label><label>Tool Token<input type="password" value={legacyToken} onChange={(e) => setLegacyToken(e.target.value)} /></label><button disabled={busy || !legacyToken || !legacyUrl} onClick={() => { void window.vibeMeet.backendAuth.setBaseUrl('pocket-vibe', legacyUrl).then(() => window.vibeMeet.backendAuth.setApiKey('pocket-vibe', legacyToken)).then((reply) => { setMessage(reply.ok ? 'LAN 配置已保存' : reply.error ?? '保存失败'); setLegacyToken(''); }); }}>保存 LAN 配置</button></>}
    </details>
    {settings?.mode === 'legacy' && <details><summary>高级 LAN 固定 Agent（原无目标调用）</summary>
      <label>Agent ID<input value={legacyAgent} onChange={(event) => setLegacyAgent(event.target.value)} /></label>
      <button disabled={busy} onClick={() => void window.vibeMeet.backendAuth.setModel('pocket-vibe', legacyAgent.trim()).then((reply) => setMessage(reply.ok ? '旧 Agent 目标已保存；空值清除固定目标' : reply.error ?? '保存失败'))}>保存固定目标</button>
      <p>沿用旧配置字段；空值清除。已选择的原生会话成员始终使用自己的目标，不受此项影响。</p>
    </details>}
    {message && <p role="status">{message}</p>}
  </section>;
}
