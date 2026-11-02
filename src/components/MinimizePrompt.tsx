// MinimizePrompt.tsx — modal shown when the user minimizes/closes the main
// window while AhaBar isn't floating (and hasn't opted out with 不再提示).
//
// main.ts intercepts the minimize/close, sends `app:minimize-prompt`, and
// waits for the answer on `app:minimize-choice` (with a 60s fail-safe that
// replays the original minimize/close if we never answer). Mount anywhere in
// the main window's tree — it renders null until prompted.

import { useEffect, useState } from 'react';

type MinimizePromptKind = 'minimize' | 'close';
type MinimizeAction = 'ahabar' | 'hide' | 'quit' | 'cancel';

export function MinimizePrompt() {
  const [kind, setKind] = useState<MinimizePromptKind | null>(null);
  const [never, setNever] = useState(false);

  useEffect(() => {
    const api = window.vibeMeet.app;
    if (!api?.onMinimizePrompt) return;
    return api.onMinimizePrompt((payload) => {
      setNever(false);
      setKind(payload.kind);
    });
  }, []);

  const choose = (action: MinimizeAction) => {
    setKind(null);
    void window.vibeMeet.app.minimizeChoice({ action, never }).catch(() => {
      // Main already proceeded via its fail-safe — nothing to recover here.
    });
  };

  useEffect(() => {
    if (!kind) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') choose('cancel');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!kind) return null;

  const closing = kind === 'close';
  const title = closing ? '要退出 AhaStudio 吗？' : '最小化时开启 AhaBar？';

  return (
    <div
      className="perm-modal-backdrop minimize-prompt-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => { if (e.target === e.currentTarget) choose('cancel'); }}
    >
      <div className="perm-modal minimize-prompt">
        <h3 className="minimize-prompt-title">{title}</h3>
        <p className="minimize-prompt-copy">
          {closing
            ? '退出会结束正在运行的任务。想让任务在后台继续，可以开启 AhaBar：主窗口会隐藏，需要你批准时它会悬浮在屏幕顶端提醒你。'
            : 'AhaBar 会悬浮在屏幕顶端。主窗口最小化后，需要你批准时它会第一时间提醒你，点一下就能处理。'}
        </p>
        <label className="minimize-prompt-never">
          <input
            type="checkbox"
            checked={never}
            onChange={(e) => setNever(e.target.checked)}
          />
          <span>不再询问</span>
        </label>
        <div className="minimize-prompt-actions">
          <button type="button" className="minimize-prompt-btn minimize-prompt-btn-quiet" onClick={() => choose('cancel')}>
            取消
          </button>
          <span className="minimize-prompt-spacer" />
          {closing ? (
            <button type="button" className="minimize-prompt-btn" onClick={() => choose('quit')}>
              直接退出
            </button>
          ) : (
            <button type="button" className="minimize-prompt-btn" onClick={() => choose('hide')}>
              仅最小化
            </button>
          )}
          <button
            type="button"
            className="minimize-prompt-btn minimize-prompt-btn-primary"
            onClick={() => choose('ahabar')}
          >
            {closing ? '开启 AhaBar 并隐藏' : '开启 AhaBar'}
          </button>
        </div>
      </div>
    </div>
  );
}
