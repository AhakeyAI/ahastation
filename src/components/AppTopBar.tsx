import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Compass, House, Mic } from 'lucide-react';

interface AppTopBarProps {
  /** 设置入口（齿轮 + 弹层），由 App 传入现有 SettingsMenu。 */
  settingsSlot?: ReactNode;
  /** 探索页入口（P6，占位版）。 */
  onOpenExplore?: () => void;
  /** 回到首页选目录；会议留在后台，可从首页再进入。 */
  onHome?: () => void;
}

/**
 * AhaStudio 顶栏（04 文档 §9.1）。会议/任务不再分视图：任务看板是舞台区的
 * 默认标签。AhaTalk 路径仍是占位胶囊（M3-7 后端未建）；额度改由顶栏下方的
 * 额度条展示真实数据。
 */
export const AppTopBar = memo(function AppTopBar({ settingsSlot, onOpenExplore, onHome }: AppTopBarProps) {
  const [pathOpen, setPathOpen] = useState(false);
  const pathRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pathOpen) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (pathRef.current && !pathRef.current.contains(t)) setPathOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pathOpen]);

  return (
    <header className="aha-topbar">
      {onHome && (
        <button type="button" className="aha-topbar-home" onClick={onHome} aria-label="返回首页" title="返回首页（会议留在后台）">
          <House size={15} aria-hidden="true" />
        </button>
      )}
      <span className="aha-topbar-brand">AhaStudio</span>


      <div className="aha-topbar-spacer" />

      {/* AhaTalk 处理路径（M3-7 占位：本地路径真实，Key/Cloud 未建） */}
      <div className="aha-chip-wrap" ref={pathRef}>
        <button
          type="button"
          className="aha-chip"
          onClick={() => setPathOpen((v) => !v)}
          title="AhaTalk 处理路径 · 自有 Key / Cloud 开发中"
        >
          <span className="aha-chip-dot aha-chip-dot-run" />
          <span>AhaTalk · 本地</span>
          <span className="aha-chip-caret">▾</span>
        </button>
        {pathOpen && (
          <div className="aha-pop" role="menu">
            <div className="aha-pop-item aha-pop-item-active">
              <span>本地</span>
              <small>· 不上传内容</small>
              <span className="aha-pop-check">✓</span>
            </div>
            <div className="aha-pop-item aha-pop-item-disabled">
              <span>自有 Key</span>
              <small>· 直连你的模型服务</small>
              <span className="aha-dev-tag">开发中</span>
            </div>
            <div className="aha-pop-item aha-pop-item-disabled">
              <span>AhaTalk Cloud</span>
              <small>· 托管处理</small>
              <span className="aha-dev-tag">开发中</span>
            </div>
          </div>
        )}
      </div>


      {onOpenExplore && (
        <button type="button" className="aha-icon-btn" onClick={onOpenExplore} title="探索" aria-label="探索">
          <Compass size={16} />
        </button>
      )}
      <span className="aha-icon-btn aha-icon-btn-static" title="按住说话（底栏麦克风）" aria-hidden>
        <Mic size={16} />
      </span>
      {settingsSlot}
    </header>
  );
});
