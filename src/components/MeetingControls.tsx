import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { AutoApproveScope } from '../types';

interface MeetingControlsProps {
  autoApproveScope: AutoApproveScope;
  onChangeAutoApproveScope: (scope: AutoApproveScope) => void;
  multiAgent: boolean;
  onToggleMultiAgent: () => void;
  /** Where the scope picker opens: above (bottom toolbar) or below (top bar). */
  placement?: 'up' | 'down';
}

const SCOPE_LABELS: Record<AutoApproveScope, string> = {
  off: '自动批准',
  read: '仅读取',
  all: '全部',
};

/**
 * 会议控制组（04 §9.3 的 auto 档）。底部菜单栏取消后放在顶栏右侧，
 * 档位选择向下展开。
 */
export const MeetingControls = memo(function MeetingControls({
  autoApproveScope,
  onChangeAutoApproveScope,
  multiAgent,
  onToggleMultiAgent,
  placement = 'down',
}: MeetingControlsProps) {
  const isOn = autoApproveScope !== 'off';
  const multiAgentTitle = multiAgent
    ? '多 Agent 并行已开启 · 所有需求会先评估依赖再拆解并行 · 点击关闭'
    : '单 Agent 模式 · 点击开启多 Agent 并行';

  const [scopePickerOpen, setScopePickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const handleToggleClick = useCallback(() => {
    if (isOn) {
      onChangeAutoApproveScope('off');
      setScopePickerOpen(false);
    } else {
      setScopePickerOpen((v) => !v);
    }
  }, [isOn, onChangeAutoApproveScope]);

  const handlePickScope = useCallback(
    (scope: AutoApproveScope) => {
      onChangeAutoApproveScope(scope);
      setScopePickerOpen(false);
    },
    [onChangeAutoApproveScope],
  );

  useEffect(() => {
    if (!scopePickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && e.target instanceof Node && !pickerRef.current.contains(e.target)) {
        setScopePickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [scopePickerOpen]);

  const approveTitle = isOn
    ? `自动批准: ${SCOPE_LABELS[autoApproveScope]} · 点击关闭`
    : '手动批准 · 点击选择自动批准范围';

  return (
    <>

      <div className="mtg-scope-wrap" ref={pickerRef}>
        <button
          type="button"
          className={`mtg-approve-toggle ${isOn ? 'mtg-approve-toggle-on' : ''}`}
          role="switch"
          aria-checked={isOn}
          onClick={handleToggleClick}
          title={approveTitle}
        >
          <span className="mtg-approve-toggle-track" aria-hidden="true">
            <span className="mtg-approve-toggle-knob" />
          </span>
          <span className="mtg-approve-toggle-label">
            {isOn ? SCOPE_LABELS[autoApproveScope] : '自动批准'}
          </span>
        </button>
        {scopePickerOpen && (
          <div className={`mtg-scope-picker${placement === 'up' ? ' mtg-scope-picker-up' : ''}`}>
            <div className="mtg-scope-picker-title">选择自动批准范围</div>
            <button
              type="button"
              className={`mtg-scope-option ${autoApproveScope === 'read' ? 'mtg-scope-option-active' : ''}`}
              onClick={() => handlePickScope('read')}
            >
              <span className="mtg-scope-option-label">仅读取</span>
              <span className="mtg-scope-option-desc">Read, Grep, Glob 等安全工具自动通过</span>
            </button>
            <button
              type="button"
              className={`mtg-scope-option ${autoApproveScope === 'all' ? 'mtg-scope-option-active' : ''}`}
              onClick={() => handlePickScope('all')}
            >
              <span className="mtg-scope-option-label">全部</span>
              <span className="mtg-scope-option-desc">所有工具（含 Write, Bash）自动通过</span>
            </button>
          </div>
        )}
      </div>
    </>
  );
});
