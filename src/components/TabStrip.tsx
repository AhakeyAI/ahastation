import { useCallback } from 'react';
import { Plus, RotateCw, X, SquareArrowOutUpRight } from 'lucide-react';
import { meetingStore, type TabMeta } from '../lib/meeting-store';
import { usePickCwd } from './DirPickerModal';
import { toast } from '../lib/toast';

interface TabStripProps {
  tabs: TabMeta[];
}

function shortPath(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function TabStrip({ tabs }: TabStripProps) {
  const { pickCwd, pickerModal } = usePickCwd();

  const handleAdd = useCallback(async () => {
    const dir = await pickCwd();
    if (!dir) return;
    const result = await meetingStore.openSession(dir);
    if (!result.ok) toast.error(result.error ?? '会议启动失败');
  }, [pickCwd]);

  const handleSelect = useCallback(async (tab: TabMeta) => {
    if (tab.placeholder) {
      const result = await meetingStore.resumePlaceholder(tab.id);
      if (!result.ok) toast.error(result.error ?? '会议恢复失败');
    } else {
      await meetingStore.setActive(tab.id);
    }
  }, []);

  const handleClose = useCallback(async (e: React.MouseEvent, tab: TabMeta) => {
    e.stopPropagation();
    try { await meetingStore.closeTab(tab.id); }
    catch (error) { toast.error(`关闭会议失败：${String(error)}`); }
  }, []);

  const handleRetry = useCallback(async (e: React.MouseEvent, tab: TabMeta) => {
    e.stopPropagation();
    const result = await meetingStore.retryFailedTab(tab.id);
    if (!result.ok) toast.error(result.error ?? '会议恢复失败');
  }, []);

  const handlePopout = useCallback((e: React.MouseEvent, tab: TabMeta) => {
    e.stopPropagation();
    if (!tab.placeholder && tab.phase === 'ready' && window.vibeMeet?.popoutSession) {
      void window.vibeMeet.popoutSession(tab.id);
    }
  }, []);

  return (
    <>
      <div className="tab-strip" role="tablist" aria-label="Open meetings">
      <div className="tab-strip-list">
        {tabs.map((tab) => {
          const label = shortPath(tab.cwd);
          const dotClass = `tab-strip-dot tab-strip-dot-${tab.status}${tab.placeholder ? ' tab-strip-dot-placeholder' : ''}`;
          const tabClass = `tab-strip-item${tab.isActive ? ' tab-strip-item-active' : ''}${tab.placeholder ? ' tab-strip-item-placeholder' : ''}`;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.isActive}
              className={tabClass}
              onClick={() => handleSelect(tab)}
              title={tab.placeholder ? `${tab.cwd} · click to resume` : tab.cwd}
            >
              <span className={dotClass} aria-hidden="true" />
              <span className="tab-strip-label">{label}</span>
              {tab.unreadCount > 0 && !tab.isActive && (
                <span className="tab-strip-badge" aria-label={`${tab.unreadCount} unread`}>
                  {tab.unreadCount > 9 ? '9+' : tab.unreadCount}
                </span>
              )}
              {tab.status === 'failed' && (
                <span
                  className="tab-strip-retry"
                  role="button"
                  aria-label="Retry failed session"
                  tabIndex={-1}
                  onClick={(e) => handleRetry(e, tab)}
                  title="Retry"
                >
                  <RotateCw size={12} aria-hidden="true" />
                </span>
              )}
              {!tab.placeholder && tab.phase === 'ready' && <span
                className="tab-strip-popout"
                role="button"
                aria-label="Open in new window"
                tabIndex={-1}
                onClick={(e) => handlePopout(e, tab)}
                title="在新窗口中打开"
              >
                <SquareArrowOutUpRight size={11} aria-hidden="true" />
              </span>}
              <span
                className="tab-strip-close"
                role="button"
                aria-label="Close tab"
                tabIndex={-1}
                onClick={(e) => handleClose(e, tab)}
              >
                <X size={12} aria-hidden="true" />
              </span>
            </button>
          );
        })}
      </div>
      <button type="button" className="tab-strip-add" onClick={handleAdd} title="Open another folder">
        <Plus size={14} aria-hidden="true" />
      </button>
    </div>
    {pickerModal}
    </>
  );
}
