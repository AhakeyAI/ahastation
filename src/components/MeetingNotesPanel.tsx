import { useEffect, useMemo, useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { useMeetingSelector } from '../hooks/useMeetingSelector';
import { Modal } from './Modal';
import type { MeetingNoteItem } from '../types';

const SECTIONS = [
  { key: 'conclusions', title: '核心结论', empty: '还没有确认的结论' },
  { key: 'decisions', title: '决策', empty: '还没有做出决定' },
  { key: 'workItems', title: '待办', empty: '还没有要派工的工作项' },
  { key: 'todos', title: 'TODO', empty: '还没有零碎事项' },
] as const;

type Pick = { kind: 'work-item' | 'todo'; item: MeetingNoteItem; key: string };

/**
 * 工作区默认内容：助理基于讨论实时整理的会议纪要（核心结论、决策、待办、
 * TODO），每条带来源。「确认并写入看板」把勾选的待办和 TODO 建成看板
 * 「待执行 / 待派工」卡片，不自动派工；可选同时在 GitHub 创建 Issue
 * （AME-D08、Q12：回写需用户明确要求）。
 */
export function MeetingNotesPanel({ cwd }: { cwd: string | undefined }) {
  const notes = useMeetingSelector((s) => s.meetingNotes ?? null);
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [createIssues, setCreateIssues] = useState(false);
  const [github, setGithub] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const picks = useMemo<Pick[]>(() => {
    if (!notes) return [];
    return [
      ...notes.notes.workItems.map((item, i) => ({ kind: 'work-item' as const, item, key: `w${i}` })),
      ...notes.notes.todos.map((item, i) => ({ kind: 'todo' as const, item, key: `t${i}` })),
    ];
  }, [notes]);

  useEffect(() => {
    if (!open || !cwd) return;
    setChecked(Object.fromEntries(picks.map((p) => [p.key, true])));
    setCreateIssues(false);
    setResult(null);
    void window.vibeMeet.projects?.githubStatus?.(cwd).then((res) => setGithub(res.ok ? res.status.github : false));
  }, [open, cwd, picks]);

  const confirm = async () => {
    const api = window.vibeMeet.projects;
    if (!api?.backlogAdd || !cwd) return;
    const chosen = picks.filter((p) => checked[p.key]);
    if (!chosen.length) return;
    setBusy(true);
    try {
      const res = await api.backlogAdd(cwd, chosen.map((p) => ({ title: p.item.text.slice(0, 300), kind: p.kind, ...(p.item.source ? { source: p.item.source.slice(0, 300) } : {}) })), createIssues);
      if (!res.ok) { setResult(res.error); return; }
      const issues = res.items.filter((i) => i.issueUrl).length;
      const failed = res.items.filter((i) => i.issueError).length;
      setResult(`已写入看板 ${res.items.length} 张卡片${createIssues ? `，创建 Issue ${issues} 个${failed ? `，${failed} 个没建成（见卡片）` : ''}` : ''}。`);
    } finally {
      setBusy(false);
    }
  };

  const total = notes ? SECTIONS.reduce((n, s) => n + notes.notes[s.key].length, 0) : 0;

  return (
    <section className="meeting-notes" aria-label="会议纪要">
      <header className="meeting-notes-head">
        <h3>会议纪要</h3>
        <span>{notes ? `助理整理，${new Date(notes.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 更新` : '讨论开始后，助理会在这里整理'}</span>
        <button type="button" className="meeting-notes-confirm" disabled={!picks.length} onClick={() => setOpen(true)}>
          <ClipboardCheck size={14} aria-hidden="true" /> 确认并写入看板
        </button>
      </header>
      {total > 0 || notes ? (
        <div className="meeting-notes-grid">
          {SECTIONS.map((section) => {
            const items = notes?.notes[section.key] ?? [];
            return (
              <div className={`meeting-notes-section is-${section.key}`} key={section.key}>
                <h4>{section.title}<span>{items.length}</span></h4>
                {items.length ? (
                  <ul>
                    {items.map((item, i) => (
                      <li key={i}>
                        <span>{item.text}</span>
                        {item.source && <small>{item.source}</small>}
                      </li>
                    ))}
                  </ul>
                ) : <p className="meeting-notes-empty">{section.empty}</p>}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="meeting-notes-empty is-wide">还没有纪要。和助理、专家聊起来后，结论、决策和待办会出现在这里。</p>
      )}

      {open && (
        <Modal open ariaLabel="写入看板" className="notes-commit" onClose={() => !busy && setOpen(false)}>
          <h2>写入看板</h2>
          <p>勾选的条目会建成看板「待执行」里的卡片，不会自动开工。</p>
          <ul className="notes-commit-list">
            {picks.map((p) => (
              <li key={p.key}>
                <label>
                  <input type="checkbox" checked={Boolean(checked[p.key])} disabled={busy}
                    onChange={(e) => setChecked((prev) => ({ ...prev, [p.key]: e.target.checked }))} />
                  <em className={`tasks-sub-chip is-${p.kind === 'todo' ? 'queued' : 'backlog'}`}>{p.kind === 'todo' ? 'TODO' : '待办'}</em>
                  <span>{p.item.text}</span>
                </label>
              </li>
            ))}
          </ul>
          <label className={`notes-commit-issues${github ? '' : ' is-disabled'}`}>
            <input type="checkbox" checked={createIssues} disabled={!github || busy} onChange={(e) => setCreateIssues(e.target.checked)} />
            <span>
              同时在 GitHub 创建 Issue（只为「待办」创建，TODO 只留在看板）
              {github === false && <small>这个项目没有 GitHub 远程仓库</small>}
            </span>
          </label>
          {result && <p className="notes-commit-result" role="status">{result}</p>}
          <div className="subagent-takeover-actions">
            {result ? (
              <button type="button" className="subagent-takeover-primary" onClick={() => setOpen(false)}>完成</button>
            ) : (
              <>
                <button type="button" className="subagent-takeover-primary" disabled={busy || !picks.some((p) => checked[p.key])} onClick={() => void confirm()}>
                  {busy ? '正在写入…' : createIssues ? '写入看板并创建 Issue' : '写入看板'}
                </button>
                <button type="button" className="subagent-takeover-secondary" onClick={() => setOpen(false)} disabled={busy}>取消</button>
              </>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
