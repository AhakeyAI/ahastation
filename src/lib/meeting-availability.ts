import type { TabMeta } from './meeting-store';

export function meetingAvailability(tab: TabMeta | null | undefined, running: boolean) {
  const ready = Boolean(tab && !tab.placeholder && tab.phase === 'ready' && running);
  const reason = ready ? '' : tab?.phase === 'starting' ? '会议正在启动，请稍候'
    : tab?.phase === 'failed' ? '会议启动失败，请重试或重新选择目录'
    : tab?.placeholder ? '项目记录已恢复，点击“继续会议”后才能聊天或选择远端会话'
    : '会议尚未启动，请选择目录或继续会议';
  return { ready, reason, sessionId: tab && !tab.placeholder ? tab.id : null };
}

export function remotePickerReason(loggedIn: boolean, meetingReason: string, sessionId: string | null) {
  return !loggedIn ? '请先在远端控制设置中登录并启用远端控制'
    : meetingReason || (!sessionId ? '会议尚未启动' : '');
}
