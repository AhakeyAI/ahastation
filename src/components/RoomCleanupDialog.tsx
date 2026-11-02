import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { TerminalProfileIcon } from './TerminalProfileIcon';
import type { ProjectRoom, RoomCleanupPlan, RoomCleanupResult } from '../lib/project-rooms';

const CLIENT_LABEL: Record<RoomCleanupPlan['sessions'][number]['clientKind'], string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi',
};
const CLIENT_ICON: Record<RoomCleanupPlan['sessions'][number]['clientKind'], string> = {
  'claude-code': 'claude',
  codex: 'codex',
  kimi: 'kimi',
};

type Worktree = RoomCleanupPlan['worktrees'][number];

/** Safe to tick by default: nothing uncommitted and nothing the main branch lacks. */
function safeWorktree(w: Worktree): boolean {
  return !w.dirty && !w.locked && w.unmerged === 0;
}

function worktreeRisk(w: Worktree, base: string | null): string | null {
  if (w.locked) return '已锁定，不能删除';
  const parts: string[] = [];
  if (w.dirty) parts.push('有未提交的改动');
  if (w.unmerged === null) parts.push('不确定是否已合并');
  else if (w.unmerged > 0) parts.push(`${w.unmerged} 个提交没合并到 ${base ?? '主分支'}`);
  return parts.length ? `${parts.join('，')}，删除后无法找回` : null;
}

interface RoomCleanupDialogProps {
  room: ProjectRoom;
  onClose: () => void;
  /** Cleanup ran; hide the room when everything chosen succeeded. */
  onDone: (allOk: boolean) => void;
}

/**
 * 结束会话并删除分支：先只读列出这个仓库的 AI 会话和工作树，用户勾选后再执行。
 * 默认只勾能安全处理的项：能结束的终端会话，干净且已合并的工作树。
 */
export function RoomCleanupDialog({ room, onClose, onDone }: RoomCleanupDialogProps) {
  const [plan, setPlan] = useState<RoomCleanupPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionIds, setSessionIds] = useState<Set<string>>(new Set());
  const [worktreePaths, setWorktreePaths] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RoomCleanupResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    const api = window.vibeMeet.projects;
    if (!api) { setError('当前版本不支持清理项目室'); return; }
    void api.cleanupPlan(room.cwd).then((res) => {
      if (cancelled) return;
      if (!res.ok) { setError(res.error); return; }
      setPlan(res.plan);
      setSessionIds(new Set(res.plan.sessions.filter((s) => s.closable).map((s) => s.id)));
      setWorktreePaths(new Set(res.plan.worktrees.filter(safeWorktree).map((w) => w.path)));
    }).catch((err) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [room.cwd]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const toggle = (set: Set<string>, setter: (next: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    setter(next);
  };

  const riskyChosen = useMemo(
    () => plan?.worktrees.filter((w) => worktreePaths.has(w.path) && !safeWorktree(w)).length ?? 0,
    [plan, worktreePaths],
  );
  const nothing = sessionIds.size === 0 && worktreePaths.size === 0;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const api = window.vibeMeet.projects;
      if (!api) { setError('当前版本不支持清理项目室'); return; }
      const res = await api.cleanup(room.cwd, [...sessionIds], [...worktreePaths]);
      if (!res.ok) { setError(res.error); return; }
      setResult(res.result);
      const allOk = [...res.result.sessions, ...res.result.worktrees].every((r) => r.ok);
      onDone(allOk);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const failures = result ? [...result.sessions, ...result.worktrees].filter((r) => !r.ok) : [];
  const label = (id: string) => {
    const s = plan?.sessions.find((x) => x.id === id);
    if (s) return `${CLIENT_LABEL[s.clientKind]}：${s.title}`;
    const w = plan?.worktrees.find((x) => x.path === id);
    return w ? (w.branch ?? w.path) : id;
  };

  return (
    <div className="ui-modal-backdrop create-room-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <section className="create-room room-cleanup" role="dialog" aria-modal="true" aria-label={`结束 ${room.name} 的会话并删除分支`}>
        <header className="create-room-head">
          <h2>结束 {room.name} 的会话并删除分支</h2>
          <button type="button" className="create-room-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={16} /></button>
        </header>

        <div className="room-cleanup-body">
          {!plan && !error && <p className="room-cleanup-note">正在读取这个仓库的会话和工作树…</p>}

          {result ? (
            failures.length ? (
              <>
                <p className="room-cleanup-note">有 {failures.length} 项没处理成功，其余已完成：</p>
                <ul className="room-cleanup-failures">
                  {failures.map((f) => <li key={f.id}><strong>{label(f.id)}</strong>{f.error}</li>)}
                </ul>
              </>
            ) : (
              <p className="room-cleanup-note">已完成，项目室已经隐藏。</p>
            )
          ) : plan && (
            <>
              <section className="room-cleanup-section">
                <h3>AI 会话终端</h3>
                {plan.sessions.length === 0 && <p className="room-cleanup-empty">这个项目里没有正在运行的 AI 会话。</p>}
                {plan.sessions.map((s) => (
                  <label key={s.id} className={`room-cleanup-row${s.closable ? '' : ' is-disabled'}`}>
                    <input type="checkbox" disabled={!s.closable || busy} checked={sessionIds.has(s.id)}
                      onChange={() => toggle(sessionIds, setSessionIds, s.id)} />
                    <TerminalProfileIcon id={CLIENT_ICON[s.clientKind]} size={14} />
                    <span className="room-cleanup-main">
                      <span className="room-cleanup-title">{s.title}</span>
                      <small>{CLIENT_LABEL[s.clientKind]}{s.place ? `，在 ${s.place}` : '，在主目录'}{s.reason ? `。${s.reason}` : ''}</small>
                    </span>
                  </label>
                ))}
              </section>

              <section className="room-cleanup-section">
                <h3>工作树和分支</h3>
                {!plan.git && <p className="room-cleanup-empty">这个文件夹不是 git 仓库，没有分支可删。</p>}
                {plan.git && plan.worktrees.length === 0 && (
                  <p className="room-cleanup-empty">没有额外的工作树。主目录和 {plan.baseBranch ?? '当前分支'} 不会被删除。</p>
                )}
                {plan.worktrees.map((w) => {
                  const risk = worktreeRisk(w, plan.baseBranch);
                  return (
                    <label key={w.path} className={`room-cleanup-row${w.locked ? ' is-disabled' : ''}`}>
                      <input type="checkbox" disabled={w.locked || busy} checked={worktreePaths.has(w.path)}
                        onChange={() => toggle(worktreePaths, setWorktreePaths, w.path)} />
                      <span className="room-cleanup-main">
                        <span className="room-cleanup-title">{w.branch ?? '（游离 HEAD）'}</span>
                        <small title={w.path}>{w.path}</small>
                        {risk && <small className="room-cleanup-risk">{risk}</small>}
                      </span>
                    </label>
                  );
                })}
              </section>
            </>
          )}

          {error && <p className="create-room-error">{error}</p>}
        </div>

        <footer className="create-room-foot">
          <span className="room-cleanup-foot-note">
            {result ? '' : riskyChosen > 0 ? `已勾选 ${riskyChosen} 个有风险的工作树` : '主目录和当前分支不会被删除'}
          </span>
          <span className="room-cleanup-actions">
            <button type="button" className="create-room-secondary" onClick={onClose} disabled={busy}>
              {result ? '关闭' : '取消'}
            </button>
            {!result && (
              <button type="button" className="create-room-primary room-cleanup-confirm" disabled={!plan || nothing || busy} onClick={() => void run()}>
                {busy ? '正在处理…' : `结束 ${sessionIds.size} 个会话，删除 ${worktreePaths.size} 个分支`}
              </button>
            )}
          </span>
        </footer>
      </section>
    </div>
  );
}
