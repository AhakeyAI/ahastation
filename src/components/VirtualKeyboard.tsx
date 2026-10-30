import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, CornerDownLeft, X } from 'lucide-react';
import type { AhaBarPending, ApprovalGesture } from '../types';

const HOLD_MS = 800;

interface VirtualKeyboardProps {
  topPending: AhaBarPending | null;
  /** Pending approvals waiting behind topPending. */
  queuedCount: number;
  hardwareTakenOver: boolean;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onFocusMain: () => void;
}

const RISK_HINT: Record<ApprovalGesture, string> = {
  low: '低风险，点一下批准',
  mid: '会改动文件或执行命令，按住批准键确认',
  high: '高风险，请回主窗口看完详情再决定',
};

const APPROVE_LABEL: Record<ApprovalGesture, string> = {
  low: '批准',
  mid: '按住批准',
  high: '去主窗口确认',
};

/** The approval surface of the bar: what is being asked, how risky it is,
 *  and the three on-screen keys (deny / approve / back to main window). */
export function VirtualKeyboard({
  topPending,
  queuedCount,
  hardwareTakenOver,
  onApprove,
  onDeny,
  onFocusMain,
}: VirtualKeyboardProps) {
  const [holdProgress, setHoldProgress] = useState(0);
  const holdTimer = useRef<number | null>(null);
  const holdRaf = useRef<number | null>(null);
  const holdStarted = useRef(0);

  const clearHold = useCallback(() => {
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    if (holdRaf.current) window.cancelAnimationFrame(holdRaf.current);
    holdTimer.current = null;
    holdRaf.current = null;
    setHoldProgress(0);
  }, []);

  useEffect(() => () => clearHold(), [clearHold]);
  useEffect(() => { clearHold(); }, [topPending?.id, clearHold]);

  if (hardwareTakenOver) {
    return (
      <div className="ahabar-vk is-hardware">
        <p>审批已交给实体键盘处理，在键盘上按键即可。</p>
      </div>
    );
  }

  if (!topPending) return null;

  const risk = topPending.risk;

  const startHold = () => {
    clearHold();
    holdStarted.current = performance.now();
    const tick = () => {
      const p = Math.min(1, (performance.now() - holdStarted.current) / HOLD_MS);
      setHoldProgress(p);
      if (p < 1) holdRaf.current = window.requestAnimationFrame(tick);
    };
    holdRaf.current = window.requestAnimationFrame(tick);
    holdTimer.current = window.setTimeout(() => {
      clearHold();
      onApprove(topPending.id);
    }, HOLD_MS);
  };

  const handleApprovePointerDown = () => {
    if (risk === 'high') {
      onFocusMain();
      return;
    }
    if (risk === 'low') {
      onApprove(topPending.id);
      return;
    }
    startHold();
  };

  return (
    <div className={`ahabar-vk is-${risk}`} aria-label="待批准">
      <div className="ahabar-vk-head">
        <span className="ahabar-section-title">等你批准</span>
        {queuedCount > 0 && <span className="ahabar-vk-queue">后面还有 {queuedCount} 项</span>}
      </div>
      <div className="ahabar-vk-request">
        <strong className="ahabar-vk-tool">{topPending.toolName}</strong>
        {topPending.target && (
          <code className="ahabar-vk-target" title={topPending.target}>{topPending.target}</code>
        )}
      </div>
      <p className={`ahabar-risk is-${risk}`}>{RISK_HINT[risk]}</p>
      <div className="ahabar-vk-keys">
        <button
          type="button"
          className="ahabar-key ahabar-key-deny"
          title="拒绝这次操作"
          onClick={() => onDeny(topPending.id)}
        >
          <X size={14} />
          <span>拒绝</span>
        </button>
        <button
          type="button"
          className={`ahabar-key ahabar-key-approve is-${risk}`}
          title={RISK_HINT[risk]}
          onPointerDown={handleApprovePointerDown}
          onPointerUp={clearHold}
          onPointerLeave={clearHold}
          onPointerCancel={clearHold}
        >
          {risk === 'mid' && (
            <i
              className="ahabar-hold-ring"
              style={{ '--hold': String(holdProgress) } as CSSProperties}
              aria-hidden
            />
          )}
          {risk === 'high' ? <CornerDownLeft size={14} /> : <Check size={14} />}
          <span>{APPROVE_LABEL[risk]}</span>
        </button>
        {risk !== 'high' && (
          <button type="button" className="ahabar-key" title="回主窗口查看详情" onClick={onFocusMain}>
            <CornerDownLeft size={14} />
            <span>看详情</span>
          </button>
        )}
      </div>
    </div>
  );
}
