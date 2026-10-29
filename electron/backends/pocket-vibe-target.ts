/** References only. Paths belong to the remote computer; never resolve them locally. */
export interface PocketVibeRemoteTarget {
  agent_id: string;
  provider: 'codex' | 'claude';
  session_id: string;
  cwd: string;
  title: string;
  computer_name?: string;
  /** Shared computer/user identity; absent only in legacy saved references. */
  device_id?: string;
  /** Optional public identity binding; old LAN references remain valid. */
  service_url?: string;
  owner_id?: string;
}

export interface PocketVibeRemoteHost {
  id: string;
  remoteTarget: PocketVibeRemoteTarget;
}

export interface PocketVibeRemoteDirectory {
  controlMode?: 'public' | 'legacy';
  status: 'connected' | 'disconnected';
  sessions: Array<PocketVibeRemoteTarget & { execution_status?: string; native_client_status?: 'unknown'; available?: boolean; error?: string }>;
  agents: Array<{
    agent_id: string;
    device_id?: string;
    computer_name: string;
    display_name: string;
    provider: string;
    status: 'scanning' | 'ready' | 'empty' | 'failed' | 'unsupported';
    error?: string;
  }>;
}

export function parsePocketVibeRemoteTarget(value: unknown): PocketVibeRemoteTarget | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (r.provider !== 'codex' && r.provider !== 'claude') return null;
  for (const key of ['service_url', 'owner_id'] as const) {
    if (r[key] !== undefined && (typeof r[key] !== 'string' || !r[key].trim() || r[key].length > 2048 || /[\x00-\x1f]/.test(r[key]))) return null;
  }
  if (r.device_id !== undefined && (typeof r.device_id !== 'string' || !r.device_id.trim()
    || r.device_id.length > 256 || /[\x00-\x1f]/.test(r.device_id))) return null;
  for (const [key, limit] of [['agent_id', 256], ['session_id', 256], ['cwd', 4096], ['title', 160]] as const) {
    if (typeof r[key] !== 'string' || !r[key].trim() || r[key].length > limit || /[\x00-\x1f]/.test(r[key])) return null;
  }
  return {
    agent_id: r.agent_id as string, provider: r.provider,
    session_id: r.session_id as string, cwd: r.cwd as string, title: r.title as string,
    ...(typeof r.service_url === 'string' ? { service_url: r.service_url } : {}),
    ...(typeof r.owner_id === 'string' ? { owner_id: r.owner_id } : {}),
    ...(typeof r.computer_name === 'string' ? { computer_name: r.computer_name.slice(0, 160) } : {}),
    ...(typeof r.device_id === 'string' && r.device_id.trim() && r.device_id.length <= 256 && !/[\x00-\x1f]/.test(r.device_id)
      ? { device_id: r.device_id } : {}),
  };
}

export function remoteSessionKey(target: PocketVibeRemoteTarget): string {
  return JSON.stringify([target.device_id ? `device:${target.device_id}` : `legacy-agent:${target.agent_id}`, target.provider, target.session_id]);
}

/** Explicit remote mentions must never be interpreted as an unaddressed local send. */
export function remoteMentionIds(text: string, hosts: Array<{ id: string; backendId?: string; remoteTarget?: PocketVibeRemoteTarget }>, includeLegacyPocket = false): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/@([a-zA-Z0-9._-]+)/g)) {
    if (match.index && /[a-zA-Z0-9_.+-]/.test(text[match.index - 1])) continue; // Email/ordinary @ text is not a member selection.
    const token = match[1].toLowerCase();
    const host = hosts.find((item) => (item.remoteTarget || (includeLegacyPocket && item.backendId === 'pocket-vibe')) && item.id.toLowerCase() === token);
    if (host) ids.add(host.id);
    else if (token === 'pocket-vibe') {
      const remote = hosts.filter((item) => item.remoteTarget || (includeLegacyPocket && item.backendId === 'pocket-vibe'));
      if (remote.length === 1) ids.add(remote[0].id);
      else if (!remote.length && hosts.some((item) => item.backendId === 'pocket-vibe' && !item.remoteTarget)) continue;
      else ids.add(token); // Missing or ambiguous target: fail closed.
    } else if (/^pocket-vibe-[0-9a-f-]{36}$/.test(token)) ids.add(token);
  }
  return [...ids];
}

export const REMOTE_ATTACHMENT_ERROR = '远端会话当前仅支持文本，请移除图片或附件后发送；本次未执行。';

/** Enrich old references only through their exact execution entry; never retarget silently. */
export function resolveRemoteTarget(target: PocketVibeRemoteTarget, directory: PocketVibeRemoteDirectory): PocketVibeRemoteTarget {
  const agent = directory.agents.find((item) => item.agent_id === target.agent_id);
  if (!agent) throw new Error('所选远端 Agent 已离线，本次未排队。');
  if (agent.provider !== target.provider) throw new Error('所选远端 Agent 的 provider 与保存的引用不匹配。');
  if (agent.status !== 'ready' && agent.status !== 'empty') throw new Error(agent.error || '远端会话目录尚未就绪，请刷新后重试。');
  const current = directory.sessions.find((item) => item.agent_id === target.agent_id && item.provider === target.provider && item.session_id === target.session_id);
  if (!current || current.cwd !== target.cwd) throw new Error('所选原生会话已失效或项目目录已改变，请重新选择。');
  if ((target.service_url && target.service_url !== current.service_url) || (target.owner_id && target.owner_id !== current.owner_id)) {
    throw new Error('该远端成员属于其他服务或身份，请登录原身份或重新选择会话。');
  }
  if (current.available === false) throw new Error(current.error || '远端项目目录已不可用，请在电脑端检查。');
  if (!current.device_id) throw new Error('Bridge 缺少稳定设备标识，请更新并重启 Bridge 后刷新目录。');
  if (target.device_id && target.device_id !== current.device_id) throw new Error('远端设备与保存的会话引用不匹配，请重新选择。');
  const canonical = parsePocketVibeRemoteTarget(current);
  if (!canonical) throw new Error('Hub 返回的远端会话引用格式无效。');
  return canonical;
}

export function remoteSessionLabel(target: PocketVibeRemoteTarget): string {
  return `${target.title} · ${target.computer_name || target.agent_id} · ${target.provider} ${target.session_id.slice(0, 8)}`;
}

/** Sanitize optional settings/snapshot references without retaining unrelated data. */
export function parsePocketVibeRemoteHosts(value: unknown): PocketVibeRemoteHost[] {
  if (!Array.isArray(value)) return [];
  const hosts: PocketVibeRemoteHost[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const target = parsePocketVibeRemoteTarget(item.remoteTarget);
    if (typeof item.id !== 'string' || item.id === 'default' || !/^[a-zA-Z0-9._-]{1,64}$/.test(item.id) || !target) continue;
    if (hosts.some((host) => host.id === item.id || remoteSessionKey(host.remoteTarget) === remoteSessionKey(target))) continue;
    hosts.push({ id: item.id, remoteTarget: target });
  }
  return hosts;
}
