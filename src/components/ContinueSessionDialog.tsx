import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { TerminalProfileIcon } from './TerminalProfileIcon';
import type { ObservedClientKind, ObservedSession } from '../lib/observed-store';

const CLIENT_LABEL: Record<ObservedClientKind, string> = { 'claude-code': 'Claude Code', codex: 'Codex', kimi: 'Kimi' };
const CLIENT_ICON: Record<ObservedClientKind, string> = { 'claude-code': 'claude', codex: 'codex', kimi: 'kimi' };

interface ContinueSessionDialogProps {
  session: ObservedSession;
  roomName: string;
  onCancel: () => void;
  onConfirm: (endOriginal: boolean) => void;
}

/** 会话正在本机其他窗口运行：复制一个分支会话到项目室继续，可选关闭原会话。 */
export function ContinueSessionDialog({ session, roomName, onCancel, onConfirm }: ContinueSessionDialogProps) {
  const [endOriginal, setEndOriginal] = useState(false);
  const client = CLIENT_LABEL[session.clientKind];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="ui-modal-backdrop create-room-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <section className="create-room continue-session" role="dialog" aria-modal="true" aria-label="在项目室继续这个会话">
        <header className="create-room-head">
          <h2>在项目室继续这个会话</h2>
          <button type="button" className="create-room-close" onClick={onCancel} aria-label="关闭"><X size={16} /></button>
        </header>
        <div className="room-cleanup-body">
          <div className="continue-session-card">
            <TerminalProfileIcon id={CLIENT_ICON[session.clientKind]} size={16} />
            <span className="room-cleanup-main">
              <span className="room-cleanup-title">{session.title}</span>
              <small title={session.cwd}>{client}，正在本机另一个窗口运行</small>
            </span>
          </div>
          <p className="room-cleanup-note">
            将在「{roomName}」项目室的共享屏幕区复制出一个分支会话继续，已有的上下文会一起带过来。
          </p>
          <p className="room-cleanup-note">
            两边同时改同一份代码容易不同步，建议打开后关闭原会话。
          </p>
          <label className="room-cleanup-row">
            <input type="checkbox" checked={endOriginal} onChange={(e) => setEndOriginal(e.target.checked)} />
            <span className="room-cleanup-main">
              <span className="room-cleanup-title">打开后关闭原会话</span>
              <small>只能关闭终端里运行的会话；桌面 App 里的请在 App 内关闭</small>
            </span>
          </label>
        </div>
        <footer className="create-room-foot">
          <span className="room-cleanup-foot-note">原会话的记录不会被删除</span>
          <span className="room-cleanup-actions">
            <button type="button" className="create-room-secondary" onClick={onCancel}>取消</button>
            <button type="button" className="create-room-primary" autoFocus onClick={() => onConfirm(endOriginal)}>
              在项目室打开
            </button>
          </span>
        </footer>
      </section>
    </div>
  );
}
