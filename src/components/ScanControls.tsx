import { useState } from 'react';
import type { ObservedSnapshot } from '../lib/observed-store';

export function ScanControls({ snapshot }: { snapshot: ObservedSnapshot }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const api = window.vibeMeet?.observe;
  const run = async (action?: () => Promise<{ ok: boolean; error?: string }>) => {
    if (!action || busy) return;
    setBusy(true); setError('');
    try { const result = await action(); if (!result.ok) setError(result.error ?? '操作未完成'); }
    catch { setError('扫描设置暂不可用，请重试'); }
    finally { setBusy(false); }
  };
  if (!api?.allowDirectory) return null;
  const groups = [
    { title: '外部会话', sessions: snapshot.sessions.filter((s) => s.origin !== 'user-adopted') },
    { title: '已收编', sessions: snapshot.sessions.filter((s) => s.origin === 'user-adopted') },
  ];
  return <section aria-label="本机会话扫描" className="tasks-scan-controls">
    <span>{snapshot.access?.enabled ? `只读扫描 · 已授权 ${snapshot.access.roots.length} 个目录` : '本机会话扫描未启用'}</span>
    <button type="button" disabled={busy} onClick={() => void run(api.allowDirectory)}>
      {snapshot.access?.enabled ? '添加扫描目录' : '启用只读扫描'}
    </button>
    {snapshot.access?.enabled && <button type="button" disabled={busy} onClick={() => void run(api.disable)}>停用并清除授权</button>}
    {error && <span role="alert">{error}</span>}
    {snapshot.diagnostics?.includes('ownership-unavailable') && <p role="status">会话归属登记暂不可读，相关会话保持待核对。</p>}
    {snapshot.access?.enabled && <details>
      <summary>本机会话与历史任务 · {snapshot.sessions.length + (snapshot.studioTasks?.length ?? 0)} 项</summary>
      <p>观察状态不代表任务已验收。空闲、已结束或超过 24 小时无活动的会话不会计入进行中或待批准。</p>
      <p>允许读取的目录：{snapshot.access.roots.join('、')}</p>
      {groups.filter((group) => group.sessions.length > 0).map((group) => <div key={group.title}>
        <strong>{group.title}</strong>
        <ul>{group.sessions.map((s) => <li key={s.id}>
          {s.clientKind === 'claude-code' ? 'Claude' : 'Codex'} · {s.projectName} · {s.title} · {s.ownership === 'unresolved' ? '归属待核对 · ' : ''}
          {s.phase === 'stopping' ? '停止中' : s.state === 'active' ? '运行中' : s.state === 'waiting' ? '等待输入' : s.state === 'idle' ? '空闲' : s.state === 'done' ? '会话已结束' : '状态未知'}
        </li>)}</ul>
      </div>)}
      {Boolean(snapshot.studioTasks?.length) && <div>
        <strong>AhaStudio 历史任务</strong>
        <ul>{snapshot.studioTasks?.map((task) => <li key={`${task.meetingId}:${task.taskId}`}>{task.title} · 历史记录：{task.status}</li>)}</ul>
      </div>}
    </details>}
  </section>;
}
