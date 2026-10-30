// WorkerWorkbench - single-worker workbench for a claude-code-terminal worker.
//
// Left: Claude Code's native TUI via RealTerminal (xterm). Right: a host
// collaboration sidebar that consolidates the high-frequency info currently
// scattered across the TaskInspector dock tabs - task context, the terminal
// turn-ended confirm bar, the host<->worker mailbox (with Follow-up / Steering
// / Interrupt), and the worker's delivery status with Accept / Revise. The
// human supervises the TUI and steps in through the sidebar; deep review
// (diff / verification / permissions) still opens the full TaskInspector dock
// via onOpenInspector.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { meetingStore, type DeliverySnapshot, type WorkerState } from '../lib/meeting-store';
import { useMeetingSelector } from '../hooks/useMeetingSelector';
import type { RendererTaskSnapshot } from '../types';
import { RealTerminal } from './RealTerminal';
import { TerminalTurnConfirmBar } from './TerminalTurnConfirmBar';
import { TaskMailboxPanel } from './TaskMailboxPanel';
import { Modal } from './Modal';

const STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  pending: '等待调度',
  running: '执行中',
  verifying: '验证中',
  reviewing: '审查中',
  'coordinator-reviewing': 'Coordinator 审查中',
  'awaiting-acceptance': '待人手确认',
  'awaiting-delivery-acceptance': '待人手确认',
  'integration-queued': '等待集成',
  integrating: '集成中',
  reworking: '返工中',
  accepted: '已进 Meeting 分支',
  interrupted: '已中断',
  done: '已完成',
  blocked: '已阻塞',
  'integration-conflict': '集成冲突',
  'budget-paused': '预算暂停',
  failed: '失败',
  cancelled: '已取消',
};

interface WorkerWorkbenchProps {
  workerId: string;
  sessionId: string;
  onOpenInspector: (workerId: string) => void;
  onAcceptDelivery: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onReviseDelivery: (feedback: string) => Promise<
    | { ok: true; route: 'worker' | 'talker'; queued?: boolean }
    | { ok: false; error: string }
  >;
  /** Expert sub-agent tab (AME-D14): watch-only until the user takes over. */
  subagent?: { ownerTitle: string; ownerName: string; taskTitle: string };
}

// Same rule as the terminal adapter (TRUST_PROMPT_PATTERN): spaces may arrive as
// cursor-forward escapes, so normalize before matching.
const TRUST_PROMPT = /trust\s*this\s*(folder|directory|workspace)|do\s*you\s*trust\s*the\s*(files|contents)|is\s*this\s*a\s*project\s*you\s*created/i;
function matchable(text: string): string {
  return text
    .replace(/\x1b\[(\d*)C/g, ' ')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function messageText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  const text = (payload as { text?: unknown; message?: unknown } | null)?.text ?? (payload as { message?: unknown } | null)?.message;
  return typeof text === 'string' ? text : '';
}

/** The expert's assignments to its sub-agent, oldest first, with delivery state. */
function assignmentsOf(snapshot: RendererTaskSnapshot | null): { id: string; text: string; state: 'done' | 'current' | 'queued' }[] {
  if (!snapshot) return [];
  const items: { id: string; text: string; state: 'done' | 'current' | 'queued' }[] = [
    { id: 'goal', text: snapshot.task.title, state: 'done' },
  ];
  const sent = snapshot.mailbox
    .filter((m) => m.sender === 'coordinator' && (m.kind === 'instruction' || m.kind === 'follow-up' || m.kind === 'steer'))
    .sort((a, b) => a.seq - b.seq);
  for (const m of sent) {
    const text = messageText(m.payload);
    if (text) items.push({ id: m.id, text, state: m.status === 'acknowledged' ? 'done' : m.status === 'delivered' ? 'current' : 'queued' });
  }
  // The newest item it has received is what it works on now; earlier ones are done.
  let current = -1;
  items.forEach((item, index) => { if (item.state !== 'queued') current = index; });
  items.forEach((item, index) => {
    if (item.state !== 'queued') item.state = index === current ? 'current' : 'done';
  });
  return items;
}

export function WorkerWorkbench({
  workerId,
  sessionId,
  onOpenInspector,
  onAcceptDelivery,
  onReviseDelivery,
  subagent,
}: WorkerWorkbenchProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [takenOver, setTakenOver] = useState(false);
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const [takeoverError, setTakeoverError] = useState<string | null>(null);
  const [trustPrompt, setTrustPrompt] = useState(false);
  const outputTail = useRef('');
  const trustAnswered = useRef(false);
  const watchOnly = Boolean(subagent) && !takenOver;

  const handleOutput = useCallback((text: string) => {
    if (trustAnswered.current) return;
    outputTail.current = (outputTail.current + matchable(text)).slice(-6000);
    if (TRUST_PROMPT.test(outputTail.current)) setTrustPrompt(true);
  }, []);

  // Claude asks once per new worktree; a click here is an explicit user answer,
  // not a takeover. The cursor starts on the first option, and versions differ
  // in whether "No, exit" or "Yes, I trust" comes first, so pick by text: move
  // down only when the Yes option is listed below the No option, then confirm.
  const answerTrust = useCallback(() => {
    trustAnswered.current = true;
    setTrustPrompt(false);
    const tail = outputTail.current;
    const yes = tail.search(/yes,?\s*(i\s*)?trust|yes,?\s*proceed/i);
    const no = tail.search(/no,?\s*exit/i);
    const keys = yes > -1 && no > -1 && yes > no ? '\x1b[B' : '';
    if (keys) void window.vibeMeet.workerPty.input(workerId, keys);
    window.setTimeout(() => { void window.vibeMeet.workerPty.input(workerId, '\r'); }, 200);
  }, [workerId]);

  const restart = useCallback(async () => {
    setTakeoverError(null);
    const res = await window.vibeMeet.sessions.restartOwnedTask?.(sessionId, workerId);
    if (res && !res.ok) { setTakeoverError(res.error); return; }
    setTakeoverOpen(false);
  }, [sessionId, workerId]);

  const takeOver = useCallback(async () => {
    setTakeoverError(null);
    const res = await window.vibeMeet.tasks.interrupt(sessionId, workerId, '用户接管子 Agent');
    if (!res.ok) { setTakeoverError(res.error ?? '打断失败'); return; }
    setTakenOver(true);
    setTakeoverOpen(false);
  }, [sessionId, workerId]);

  const handBack = useCallback(async () => {
    const res = await window.vibeMeet.sessions.handBackTask?.(sessionId, workerId);
    if (res && !res.ok) { setTakeoverError(res.error); return; }
    setTakenOver(false);
  }, [sessionId, workerId]);

  const worker = useMeetingSelector((s) => s.workers.get(workerId));
  const currentDelivery = useMeetingSelector(
    (s) =>
      s.currentDelivery && s.currentDelivery.workerId === workerId
        ? s.currentDelivery
        : null,
  );

  // Task projection (mailbox + snapshot) - same refcounted pattern as the
  // docked TaskInspector. Mount opens, unmount closes; both can be open at once.
  const getProjection = useCallback(
    () => meetingStore.getTaskInspectorProjection(sessionId, workerId),
    [sessionId, workerId],
  );
  const projection = useSyncExternalStore(
    meetingStore.subscribeTaskInspectors,
    getProjection,
    getProjection,
  );
  useEffect(() => {
    let active = true;
    void meetingStore.openTaskInspector(sessionId, workerId).then((result) => {
      if (!active) return;
      // Projection is shared via the store; nothing to do on success. A failure
      // here just leaves the sidebar sections empty until the next retry.
      void result;
    });
    return () => {
      active = false;
      meetingStore.closeTaskInspector(sessionId, workerId);
    };
  }, [sessionId, workerId]);

  const snapshot = projection?.snapshot ?? null;
  const status = worker?.status ?? snapshot?.task.status ?? 'pending';

  const assignments = assignmentsOf(snapshot);
  // A sub-agent that already stopped has nothing to interrupt: offer a restart instead.
  const stopped = ['failed', 'done', 'interrupted', 'accepted'].includes(String(status));
  const stopReason = worker?.summary || snapshot?.task.summary || null;

  return (
    <div
      className={`worker-workbench${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}${subagent ? ' is-subagent' : ''}`}
      data-status={status}
    >
      <div className="worker-workbench-terminal">
        {subagent && (
          <div className={`subagent-bar${takenOver ? ' is-taken-over' : ''}`}>
            {takenOver ? (
              <>
                <span><strong>你在操作子 Agent</strong>，{subagent.ownerName}暂停给它派活</span>
                <button type="button" className="subagent-bar-btn" onClick={() => void handBack()}>交还给{subagent.ownerName}</button>
              </>
            ) : (
              <>
                <span><strong>{subagent.ownerTitle} {subagent.ownerName}</strong> 正在让子 Agent 做：{subagent.taskTitle}</span>
                <span className="subagent-bar-note">{stopped ? '已停止' : '只能看，不能直接输入'}</span>
                <button type="button" className="subagent-bar-btn" onClick={() => setTakeoverOpen(true)}>{stopped ? '重新开始…' : '接管'}</button>
              </>
            )}
          </div>
        )}
        {subagent && trustPrompt && (
          <div className="subagent-trust" role="alert">
            <span>Claude 在问是否信任这个工作树（AhaStudio 为这个任务新建的目录）。</span>
            <button type="button" className="subagent-bar-btn" onClick={answerTrust}>信任并继续</button>
          </div>
        )}
        {takeoverError && <div className="subagent-trust is-error" role="alert">{takeoverError}</div>}
        <RealTerminal workerId={workerId} readOnly={watchOnly} onOutput={subagent ? handleOutput : undefined} />
      </div>
      {takeoverOpen && subagent && (
        <Modal open ariaLabel="接管子 Agent" className="subagent-takeover" onClose={() => setTakeoverOpen(false)}>
          <h2>{stopped ? '子 Agent 已经停止' : '接管子 Agent'}</h2>
          {stopped && (
            <p className="subagent-stopped">
              它{status === 'failed' ? '运行失败' : '已经结束'}了，没有正在进行的工作可以打断。
              {stopReason ? `原因：${stopReason}` : ''}
            </p>
          )}
          <p>{subagent.ownerName}给它安排过这些事：</p>
          <ol className="subagent-assignments">
            {assignments.map((item) => (
              <li key={item.id} className={`is-${item.state}`}>
                <span aria-hidden="true">{item.state === 'done' ? '✓' : item.state === 'current' ? '▶' : '·'}</span>
                <span>{item.text}{item.state === 'current' ? '（进行中）' : item.state === 'queued' ? '（排队中）' : ''}</span>
              </li>
            ))}
          </ol>
          <p className="subagent-takeover-note">
            {stopped
              ? `重新开始会按同样的任务再派一个子 Agent，仍由${subagent.ownerName}负责。`
              : `接管会先打断子 Agent 当前的工作。交还时${subagent.ownerName}会先看你改了什么再继续。`}
          </p>
          {takeoverError && <p className="subagent-trust is-error">{takeoverError}</p>}
          <div className="subagent-takeover-actions">
            {stopped
              ? <button type="button" className="subagent-takeover-primary" onClick={() => void restart()}>重新开始</button>
              : <button type="button" className="subagent-takeover-primary" onClick={() => void takeOver()}>打断并接管</button>}
            <button type="button" className="subagent-takeover-secondary" onClick={() => setTakeoverOpen(false)}>{stopped ? '关闭' : '继续看'}</button>
          </div>
        </Modal>
      )}

      <aside className="worker-workbench-sidebar" aria-label="Host 协作侧栏">
        <div className="worker-workbench-sidebar-head">
          <strong>协作</strong>
          <button
            type="button"
            className="worker-workbench-collapse"
            onClick={() => setSidebarCollapsed(true)}
            aria-label="收起侧栏"
            title="收起侧栏"
          >
            ›
          </button>
        </div>

        {worker && <TerminalTurnConfirmBar sessionId={sessionId} worker={worker} />}

        {snapshot && <WorkbenchTaskContext snapshot={snapshot} status={status} />}

        {snapshot && (
          <TaskMailboxPanel sessionId={sessionId} taskId={workerId} snapshot={snapshot} readOnly={watchOnly}
            coordinatorLabel={subagent ? `${subagent.ownerTitle} ${subagent.ownerName}` : undefined} />
        )}

        <WorkbenchDeliverySummary
          delivery={currentDelivery}
          onAccept={onAcceptDelivery}
          onRevise={onReviseDelivery}
        />

        <button
          type="button"
          className="workbench-open-inspector"
          onClick={() => onOpenInspector(workerId)}
        >
          展开完整检查器
        </button>
      </aside>

      {sidebarCollapsed && (
        <button
          type="button"
          className="worker-workbench-expand"
          onClick={() => setSidebarCollapsed(false)}
          aria-label="展开侧栏"
          title="展开侧栏"
        >
          ‹
        </button>
      )}
    </div>
  );
}

function WorkbenchTaskContext({
  snapshot,
  status,
}: {
  snapshot: RendererTaskSnapshot;
  status: string;
}) {
  const task = snapshot.task;
  return (
    <section className="workbench-section workbench-context">
      <header>
        <strong>任务</strong>
        <span className={`workbench-status-chip is-${status}`}>
          {STATUS_LABEL[status] ?? status}
        </span>
      </header>
      <p className="workbench-objective">{task.prompt}</p>
      <div className="workbench-metrics">
        <span>Attempt {task.attempt}</span>
        <span>Mailbox {snapshot.mailbox.length}</span>
        {task.deps.length > 0 && <span>依赖 {task.deps.length}</span>}
      </div>
      {task.acceptanceCriteria && task.acceptanceCriteria.length > 0 && (
        <details className="workbench-details">
          <summary>验收条件（{task.acceptanceCriteria.length}）</summary>
          <ol>
            {task.acceptanceCriteria.map((criterion, index) => (
              <li key={index}>
                {typeof criterion === 'object' && criterion
                  ? String(
                      (criterion as Record<string, unknown>).description ??
                        `Criterion ${index + 1}`,
                    )
                  : String(criterion)}
              </li>
            ))}
          </ol>
        </details>
      )}
      {task.deps.length > 0 && (
        <details className="workbench-details">
          <summary>依赖</summary>
          <div className="task-dependency-chips">
            {task.deps.map((dependency) => (
              <code key={dependency}>{dependency}</code>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function WorkbenchDeliverySummary({
  delivery,
  onAccept,
  onRevise,
}: {
  delivery: DeliverySnapshot | null;
  onAccept: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onRevise: (feedback: string) => Promise<
    | { ok: true; route: 'worker' | 'talker'; queued?: boolean }
    | { ok: false; error: string }
  >;
}) {
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState<'' | 'accept' | 'revise'>('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  if (!delivery) return null;

  const canDecide = delivery.status === 'awaiting-delivery-acceptance';
  const statusLabel = STATUS_LABEL[delivery.status] ?? delivery.status;

  const accept = async () => {
    setError('');
    setNote('');
    setPending('accept');
    try {
      const result = await onAccept();
      if (!result.ok) setError(result.error);
      else setNote('已接受交付。');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending('');
    }
  };

  const revise = async () => {
    const text = feedback.trim();
    if (!text) return;
    setError('');
    setNote('');
    setPending('revise');
    try {
      const result = await onRevise(text);
      if (!result.ok) setError(result.error);
      else {
        setNote(result.queued ? '返工已排队。' : '已请求返工。');
        setFeedback('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending('');
    }
  };

  return (
    <section className="workbench-section workbench-delivery">
      <header>
        <strong>交付</strong>
        <span className={`workbench-status-chip is-${delivery.status}`}>
          {statusLabel}
        </span>
      </header>
      <p className="workbench-delivery-summary">{delivery.summary || '（无摘要）'}</p>
      {delivery.files.length > 0 && (
        <p className="workbench-delivery-files">
          {delivery.files.length} 个文件 · attempt {delivery.attempt}
        </p>
      )}
      {canDecide && (
        <div className="workbench-delivery-actions">
          <button
            type="button"
            className="is-primary"
            disabled={pending !== ''}
            onClick={() => void accept()}
          >
            {pending === 'accept' ? '提交中…' : '接受交付'}
          </button>
          <textarea
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="返工反馈（必填）"
            maxLength={100_000}
            disabled={pending !== ''}
          />
          <button
            type="button"
            className="is-danger"
            disabled={pending !== '' || !feedback.trim()}
            onClick={() => void revise()}
          >
            {pending === 'revise' ? '提交中…' : '请求返工'}
          </button>
        </div>
      )}
      {note && <p className="workbench-note" role="status">{note}</p>}
      {error && <p className="workbench-error" role="alert">{error}</p>}
    </section>
  );
}
