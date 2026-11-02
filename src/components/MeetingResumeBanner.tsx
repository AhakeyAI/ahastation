import type { TabMeta } from '../lib/meeting-store';

export function MeetingResumeBanner({ tab, error, onContinue, onHome }: {
  tab?: TabMeta; error: string | null; onContinue: () => void; onHome: () => void;
}) {
  if (!tab || tab.phase === 'ready') return null;
  const starting = tab.phase === 'starting';
  const failed = tab.phase === 'failed';
  return <div className="meeting-resume-banner" role="status">
    <div className="meeting-resume-text"><strong>{starting ? '会议正在启动' : failed ? '会议启动失败' : tab.placeholder ? '项目记录已恢复 · 会议未启动' : '会议已结束'}</strong>
      <span className="meeting-resume-path">{tab.cwd}</span>{failed && error && <div role="alert">{error}</div>}
    </div>
    <button type="button" className="meeting-resume-continue" disabled={starting} onClick={onContinue}>{starting ? '启动中…' : failed ? '重试会议' : '继续会议'}</button>
    <button type="button" className="meeting-resume-home" onClick={onHome}>返回首页</button>
  </div>;
}
