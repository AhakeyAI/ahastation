import { memo, type ReactNode } from 'react';
import { House } from 'lucide-react';
import { isRoomWindow } from '../lib/room-window';

interface AppTopBarProps {
  /** Meeting controls on the right: 自动批准, voice, 对话 / AhaBar toggles. */
  actions?: ReactNode;
  /** 设置入口（齿轮 + 分区下拉），由 App 传入 SettingsMenu。 */
  settingsSlot?: ReactNode;
  /** 回到首页选目录；会议留在后台，可从首页再进入。 */
  onHome?: () => void;
}

/**
 * AhaStudio 顶栏（04 文档 §9.1）。底部菜单栏取消后，会议的常用开关都在这里：
 * 左侧是首页和品牌，右侧依次是自动批准、语音（麦克风 + 播报）、对话、
 * AhaBar 和设置。AhaTalk 路径进了设置列表，探索入口移到启动大厅。
 */
export const AppTopBar = memo(function AppTopBar({ actions, settingsSlot, onHome }: AppTopBarProps) {
  const room = isRoomWindow();
  return (
    <header className="aha-topbar">
      {onHome && (
        <button type="button" className="aha-topbar-home" onClick={onHome} aria-label={room ? '关闭这个窗口' : '返回首页'} title={room ? '关闭这个窗口（会议继续在主窗口运行）' : '返回首页（会议留在后台）'}>
          <House size={15} aria-hidden="true" />
        </button>
      )}
      <span className="aha-topbar-brand">AhaStudio</span>
      <div className="aha-topbar-spacer" />
      {actions && <div className="aha-topbar-actions">{actions}</div>}
      {settingsSlot}
    </header>
  );
});
