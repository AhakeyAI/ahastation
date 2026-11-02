// Public remote identity belongs to Electron main, independently of model auth.
import { app, clipboard, dialog, ipcMain, webContents } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSettings, updateRemoteControlFields, getBackendAuth, remoteCredentialStorageAvailable } from './store.js';
import type { BackendAuthConfig } from './backends/cli-backend.js';
import type { RemoteControlReply, RemoteControlSettings, RemoteControlView } from './remote-control-types.js';
import { collaborationFetch } from './collaboration/network.js';

function broadcastRemoteChange(): void {
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send('remote-control:changed');
  }
}

export function validateRemoteServiceUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('远端服务地址无效');
  const url = new URL(value);
  const localTest = process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK === '1'
    && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localTest) || url.username || url.password || url.search || url.hash) {
    throw new Error('公网远端服务必须使用 HTTPS，地址不能包含凭证或查询参数');
  }
  return url.href.replace(/\/+$/, '');
}

export function remoteServiceDefault(): string {
  const env = process.env.AHASTATION_REMOTE_SERVICE_URL;
  if (env) return validateRemoteServiceUrl(env);
  for (const path of [process.resourcesPath ? join(process.resourcesPath, 'remote-service.json') : '',
    join(app.getAppPath?.() ?? process.cwd(), 'resources', 'remote-service.json')]) {
    if (!path) continue;
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as { serviceUrl?: string };
      if (data.serviceUrl) return validateRemoteServiceUrl(data.serviceUrl);
    } catch { /* No deployed default: present an unconfigured service, never a fake URL. */ }
  }
  return '';
}

export function getRemoteControlSettings(): RemoteControlSettings {
  const stored = getSettings().remoteControl;
  return stored ?? { enabled: false, mode: getBackendAuth('pocket-vibe')?.apiKey ? 'legacy' : 'public', serviceUrl: remoteServiceDefault() };
}

export function remoteControlView(): RemoteControlView {
  const state = getRemoteControlSettings();
  return { enabled: state.enabled, mode: state.mode, serviceUrl: state.serviceUrl, login: state.login, ownerId: state.ownerId,
    loggedIn: Boolean(state.controlToken && !state.credentialInvalid), securePersistence: remoteCredentialStorageAvailable() };
}

export function getPocketVibeConnection(): BackendAuthConfig & { publicMode?: boolean; remoteOwnerId?: string } {
  const state = getRemoteControlSettings();
  if (state.mode === 'public') return { authMode: 'apikey', baseUrl: state.serviceUrl,
    apiKey: state.enabled && !state.credentialInvalid ? state.controlToken : undefined, publicMode: true, remoteOwnerId: state.ownerId };
  return getBackendAuth('pocket-vibe') ?? { authMode: 'none' };
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  let text = ''; let size = 0;
  if (reader) {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const row = await reader.read();
        if (row.done) break;
        size += row.value.length;
        if (size > 512 * 1024) { await reader.cancel(); throw new Error('远端响应超过大小限制'); }
        text += decoder.decode(row.value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
  } else text = await response.text();
  const data: unknown = text ? JSON.parse(text) : {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('远端服务响应格式无效');
  return data as Record<string, unknown>;
}

export async function remoteRequest(path: string, method = 'GET', body?: unknown, authenticated = true,
  fetchImpl: typeof fetch = collaborationFetch): Promise<Record<string, unknown>> {
  const state = getRemoteControlSettings();
  if (!state.serviceUrl) throw new Error('远端服务尚未部署或配置，请先设置有效的服务地址');
  const base = validateRemoteServiceUrl(state.serviceUrl);
  if (authenticated && (!state.enabled || !state.controlToken || state.credentialInvalid)) throw new Error('请启用远端控制并登录远端身份');
  const response = await fetchImpl(base + path, { method, headers: {
    ...(authenticated ? { Authorization: `Bearer ${state.controlToken}` } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20_000) });
  const data = await boundedJson(response);
  const latest = getRemoteControlSettings();
  if (latest.serviceUrl !== state.serviceUrl || (authenticated && (latest.ownerId !== state.ownerId || latest.controlToken !== state.controlToken))) {
    throw new Error('远端身份或服务地址已变化，请刷新后重试');
  }
  if (!response.ok) {
    if (authenticated && response.status === 401) {
      await updateRemoteControlFields((current) =>
      current?.controlToken === state.controlToken && current?.serviceUrl === state.serviceUrl
        ? { ...current, credentialInvalid: true } : current ?? state);
      broadcastRemoteChange();
    }
    throw new Error(response.status === 401 ? '远端凭证已失效或撤销，请重新登录' : `远端服务 HTTP ${response.status}：${String(data.detail ?? '请求失败').slice(0, 300)}`);
  }
  return data;
}

export async function remoteControlAction(action: string, payload: Record<string, unknown> = {},
  options: { fetchImpl?: typeof fetch; showRecovery?: (login: string, code: string) => Promise<void> } = {}): Promise<RemoteControlReply> {
  try {
    const state = getRemoteControlSettings();
    const request = (path: string, method = 'GET', body?: unknown, auth = true) => remoteRequest(path, method, body, auth, options.fetchImpl);
    if (action === 'status') return { ok: true, settings: remoteControlView() };
    if (action === 'configure') {
      if (typeof payload.enabled !== 'boolean' || !['public', 'legacy'].includes(String(payload.mode))) throw new Error('远端设置参数无效');
      const serviceUrl = payload.serviceUrl ? validateRemoteServiceUrl(payload.serviceUrl) : '';
      const changed = state.serviceUrl !== serviceUrl;
      if (changed || state.enabled && !payload.enabled || state.mode !== payload.mode) {
        const { stationService } = await import('./collaboration/station-service.js');
        if (stationService() && !await stationService()!.shutdown()) throw new Error('原账号本机执行退出未确认，请核对后再更换服务或停用协作');
      }
      await updateRemoteControlFields((current) => ({ ...(current ?? state), enabled: payload.enabled as boolean, mode: payload.mode as 'public' | 'legacy', serviceUrl,
        ...(changed ? { controlToken: undefined, controlTokenEnc: undefined, ownerId: undefined, login: undefined } : {}) }));
      return { ok: true, settings: remoteControlView() };
    }
    if (['register', 'login', 'recover'].includes(action)) {
      if (state.mode !== 'public') throw new Error('请切换到公网远端身份模式');
      if (typeof payload.login !== 'string' || typeof payload.password !== 'string') throw new Error('请输入账号和密码');
      const data = await request(`/v2/auth/${action}`, 'POST', { login: payload.login, password: payload.password, recovery_code: payload.recoveryCode }, false);
      if (typeof data.control_token !== 'string' || typeof data.owner_id !== 'string' || typeof data.login !== 'string') throw new Error('远端身份响应无效');
      if (state.ownerId && state.ownerId !== data.owner_id) {
        const { stationService } = await import('./collaboration/station-service.js');
        if (stationService() && !await stationService()!.shutdown()) throw new Error('原账号本机执行退出未确认，请核对后再切换账号');
      }
      await updateRemoteControlFields((current) => {
        if (current && (current.serviceUrl !== state.serviceUrl || current.mode !== 'public')) throw new Error('连接设置已变化，请重试登录');
        return { ...(current ?? state), enabled: true, controlToken: data.control_token as string, controlTokenEnc: undefined,
        ownerId: data.owner_id, login: data.login, credentialInvalid: false,
      } as RemoteControlSettings; });
      if (typeof data.recovery_code === 'string') {
        const show = options.showRecovery ?? (async (login: string, code: string) => {
          const result = await dialog.showMessageBox({ type: 'info', title: '保存远端身份恢复码',
            message: `请保存账号 ${login} 和恢复码。恢复会撤销控制端登录，保留电脑绑定。`, detail: code,
            buttons: ['复制恢复码', '已安全保存'], defaultId: 1, cancelId: 1 });
          if (result.response === 0) clipboard.writeText(`${login}\n${code}`);
        });
        await show(data.login, data.recovery_code);
      }
      return { ok: true, settings: remoteControlView() }; // No permanent token or recovery code crosses IPC.
    }
    if (action === 'connection') {
      const data = await request('/v2/me');
      if (data.owner_id !== state.ownerId || data.protocol !== 2) throw new Error('远端身份或协议不匹配，请重新登录或更新客户端');
      return { ok: true, settings: remoteControlView() };
    }
    if (action === 'devices') {
      const rows = (await request('/v2/devices')).devices;
      if (!Array.isArray(rows)) throw new Error('电脑目录响应无效');
      return { ok: true, devices: rows.slice(0, 100).filter((row) => row && typeof row.id === 'string').map((row) => ({
        id: row.id, name: String(row.name ?? '').slice(0, 160), online: row.online === true,
      })) };
    }
    if (action === 'pair') {
      const data = await request('/v2/pairings', 'POST');
      return { ok: true, pair_code: String(data.pair_code), expires_in: Number(data.expires_in) };
    }
    if (action === 'unpair') {
      const data = await request(`/v2/devices/${encodeURIComponent(String(payload.deviceId))}`, 'DELETE');
      return data.cleanup_confirmed === false ? { ok: false, error: '配对已解除，但原任务退出尚未确认，请在电脑端检查恢复记录。' } : { ok: true };
    }
    if (action === 'tasks') {
      const rows = (await request('/v2/tasks')).tasks;
      if (!Array.isArray(rows)) throw new Error('任务列表响应无效');
      return { ok: true, tasks: rows.slice(0, 100).filter((row) => row && typeof row.task_id === 'string').map((row) => ({
        task_id: row.task_id, status: String(row.status ?? '').slice(0, 40), error: String(row.error ?? '').slice(0, 1000),
      })) };
    }
    if (action === 'cancel') {
      await request(`/v1/turns/${encodeURIComponent(String(payload.taskId))}/cancel`, 'POST');
      return { ok: true }; // The task's later result, not this response, proves exit.
    }
    if (action === 'logout') {
      const { stationService } = await import('./collaboration/station-service.js');
      if (stationService() && !await stationService()!.shutdown()) throw new Error('本机 Station 任务退出未确认，请核对原任务后再退出协作账号');
      await request('/v2/logout', 'POST', { all: payload.all === true });
      await updateRemoteControlFields((current) => current?.controlToken === state.controlToken
        ? { ...(current ?? state), controlToken: undefined, controlTokenEnc: undefined, credentialInvalid: false } : current ?? state);
      return { ok: true, settings: remoteControlView() };
    }
    throw new Error('未知的远端设置操作');
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : '远端服务请求失败' }; }
}

export function registerRemoteControlIpc(): void {
  ipcMain.handle('remote-control:request', async (_event, action: unknown, payload: unknown) => {
    if (typeof action !== 'string' || (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload)))) {
      return { ok: false, error: '远端设置请求无效' };
    }
    const result = await remoteControlAction(action, payload as Record<string, unknown> | undefined);
    if (result.ok && result.settings && action !== 'status') broadcastRemoteChange();
    if (result.ok && ['register','login','recover'].includes(action)) {
      const { stationService } = await import('./collaboration/station-service.js');
      void stationService()?.action('connect').catch(() => {});
    }
    return result;
  });
}

export function remotePendingKey(target: { device_id?: string; provider: string; session_id: string; service_url?: string; owner_id?: string }): string {
  const state = getRemoteControlSettings();
  return JSON.stringify([target.service_url ?? state.serviceUrl, target.owner_id ?? state.ownerId, target.device_id, target.provider, target.session_id]);
}
export function getRemotePending(key: string): string | undefined { return getRemoteControlSettings().pendingSubmissions?.[key]; }
export async function setRemotePending(key: string, value?: string, expected?: string): Promise<void> {
  await updateRemoteControlFields((current) => {
    const state = current ?? getRemoteControlSettings(); const pending = { ...state.pendingSubmissions };
    // Compare inside the existing settings write lock, including across a
    // restored session and a late cancellation from its predecessor.
    if (expected !== undefined && pending[key] !== expected) return state;
    if (value) pending[key] = value; else delete pending[key];
    return { ...state, pendingSubmissions: pending };
  });
}
