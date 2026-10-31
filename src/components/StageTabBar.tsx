import { useState, useRef, useEffect, useSyncExternalStore } from 'react';
import { Activity, Globe, Terminal, FileText, X, Plus, SquareArrowOutUpRight, LayoutGrid } from 'lucide-react';
import { isPinnedStageWindow, type StageWindow, type StageWindowType, type StageWindowOptions } from '../lib/stage-window-store';
import { requestHideBrowser } from '../lib/browser-store';
import type { LocalCliInfo } from '../types';
import { terminalSessionStore } from '../lib/terminal-session-store';
import { TerminalProfileIcon } from './TerminalProfileIcon';

interface StageTabBarProps {
  windows: StageWindow[];
  activeWindowId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCreate: (type: StageWindowType, opts?: StageWindowOptions) => void;
  onPopOut?: (id: string) => void;
  /** Tabs that can't leave the stage (e.g. a live worker PTY) hide the pop-out button. */
  canPopOut?: (win: StageWindow) => boolean;
  popOutLabel?: (win: StageWindow) => string;
  localOnly?: boolean;
  /** Pending-attention count shown on a tab (the board's 待处理 badge). */
  badges?: Record<string, number>;
}

const PHASE_LABELS = { starting: '启动中', running: '运行中', exited: '已退出', error: '错误', closing: '关闭中' };

const ICON_MAP: Record<StageWindowType, typeof Globe> = {
  board: LayoutGrid,
  activity: Activity,
  browser: Globe,
  terminal: Terminal,
  file: FileText,
};

export function StageTabBar({
  windows,
  activeWindowId,
  onSelect,
  onClose,
  onCreate,
  onPopOut,
  canPopOut,
  popOutLabel,
  localOnly = false,
  badges,
}: StageTabBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [clis, setClis] = useState<LocalCliInfo[]>([]);
  const [shells, setShells] = useState<LocalCliInfo[]>([]);
  const [defaultCwd, setDefaultCwd] = useState<string>();
  const [query, setQuery] = useState('');
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  useSyncExternalStore(terminalSessionStore.subscribe, terminalSessionStore.getSnapshot);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const position = () => {
      const rect = menuRef.current?.getBoundingClientRect();
      if (rect) setMenuPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)), top: rect.bottom + 5 });
    };
    position();
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setClis([]);
    setShells([]);
    void Promise.all([window.vibeMeet.shellPty.listClis(), window.vibeMeet.shellPty.listShells()]).then(([cliResult, shellResult]) => {
      if (cancelled) return;
      if (cliResult.ok) setClis(cliResult.clis);
      if (shellResult.ok) { setShells(shellResult.shells); setDefaultCwd(shellResult.defaultCwd); }
      const errors = [!cliResult.ok && cliResult.error, !shellResult.ok && shellResult.error].filter(Boolean);
      if (errors.length) setError(errors.join('；'));
    }).catch((err) => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && e.target instanceof Node && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenuOpen(false); menuRef.current?.querySelector('button')?.focus(); } };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  // Hide browser WebContentsView when the "+" dropdown opens, because the
  // native OS view paints ON TOP of all renderer HTML (z-index is irrelevant).
  useEffect(() => {
    if (!menuOpen) return;
    return requestHideBrowser();
  }, [menuOpen]);

  const handleCreate = (type: StageWindowType, opts?: StageWindowOptions) => {
    onCreate(type, { cwd: defaultCwd, ...opts });
    setMenuOpen(false);
  };
  const matches = (entry: LocalCliInfo) => `${entry.label} ${entry.command} ${entry.id}`.toLowerCase().includes(query.trim().toLowerCase());
  const filteredShells = shells.filter(matches);
  const filteredClis = clis.filter(matches);

  return (
    <div className="stage-tab-bar">
      <div className="stage-tab-list" role="tablist" aria-label="工作区标签页">
        {windows.map((win) => {
          const Icon = ICON_MAP[win.type];
          const isPinned = isPinnedStageWindow(win.id);
          const state = win.localCliId ? terminalSessionStore.getState(win.id) : null;
          return (
            <div
              key={win.id}
              className={`stage-tab ${win.id === activeWindowId ? 'stage-tab-active' : ''}`}
              onClick={() => onSelect(win.id)}
              role="tab"
              aria-selected={win.id === activeWindowId}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault();
                  onSelect(win.id);
                }
              }}
            >
              <span className="stage-tab-icon">
                {win.localCliId ? <TerminalProfileIcon id={win.localCliId === 'shell' ? win.shellId : win.localCliId} size={14} /> : <Icon size={14} />}
              </span>
              <span className="stage-tab-title">{win.title}</span>
              {(badges?.[win.id] ?? 0) > 0 && (
                <span className="stage-tab-badge" aria-label={`${badges![win.id]} 项待处理`}>{badges![win.id]}</span>
              )}
              {state && <span className={`stage-tab-status is-${state.error ? 'error' : state.phase}`}
                aria-label={state.error ? '错误' : PHASE_LABELS[state.phase]}
                title={state.error ?? (state.phase === 'exited' ? `退出码：${state.exitCode ?? '未知'}` : PHASE_LABELS[state.phase])}>
                {state.error ? '错误' : PHASE_LABELS[state.phase]}
              </span>}
              {!isPinned && !win.localCliId && onPopOut && (canPopOut?.(win) ?? true) && (
                <button
                  type="button"
                  className="stage-tab-popout"
                  onClick={(e) => { e.stopPropagation(); onPopOut(win.id); }}
                  aria-label={popOutLabel?.(win) ?? '在新窗口中打开'}
                  title={popOutLabel?.(win) ?? '在新窗口中打开'}
                >
                  <SquareArrowOutUpRight size={11} />
                </button>
              )}
              {!isPinned && (
                <button
                  type="button"
                  className="stage-tab-close"
                  onClick={(e) => { e.stopPropagation(); onClose(win.id); }}
                  aria-label="关闭"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="stage-tab-add" ref={menuRef}>
        <button
          type="button"
          className="stage-tab-add-btn"
          onClick={() => { setQuery(''); setMenuOpen((v) => !v); }}
          aria-label="新建窗口"
          title="新建窗口"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          <Plus size={16} />
        </button>
        {menuOpen && (
          <div className="stage-tab-menu" role="menu" aria-label="新建终端或标签页"
            style={localOnly ? { position: 'fixed', left: menuPosition.left, top: menuPosition.top, right: 'auto', maxHeight: `calc(100vh - ${menuPosition.top + 12}px)` } : undefined}
            onKeyDown={event => {
              const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
              } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
                event.preventDefault(); items[0]?.click();
              }
            }}>
            <input autoFocus className="stage-tab-search" aria-label="搜索终端" placeholder="搜索 CLI 或 Shell…"
              value={query} onChange={(event) => setQuery(event.target.value)} />
            {!localOnly && '新建浏览器 browser'.includes(query.toLowerCase()) && (
              <button
                type="button"
                role="menuitem"
                className="stage-tab-menu-item"
                onClick={() => handleCreate('browser')}
              >
                <Globe size={14} />
                <span>新建浏览器</span>
              </button>
            )}
            <div className="stage-tab-menu-section">本地 Shell</div>
            {filteredShells.map((shell) => (
              <button type="button" role="menuitem" className="stage-tab-menu-item" key={shell.id}
                title={shell.binaryPath}
                onClick={() => handleCreate('terminal', { localCliId: 'shell', shellId: shell.id, title: shell.label })}>
                <TerminalProfileIcon id={shell.id} /><span>{shell.label}</span>
              </button>
            ))}
            <div className="stage-tab-menu-section">本地 Agent CLI</div>
            {loading && <div className="stage-tab-menu-hint" role="status">正在检测本机终端…</div>}
            {error && <div className="stage-tab-menu-hint" role="alert">{error}</div>}
            {!loading && !error && !filteredClis.length && <div className="stage-tab-menu-hint">
              {query ? '没有匹配的 CLI' : '未检测到已安装的 CLI。安装后重新打开此菜单。'}
            </div>}
            {!loading && query && !filteredShells.length && <div className="stage-tab-menu-hint">没有匹配的 Shell</div>}
            {filteredClis.map((cli) => (
              <button type="button" role="menuitem" className="stage-tab-menu-item" key={cli.id}
                title={`${cli.binaryPath}\n使用本机登录和配置`}
                onClick={() => handleCreate('terminal', { localCliId: cli.id, title: cli.label })}>
                <TerminalProfileIcon id={cli.id} />
                <span>{cli.label}</span>
                <small>{cli.command}</small>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
