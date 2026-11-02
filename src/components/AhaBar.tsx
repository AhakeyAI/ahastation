import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, CornerDownLeft, Pin, PinOff, X } from 'lucide-react';
import type { AhaBarState } from '../types';
import { VirtualKeyboard } from './VirtualKeyboard';
import { formatObservedAge, OBSERVED_CLIENT_LABEL, OBSERVED_STATE_LABEL } from './TasksView';

const HOVER_ENTER_MS = 200;
const HOVER_LEAVE_MS = 400;
const OBSERVED_TITLE_MAX = 28;
const COPIED_FEEDBACK_MS = 1500;

const EMPTY: AhaBarState = {
  sessionId: null,
  cwd: null,
  projectName: null,
  runningCount: 0,
  pending: [],
  topPending: null,
  hardwareTakenOver: false,
  observed: [],
};

function truncateTitle(title: string): string {
  return title.length > OBSERVED_TITLE_MAX
    ? `${title.slice(0, OBSERVED_TITLE_MAX)}…`
    : title;
}

type BarTone = 'attend' | 'run' | 'idle';

function barHeadline(state: AhaBarState): { tone: BarTone; text: string } {
  if (state.pending.length > 0) {
    return { tone: 'attend', text: `${state.pending.length} 项等你批准` };
  }
  if (state.runningCount > 0) {
    return { tone: 'run', text: `${state.runningCount} 个任务运行中` };
  }
  return { tone: 'idle', text: '没有进行中的任务' };
}

/** Compact → hover → pinned ambient bar. Lives in the floating companion
 *  BrowserWindow (view=ahabar). Approvals go straight to the orchestrator
 *  via ahabar:resolve-permission; high-risk jumps back to the meeting card.
 *  A new approval expands the bar on its own; once it's handled the bar
 *  folds back unless the pointer is on it or it's pinned. */
export function AhaBar() {
  const [state, setState] = useState<AhaBarState>(EMPTY);
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const leaveTimer = useRef<number | null>(null);
  const enterTimer = useRef<number | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const stackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('ahabar-view');
    document.title = 'AhaBar';
    return () => document.documentElement.classList.remove('ahabar-view');
  }, []);

  useEffect(() => {
    const api = window.vibeMeet.ahabar;
    if (!api) return;
    void api.getState().then((res) => {
      if (res.ok) setState(res.state);
    });
    return api.onEvent(setState);
  }, []);

  const pendingCount = state.pending.length;
  const expanded = pinned || hovered || pendingCount > 0;
  // Defensive: an older main may emit a state without the observed field.
  const observed = state.observed ?? [];
  const headline = barHeadline(state);

  // Size the window to the content so nothing below the keys gets clipped.
  useLayoutEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    const report = () => {
      void window.vibeMeet.ahabar?.setExpanded(expanded, Math.ceil(el.offsetHeight) + 12);
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded]);

  const onEnter = () => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
    enterTimer.current = window.setTimeout(() => setHovered(true), HOVER_ENTER_MS);
  };

  const onLeave = () => {
    if (enterTimer.current) window.clearTimeout(enterTimer.current);
    if (pinned) return;
    leaveTimer.current = window.setTimeout(() => setHovered(false), HOVER_LEAVE_MS);
  };

  const resolve = useCallback(async (id: string, decision: 'allow' | 'deny') => {
    await window.vibeMeet.ahabar?.resolvePermission(id, decision);
  }, []);

  const focusMain = useCallback(() => {
    void window.vibeMeet.ahabar?.focusMain();
  }, []);

  const copyResume = useCallback(async (id: string) => {
    const res = await window.vibeMeet.ahabar?.copyResume(id);
    if (!res?.ok) return;
    setCopiedId(id);
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopiedId(null), COPIED_FEEDBACK_MS);
  }, []);

  return (
    <div
      className={`ahabar-root${expanded ? ' is-expanded' : ''}${pinned ? ' is-pinned' : ''}${pendingCount ? ' has-pending' : ''}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="ahabar-stack" ref={stackRef}>
        <header className="ahabar-pill" onDoubleClick={focusMain} title="双击回到主窗口">
          <span className={`ahabar-dot is-${headline.tone}`} aria-hidden />
          <strong className="ahabar-headline">{headline.text}</strong>
          {state.projectName && (
            <span className="ahabar-project" title={state.cwd ?? ''}>{state.projectName}</span>
          )}
          <div className="ahabar-actions">
            <button
              type="button"
              className={`ahabar-icon-btn${pinned ? ' is-active' : ''}`}
              title={pinned ? '取消固定，移开鼠标后收起' : '固定展开'}
              aria-pressed={pinned}
              onClick={() => setPinned((v) => !v)}
            >
              {pinned ? <PinOff size={12} /> : <Pin size={12} />}
            </button>
            <button type="button" className="ahabar-icon-btn" title="关闭 AhaBar" onClick={() => window.close()}>
              <X size={12} />
            </button>
          </div>
        </header>

        {expanded && (
          <section className="ahabar-card">
            {state.topPending || state.hardwareTakenOver ? (
              <VirtualKeyboard
                topPending={state.topPending}
                queuedCount={Math.max(0, pendingCount - 1)}
                hardwareTakenOver={state.hardwareTakenOver}
                onApprove={(id) => { void resolve(id, 'allow'); }}
                onDeny={(id) => { void resolve(id, 'deny'); }}
                onFocusMain={focusMain}
              />
            ) : (
              <div className="ahabar-calm">
                <p>
                  {state.runningCount > 0
                    ? '任务在后台运行，需要你批准时这里会自动展开。'
                    : '目前没有要你处理的事。'}
                </p>
                <button type="button" className="ahabar-link-btn" onClick={focusMain}>
                  <CornerDownLeft size={12} />
                  回主窗口
                </button>
              </div>
            )}

            {observed.length > 0 && (
              <section className="ahabar-observed" aria-label="外部终端会话">
                <h4 className="ahabar-section-title">外部终端会话</h4>
                {observed.map((s) => (
                  <div key={s.id} className="ahabar-observed-row">
                    <span className="ahabar-observed-chip">{OBSERVED_CLIENT_LABEL[s.clientKind]}</span>
                    <div className="ahabar-observed-body">
                      <span className="ahabar-observed-title" title={s.title}>
                        {truncateTitle(s.title)}
                      </span>
                      <span className="ahabar-observed-meta">
                        <span className={`ahabar-observed-state is-${s.state}`}>{OBSERVED_STATE_LABEL[s.state]}</span>
                        <span>{formatObservedAge(s.lastActiveAt)}</span>
                      </span>
                    </div>
                    <button
                      type="button"
                      className="ahabar-observed-btn"
                      title="把这个会话的接续命令复制到剪贴板，粘到终端即可继续"
                      onClick={() => { void copyResume(s.id); }}
                    >
                      <Copy size={11} />
                      {copiedId === s.id ? '已复制' : '复制接续命令'}
                    </button>
                  </div>
                ))}
              </section>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
