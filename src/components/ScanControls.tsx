import { useEffect, useRef, useState } from 'react';
import type { ObservedProjectGroup, ObservedSession, ObservedSnapshot } from '../lib/observed-store';

type IgnoreSession = (id: string) => void;
function SessionRow({ session: s, showProjectName = false, ignore, busy }: {
  session: ObservedSession; showProjectName?: boolean; ignore?: IgnoreSession; busy?: boolean;
}) {
  return <li>
    {s.clientKind === 'claude-code' ? 'Claude' : 'Codex'} · {showProjectName && `${s.projectName} · `}{s.title} · {s.origin === 'user-adopted' ? '已收编 · ' : ''}
    {s.ownership === 'unresolved' ? '归属待核对 · ' : ''}
    {s.phase === 'stopping' ? '停止中' : s.state === 'active' ? '运行中' : s.state === 'waiting' ? '等待输入' : s.state === 'idle' ? '空闲' : s.state === 'done' ? '会话已结束' : '状态未知'}
    {ignore && (s.origin === 'user' || s.origin === 'user-adopted') && s.ownership !== 'unresolved'
      && <button type="button" disabled={busy} aria-label={`忽略会话：${s.title}`} onClick={() => ignore(s.id)}>忽略会话</button>}
  </li>;
}

function ProjectGroup({ group, sessions, ignore, busy }: {
  group: ObservedProjectGroup; sessions: Map<string, ObservedSession>; ignore?: IgnoreSession; busy: boolean;
}) {
  const status = group.status === 'candidate' ? '本机候选项目'
    : group.status === 'pending' ? '项目识别中' : group.status === 'non-git' ? '普通目录' : '项目待核对';
  return <section className="tasks-scan-project" aria-label={`${group.label} · ${status}`}>
    <strong>{group.label}</strong> · {status}
    {group.reason === 'metadata-outside-grant' && <p>仓库元数据位于扫描授权之外，暂不归并项目。</p>}
    {group.reason === 'ownership-unresolved' && <p>会话归属尚未确认，暂不读取项目元数据。</p>}
    {group.reason === 'directory-limit-or-unavailable' && <p>目录暂不可用或已达到本轮识别上限。</p>}
    {group.mounts.map((mount) => <div className="tasks-scan-mount" key={mount.key}>
      <span>{group.status === 'candidate' ? '工作树' : '目录'} · {mount.label}
        {group.status === 'candidate' && ` · ${mount.branch ?? '分离 HEAD'}`}</span>
      <p className="tasks-scan-path">{mount.path}</p>
      <ul>{mount.sessionIds.map((id) => {
        const session = sessions.get(id);
        return session ? <SessionRow key={id} session={session} ignore={ignore} busy={busy} /> : null;
      })}</ul>
    </div>)}
  </section>;
}

export function focusScanControls() {
  const panel = document.getElementById('local-session-scan');
  panel?.focus();
  panel?.scrollIntoView({ block: 'center' });
}

export function ScanControls({ snapshot, reviewRequest = 0 }: { snapshot: ObservedSnapshot; reviewRequest?: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const api = window.vibeMeet?.observe;
  useEffect(() => { if (reviewRequest) focusScanControls(); }, [reviewRequest]);
  const run = async (action?: () => Promise<{ ok: boolean; error?: string }>) => {
    if (!action || inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError('');
    try { const result = await action(); if (!result.ok) setError(result.error ?? '操作未完成'); }
    catch { setError('扫描设置暂不可用，请重试'); }
    finally { inFlight.current = false; setBusy(false); }
  };
  if (!api?.allowDirectory) return null;
  const groups = [
    { title: '外部会话', sessions: snapshot.sessions.filter((s) => s.origin !== 'user-adopted') },
    { title: '已收编', sessions: snapshot.sessions.filter((s) => s.origin === 'user-adopted') },
  ];
  const sessions = new Map(snapshot.sessions.map((session) => [session.id, session]));
  const ignore = api.ignoreSession ? (id: string) => void run(() => api.ignoreSession!(id)) : undefined;
  const preferencesUnavailable = snapshot.diagnostics?.includes('scan-preferences-unavailable');
  const hiddenCount = (snapshot.hidden?.sessions ?? 0) + (snapshot.hidden?.directories ?? 0);
  return <section id="local-session-scan" tabIndex={-1} aria-label="本机会话扫描" className="tasks-scan-controls">
    <span>{snapshot.access?.enabled ? `只读扫描 · 已授权 ${snapshot.access.roots.length} 个目录` : '本机会话扫描未启用'}</span>
    <button type="button" disabled={busy} onClick={() => void run(api.allowDirectory)}>
      {snapshot.access?.enabled ? '添加扫描目录' : '启用只读扫描'}
    </button>
    {snapshot.access?.enabled && <button type="button" disabled={busy} onClick={() => void run(api.disable)}>停用并清除授权</button>}
    {api.restoreHidden && (hiddenCount > 0 || preferencesUnavailable) && <button type="button" disabled={busy}
      onClick={() => void run(api.restoreHidden)}>{preferencesUnavailable ? '重置忽略记录' : `恢复已忽略项（${hiddenCount}）`}</button>}
    {error && <span role="alert">{error}</span>}
    {snapshot.diagnostics?.includes('ownership-unavailable') && <p role="status">会话归属登记暂不可读，相关会话保持待核对。</p>}
    {preferencesUnavailable && <p role="alert">忽略记录暂不可读，扫描已暂停。确认重置后再恢复显示。</p>}
    {snapshot.access?.enabled && Boolean(snapshot.pendingDirectories?.length) && <section className="tasks-scan-pending" aria-label="待授权目录">
      <strong>待授权目录 · {snapshot.pendingDirectories!.length} 项</strong>
      <p>这里只读取了会话标识和目录元数据，尚未读取这些目录的会话标题与状态。确认授权只开启本机只读扫描。</p>
      <ul>{snapshot.pendingDirectories!.map((directory) => <li key={directory.key}>
        <span>{directory.label} · {directory.sessionCount} 个会话</span><p className="tasks-scan-path">{directory.path}</p>
        {api.reviewDirectory && <button type="button" disabled={busy} onClick={() => void run(() => api.reviewDirectory!(directory.key))}>检查只读授权</button>}
        {api.ignoreDirectory && <button type="button" disabled={busy} onClick={() => void run(() => api.ignoreDirectory!(directory.key))}>忽略目录提醒</button>}
      </li>)}</ul>
    </section>}
    {snapshot.access?.enabled && <details>
      <summary>本机会话与历史任务 · {snapshot.sessions.length + (snapshot.studioTasks?.length ?? 0)} 项</summary>
      <p>观察状态不代表任务已验收。空闲、已结束或超过 24 小时无活动的会话不会计入进行中或待批准。</p>
      <p>允许读取的目录：{snapshot.access.roots.join('、')}</p>
      {ignore && <p>忽略只隐藏本机扫描结果，不结束原会话；可通过“恢复已忽略项”重新显示。</p>}
      {snapshot.localProjects && snapshot.localProjects.length > 0 && <p>按本机项目与工作树归类。项目识别不会授予执行或共享权限。</p>}
      {snapshot.localProjects?.map((group) => <ProjectGroup key={group.key} group={group} sessions={sessions} ignore={ignore} busy={busy} />)}
      {!snapshot.localProjects && groups.filter((group) => group.sessions.length > 0).map((group) => <div key={group.title}>
        <strong>{group.title}</strong>
        <ul>{group.sessions.map((s) => <SessionRow key={s.id} session={s} showProjectName ignore={ignore} busy={busy} />)}</ul>
      </div>)}
      {Boolean(snapshot.studioTasks?.length) && <div>
        <strong>AhaStudio 历史任务</strong>
        <ul>{snapshot.studioTasks?.map((task) => <li key={`${task.meetingId}:${task.taskId}`}>{task.title} · 历史记录：{task.status}</li>)}</ul>
      </div>}
    </details>}
  </section>;
}
