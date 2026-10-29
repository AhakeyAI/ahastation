import { useEffect, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { ArrowLeft, FolderOpen, FolderPlus, PanelLeft, Plus, Search, Terminal, Sun, Moon } from 'lucide-react';
import { useStageWindows } from '../hooks/useStageWindows';
import { usePickCwd } from './DirPickerModal';
import { StageTabBar } from './StageTabBar';
import { ShellTerminal } from './ShellTerminal';
import { TerminalProfileIcon } from './TerminalProfileIcon';
import { terminalSessionStore } from '../lib/terminal-session-store';
import './local-terminal-workspace.css';

function readDirectories(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('aha.terminal.directories') ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 20) : [];
  } catch { return []; }
}
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const phaseLabels = { starting: '启动中', running: '运行中', exited: '已退出', error: '错误', closing: '关闭中' };

export function LocalTerminalWorkspace({ onBack }: { onBack: () => void }) {
  const stage = useStageWindows();
  const { pickCwd, pickerModal } = usePickCwd();
  const [directories, setDirectories] = useState(readDirectories);
  const [cwd, setCwd] = useState<string | undefined>(() => localStorage.getItem('aha.terminal.cwd') ?? undefined);
  const [sidebar, setSidebar] = useState(true);
  const [query, setQuery] = useState('');
  const [defaultCwd, setDefaultCwd] = useState<string>();
  useSyncExternalStore(terminalSessionStore.subscribe, terminalSessionStore.getSnapshot);
  const fontSize = terminalSessionStore.getFontSize();
  const appearance = terminalSessionStore.getAppearance();
  const windows = stage.windows.filter((win) => win.localCliId);
  const active = windows.find((win) => win.id === stage.activeWindowId) ?? windows.at(-1);
  const selectedCwd = cwd ?? active?.cwd ?? defaultCwd;
  const folders = [...new Set([...directories, ...windows.flatMap(win => win.cwd ? [win.cwd] : []), ...(selectedCwd ? [selectedCwd] : [])])];
  useEffect(() => {
    let cancelled = false;
    void window.vibeMeet.shellPty.listShells().then(result => {
      if (!cancelled && result.ok) setDefaultCwd(result.defaultCwd);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const selectFolder = (path: string) => {
    setCwd(path);
    localStorage.setItem('aha.terminal.cwd', path);
    setDirectories(previous => {
      const next = [path, ...previous.filter(item => item !== path)].slice(0, 20);
      localStorage.setItem('aha.terminal.directories', JSON.stringify(next));
      return next;
    });
  };
  const addFolder = async () => {
    const selected = await pickCwd(selectedCwd);
    if (selected) selectFolder(selected);
  };
  const selectTab = (id: string) => {
    const path = windows.find(win => win.id === id)?.cwd;
    if (path) selectFolder(path);
    stage.setActiveWindow(id);
  };
  const handleKey = (event: KeyboardEvent) => {
    if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) return;
    if (!active || !['PageUp', 'PageDown', 'w', 'W'].includes(event.key)) return;
    if (event.target instanceof Element && event.target.closest('input, select, [role="dialog"]')) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key.toLowerCase() === 'w') stage.closeWindow(active.id);
    else {
      const index = windows.indexOf(active);
      selectTab(windows[(index + (event.key === 'PageUp' ? -1 : 1) + windows.length) % windows.length].id);
    }
  };

  return (
    <div className="local-terminal-workspace" data-appearance={appearance} data-sidebar={sidebar} onKeyDownCapture={handleKey}>
      <header className="terminal-workspace-toolbar">
        <button type="button" onClick={onBack} title="返回首页" aria-label="返回首页"><ArrowLeft size={16} /></button>
        <span className="terminal-workspace-brand">AhaStation</span>
        <button type="button" onClick={() => setSidebar(value => !value)} aria-label="切换目录侧栏" aria-expanded={sidebar}><PanelLeft size={16} /></button>
      </header>
      {sidebar && <aside className="terminal-workspace-sidebar" aria-label="项目目录">
        <label className="terminal-directory-search"><Search size={15} />
          <input aria-label="搜索目录和终端" placeholder="搜索目录和终端" value={query} onChange={event => setQuery(event.target.value)} />
        </label>
        <div className="terminal-directory-heading"><span>项目</span>
          <button type="button" onClick={() => void addFolder()} aria-label="添加项目目录" title="添加项目目录"><FolderPlus size={16} /></button>
        </div>
        <div className="terminal-directory-list">
          {folders.map(path => {
            const tabs = windows.filter(win => win.cwd === path);
            const matchingTabs = tabs.filter(win => win.title.toLowerCase().includes(query.toLowerCase()));
            if (query && !path.toLowerCase().includes(query.toLowerCase()) && !matchingTabs.length) return null;
            return <div className="terminal-directory-group" key={path}>
              <div className={`terminal-directory-row ${selectedCwd === path ? 'is-selected' : ''}`}>
                <button type="button" title={path} onClick={() => selectFolder(path)}><FolderOpen size={15} /><span>{folderName(path)}</span></button>
                <button type="button" title="在此目录打开终端" aria-label={`在 ${folderName(path)} 打开终端`} onClick={() => {
                  selectFolder(path);
                  stage.createWindow('terminal', { localCliId: 'shell', shellId: 'default', cwd: path, title: '终端' });
                }}><Plus size={14} /></button>
              </div>
              {(query && !path.toLowerCase().includes(query.toLowerCase()) ? matchingTabs : tabs).map(win => {
                const state = terminalSessionStore.getState(win.id);
                return <button type="button" key={win.id} className={`terminal-directory-session ${active?.id === win.id ? 'is-active' : ''}`}
                  onClick={() => selectTab(win.id)} title={state.error ?? win.title}>
                  <TerminalProfileIcon id={win.localCliId === 'shell' ? win.shellId : win.localCliId} size={14} />
                  <span>{win.title}</span><small>{state.error ? '错误' : phaseLabels[state.phase]}</small>
                </button>;
              })}
            </div>;
          })}
          {!folders.length && <p className="terminal-directory-hint">添加项目目录，在项目中打开终端。</p>}
        </div>
        <button type="button" className="terminal-add-folder" onClick={() => void addFolder()}><Plus size={14} />添加目录</button>
      </aside>}
      <div className="terminal-workspace-tabs">
        <StageTabBar windows={windows} activeWindowId={active?.id ?? null}
          onSelect={selectTab} onClose={stage.closeWindow} localOnly
          onCreate={(type, opts) => stage.createWindow(type, { ...opts, cwd: selectedCwd ?? opts?.cwd })} />
      </div>
      <main className="local-terminal-body">
        {active ? (
          <ShellTerminal key={active.id} terminalId={active.id} cwd={active.cwd}
            shellId={active.shellId}
            cliId={active.localCliId === 'shell' ? undefined : active.localCliId} />
        ) : (
          <div className="local-terminal-empty">
            <Terminal size={28} />
            <p>在这里开始工作</p>
            <small>点击上方 +，打开本机 CLI 或终端</small>
            <button type="button" onClick={() => void addFolder()}><FolderOpen size={14} />选择项目目录</button>
          </div>
        )}
      </main>
      <footer className="local-terminal-footer">
        <span className="local-terminal-location" title={active?.cwd ?? selectedCwd}><FolderOpen size={12} /><span>{active?.cwd ?? selectedCwd ?? '用户目录'}</span></span>
        <span className="terminal-shortcut-hint" title="Ctrl+Shift+PgUp/PgDn 切换 · Ctrl+Shift+W 关闭并结束进程">{windows.length} 个终端</span>
        <button type="button" aria-label={appearance === 'light' ? '切换深色终端' : '切换浅色终端'} title="终端主题"
          onClick={() => terminalSessionStore.setAppearance(appearance === 'light' ? 'dark' : 'light')}>
          {appearance === 'light' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        <label className="local-terminal-font">字号 <select aria-label="终端字号" value={fontSize}
          onChange={(event) => terminalSessionStore.setFontSize(Number(event.target.value))}>
          {Array.from({ length: 15 }, (_, index) => index + 10).map((size) => <option key={size} value={size}>{size}</option>)}
        </select></label>
      </footer>
      {pickerModal}
    </div>
  );
}