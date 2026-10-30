import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Activity, ChevronDown, Clock, DownloadCloud, FolderOpen, FolderPlus, KeyRound, LogIn, Mic, MonitorUp, Terminal } from 'lucide-react';
import { meetingStore } from '../lib/meeting-store';
import { toast } from '../lib/toast';
import type { BackendInfo } from '../types';
import { usePickCwd } from './DirPickerModal';
import {SharedMeetingEntry} from './SharedMeetingEntry';
import { ProjectRooms } from './ProjectRooms';
import { useObservedTasks } from '../hooks/useObservedTasks';
import { buildRooms, type ProjectRoom, type RepoInfo } from '../lib/project-rooms';
import { CreateRoomDialog } from './CreateRoomDialog';
import { rememberTerminalFolder } from './LocalTerminalWorkspace';

interface LobbyProps {
  lastError?: string | null;
  /** Zero-session entry into the main UI, landing on the task board. */
  onEnterBoard?: () => void;
  onOpenTerminal?: () => void;
  onEnterMeeting?: () => void;
  /** Replay the full first-launch onboarding flow. */
  onReplayOnboarding?: () => void;
  /** 探索页（配套硬件与功能），只在启动大厅提供入口。 */
  onOpenExplore?: () => void;
  /** Never scanned on this machine: 项目室 leads with the scan guide. */
  firstLaunch?: boolean;
  onFirstScanDone?: () => void;
}

interface RecoverableMeeting {
  meetingId: string;
  seq: number;
  state: Record<string, unknown>;
}

interface DeviceSnapshot {
  platform: string;
  arch: string;
  kernel: string;
  totalMemoryBytes: number;
  electronVersion: string;
  sessionType: string;
  gpu: { available: boolean; status: Record<string, string> };
  audio: {
    microphone: 'granted' | 'denied' | 'available' | 'unavailable' | 'unknown';
    speaker: 'available' | 'unknown';
    xfyun: boolean;
  };
  workspace: { git: boolean; worktree: boolean; version: string | null };
  capacity: { hosts: number; workers: number };
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(ts).toLocaleDateString();
}

function shortPath(cwd: string): { label: string; parent: string } {
  const parts = cwd.split('/').filter(Boolean);
  const label = parts[parts.length - 1] ?? cwd;
  const parent = parts.slice(0, -1).join('/');
  return { label, parent: parent ? `/${parent}/` : '/' };
}

/** Get auth status label for a backend. */
function backendAuthLabel(b: BackendInfo): string {
  if (b.loggedIn) return '✓';
  return '';
}

function microphoneLabel(status: DeviceSnapshot['audio']['microphone']): string {
  switch (status) {
    case 'granted': return '已授权';
    case 'denied': return '被拒绝';
    case 'available': return '可用';
    case 'unavailable': return '未检测到';
    default: return '进入会议后测试';
  }
}

export function Lobby({ lastError, onEnterBoard, onOpenTerminal, onEnterMeeting, onReplayOnboarding, onOpenExplore, firstLaunch = false, onFirstScanDone }: LobbyProps) {
  const lobby = useSyncExternalStore(meetingStore.subscribeTabs, meetingStore.getLobbyData);

  const [backends, setBackends] = useState<BackendInfo[]>([]);
  // 多设备协作入口默认收起（C5：协作入口默认关闭），从页脚展开。
  const [collabOpen, setCollabOpen] = useState(false);
  const [selectedBackend, setSelectedBackend] = useState('codex');
  const [authOpen, setAuthOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DeviceSnapshot | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);

  // Per-backend auth editing state
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [modelInput, setModelInput] = useState('');
  const [apiKeyStatus, setApiKeyStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // Claude-specific OAuth state
  const [loginStatus, setLoginStatus] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const [loginError, setLoginError] = useState<string>('');

  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [recoverable, setRecoverable] = useState<RecoverableMeeting[]>([]);
  const { pickCwd, pickerModal } = usePickCwd();

  // Install state — one backend at a time; log accumulates streamed output.
  const [installing, setInstalling] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState('');

  // Load backends on mount
  const reloadBackends = useCallback(async () => {
    try {
      const list = await window.vibeMeet.backendAuth.list();
      setBackends(list);
      // Find the default backend, fallback to codex
      const defaultBe = list.find((b) => b.isDefault);
      const fallback = list.find((b) => b.id === 'codex');
      const selected = defaultBe?.id ?? fallback?.id ?? list[0]?.id ?? 'codex';
      setSelectedBackend(selected);
      meetingStore.defaultBackendId = selected;
    } catch (err) {
      console.warn('[Lobby] failed to load backends:', err);
      toast.error('加载 AI 后端列表失败，请重试或重启应用');
    }
  }, []);

  useEffect(() => {
    void reloadBackends();
    void window.vibeMeet.sessions.listRecoverable()
      .then((result) => setRecoverable(result.meetings))
      .catch((error) => {
        console.warn('[Lobby] failed to load recoverable meetings:', error);
        toast.error('无法加载可恢复的会议记录');
      });
  }, [reloadBackends]);

  useEffect(() => window.vibeMeet.remoteControl.onChanged(() => { void reloadBackends(); }), [reloadBackends]);

  // When selected backend changes, prefill inputs from its config
  useEffect(() => {
    const b = backends.find((x) => x.id === selectedBackend);
    if (b) {
      setBaseUrlInput(b.baseUrl ?? '');
      setModelInput(b.model ?? '');
    }
  }, [selectedBackend, backends]);

  const currentBackend = useMemo(
    () => backends.find((b) => b.id === selectedBackend) ?? null,
    [backends, selectedBackend],
  );

  const openCwd = useCallback(async (cwd: string) => {
    if (opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      const res = await meetingStore.openSession(cwd);
      if (!res.ok) setOpenError(res.error ?? '会议打开失败');
      else onEnterMeeting?.();
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpening(false);
    }
  }, [opening, onEnterMeeting]);

  const pickAndOpen = useCallback(async () => {
    const dir = await pickCwd();
    if (!dir) return;
    await openCwd(dir);
  }, [openCwd, pickCwd]);

  const recoverMeeting = useCallback(async (meeting: RecoverableMeeting) => {
    if (opening) return;
    const cwd = typeof meeting.state.cwd === 'string' ? meeting.state.cwd : '';
    if (!cwd) return;
    setOpening(true);
    setOpenError(null);
    try {
      const result = await meetingStore.openSession(cwd, '', meeting.meetingId);
      if (!result.ok) setOpenError(result.error ?? '会议恢复失败');
      else { setRecoverable((items) => items.filter((item) => item.meetingId !== meeting.meetingId)); onEnterMeeting?.(); }
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpening(false);
    }
  }, [opening, onEnterMeeting]);

  const [createOpen, setCreateOpen] = useState(false);
  const observed = useObservedTasks();
  // folder → repository, so a repo's worktrees and sub-folders share one room.
  const [repos, setRepos] = useState<Record<string, RepoInfo>>({});
  const roomFolders = useMemo(() => [...new Set([
    ...lobby.recent.map((r) => r.path),
    ...recoverable.map((m) => (typeof m.state.cwd === 'string' ? m.state.cwd : '')),
    ...observed.sessions.filter((s) => !s.isNoise).map((s) => s.cwd),
  ].filter(Boolean))], [lobby.recent, recoverable, observed]);
  useEffect(() => {
    const missing = roomFolders.filter((cwd) => !(cwd in repos));
    if (!missing.length || !window.vibeMeet.projects) return;
    let cancelled = false;
    void window.vibeMeet.projects.resolveRepos(missing).then((res) => {
      if (!cancelled && res.ok) setRepos((prev) => ({ ...prev, ...res.repos }));
    }).catch(() => { /* rooms fall back to one per folder */ });
    return () => { cancelled = true; };
  }, [roomFolders, repos]);
  const rooms = useMemo(() => buildRooms({
    recent: lobby.recent,
    recoverable: recoverable.map((m) => ({
      meetingId: m.meetingId,
      cwd: typeof m.state.cwd === 'string' ? m.state.cwd : '',
      updatedAt: typeof m.state.updatedAt === 'number' ? m.state.updatedAt : undefined,
    })),
    sessions: observed.sessions,
    repos,
  }), [lobby.recent, recoverable, observed, repos]);

  const openRoom = useCallback((room: ProjectRoom) => {
    const meeting = room.recoverableMeetingId
      ? recoverable.find((m) => m.meetingId === room.recoverableMeetingId)
      : undefined;
    void (meeting ? recoverMeeting(meeting) : openCwd(room.cwd));
  }, [recoverable, recoverMeeting, openCwd]);

  const handleBackendChange = useCallback(async (backendId: string) => {
    const result = await window.vibeMeet.backendAuth.setDefault(backendId);
    if (!result.ok) {
      setOpenError(result.error ?? '这个 CLI 不能担任 Host');
      await reloadBackends();
      return;
    }
    setSelectedBackend(backendId);
    meetingStore.defaultBackendId = backendId;
    await reloadBackends();
  }, [reloadBackends]);

  const saveApiKey = useCallback(async () => {
    if (!currentBackend) return;
    setApiKeyStatus('saving');
    const key = apiKeyInputs[currentBackend.id] ?? '';
    const res = await window.vibeMeet.backendAuth.setApiKey(currentBackend.id, key);
    if (res.ok) {
      setApiKeyStatus('saved');
      setApiKeyInputs((prev) => ({ ...prev, [currentBackend.id]: '' }));
      setTimeout(() => setApiKeyStatus('idle'), 2000);
      await reloadBackends();
    } else {
      setApiKeyStatus('error');
    }
  }, [currentBackend, apiKeyInputs, reloadBackends]);

  const saveBaseUrl = useCallback(async (url: string) => {
    if (!currentBackend) return;
    await window.vibeMeet.backendAuth.setBaseUrl(currentBackend.id, url);
    await reloadBackends();
  }, [currentBackend, reloadBackends]);

  const saveModel = useCallback(async (model: string) => {
    if (!currentBackend) return;
    await window.vibeMeet.backendAuth.setModel(currentBackend.id, model);
    await reloadBackends();
  }, [currentBackend, reloadBackends]);

  const loginSubscription = useCallback(async () => {
    setLoginStatus('pending');
    setLoginError('');
    const res = await window.vibeMeet.auth.loginSubscription();
    if (res.ok) {
      setLoginStatus('done');
      await reloadBackends();
    } else {
      setLoginStatus('error');
      setLoginError(res.error ?? '登录失败');
    }
  }, [reloadBackends]);

  const loginOAuth = useCallback(async (backendId: string) => {
    setLoginStatus('pending');
    setLoginError('');
    const res = await window.vibeMeet.backendAuth.loginOAuth(backendId);
    if (res.ok) {
      setLoginStatus('done');
      await reloadBackends();
    } else {
      setLoginStatus('error');
      setLoginError(res.error ?? '登录失败');
    }
  }, [reloadBackends]);

  const setClaudeCliSource = useCallback(async (source: 'bundled' | 'system') => {
    const res = await window.vibeMeet.backendAuth.setClaudeCliSource(source);
    if (!res.ok) {
      toast.error(res.error ?? '切换 Claude CLI 来源失败');
      return;
    }
    await reloadBackends();
  }, [reloadBackends]);

  const setDefaultWorkerBackend = useCallback(async (backendId: string) => {
    const res = await window.vibeMeet.backendAuth.setDefaultWorkerBackend(backendId);
    if (!res.ok) {
      toast.error(res.error ?? '切换 Worker 执行模式失败');
      return;
    }
    await reloadBackends();
  }, [reloadBackends]);

  const installBackend = useCallback(async (backendId: string) => {
    if (installing) return;
    setInstalling(backendId);
    setInstallLog('');
    // Subscribe before invoking — the main process begins emitting progress
    // events as soon as the subprocess starts, and we don't want to miss the
    // first few lines.
    const unsubscribe = window.vibeMeet.backendAuth.onInstallProgress((event) => {
      if (event.backendId === backendId) {
        setInstallLog((prev) => prev + event.data);
      }
    });
    try {
      const res = await window.vibeMeet.backendAuth.install(backendId);
      if (res.ok) {
        setInstallLog((prev) => prev + '\n✓ Installed successfully.\n');
        await reloadBackends();
      } else {
        setInstallLog((prev) => prev + `\n✗ ${res.error ?? '安装失败'}\n`);
      }
    } catch (err) {
      setInstallLog((prev) => prev + `\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      unsubscribe();
      // Clear installing state but keep installLog visible — the log panel
      // renders even when installing is null so the user can read the result.
      setInstalling(null);
    }
  }, [installing, reloadBackends]);

  const openDiagnostics = useCallback(async () => {
    const next = !diagnosticsOpen;
    setDiagnosticsOpen(next);
    if (!next) return;
    setDiagnosticsError(null);
    await reloadBackends();
    const result = await window.vibeMeet.deviceDiagnostics();
    if (result.ok) setDiagnostics(result.diagnostics);
    else setDiagnosticsError(result.error);
  }, [diagnosticsOpen, reloadBackends]);

  // Build the toggle label
  const toggleLabel = currentBackend
    ? `${currentBackend.displayName} ${backendAuthLabel(currentBackend)}`
    : '未配置';

  return (
    <div className="join-screen">
      <div className="join-card lobby-card">
        <div className="join-brand">
          <div className="join-logo">
            <img src="icon-96.png" alt="AhaStudio" className="join-logo-img" />
          </div>
          <div>
            <div className="join-title">AhaStudio</div>
            <div className="join-sub">和 AI 开会写代码：说话、共享屏幕、派活</div>
          </div>
        </div>

        <div className="join-auth-section">
          <button
            type="button"
            className="join-auth-toggle"
            onClick={() => setAuthOpen((v) => !v)}
          >
            <KeyRound size={14} aria-hidden="true" />
            <span>Host CLI — {toggleLabel}</span>
            <ChevronDown size={14} className={authOpen ? 'join-auth-chevron open' : 'join-auth-chevron'} />
          </button>

          {authOpen && (
            <div className="join-auth-body">
              <p className="join-auth-desc">
                选择担任 Host 的 CLI，每个 CLI 单独配置认证。
              </p>

              {/* Backend selector dropdown */}
              <div className="join-auth-block">
                <div className="join-auth-block-title">
                  Host CLI
                </div>
                <select
                  className="lobby-backend-select"
                  value={selectedBackend}
                  onChange={(e) => { void handleBackendChange(e.target.value); }}
                >
                  {backends.map((b) => (
                    <option key={b.id} value={b.id} disabled={!b.supportsCoordinator}>
                      {b.displayName} {b.loggedIn ? '✓' : ''} {b.isDefault ? '(default)' : ''} {!b.available ? '(not installed)' : ''} {!b.supportsCoordinator ? '(expert only)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              {currentBackend?.id === 'claude-code' && currentBackend.available && (
                <div className="join-auth-block">
                  <div className="join-auth-block-title">Claude Code CLI 来源</div>
                  <select
                    className="join-auth-input join-auth-input-full lobby-backend-select"
                    value={currentBackend.claudeCodeCliSource ?? 'system'}
                    onChange={(e) => { void setClaudeCliSource(e.target.value as 'bundled' | 'system'); }}
                  >
                    <option value="system" disabled={currentBackend.systemClaudeAvailable === false}>
                      系统 PATH {currentBackend.systemClaudeVersion ? `(v${currentBackend.systemClaudeVersion})` : currentBackend.systemClaudeAvailable ? '(已安装)' : '(未找到)'}
                    </option>
                    <option value="bundled" disabled={currentBackend.bundledClaudeAvailable === false}>
                      内置版本 {currentBackend.bundledClaudeVersion ? `(v${currentBackend.bundledClaudeVersion})` : currentBackend.bundledClaudeAvailable ? '(已安装)' : '(不可用)'}
                    </option>
                  </select>
                  <div className="join-auth-hint">
                    {currentBackend.workerRuntimeState === 'version-incompatible'
                      ? currentBackend.workerRuntimeReason
                      : '系统 PATH 使用你本机安装的 Claude Code；内置版本为应用自带的已验证版本。'}
                  </div>
                </div>
              )}

              {currentBackend?.id === 'claude-code' && currentBackend.available && (
                <div className="join-auth-block">
                  <div className="join-auth-block-title">Worker 执行模式</div>
                  <select
                    className="join-auth-input join-auth-input-full lobby-backend-select"
                    value={currentBackend.defaultWorkerBackendId ?? 'claude-code-terminal'}
                    onChange={(e) => {
                      void setDefaultWorkerBackend(e.target.value);
                    }}
                  >
                    {[
                      { id: 'claude-code-terminal', label: '终端 TUI（Claude Code）' },
                      { id: 'kimi-code-terminal', label: '终端 TUI（Kimi Code）' },
                      { id: 'codex-terminal', label: '终端 TUI（Codex）' },
                      { id: 'qoder-terminal', label: '终端 TUI（Qoder）' },
                      { id: 'claude-code', label: '无头 Worker' },
                    ]
                      .filter((opt) =>
                        backends.some((b) => b.id === opt.id)
                        || opt.id === (currentBackend.defaultWorkerBackendId ?? 'claude-code-terminal'))
                      .map((opt) => (
                        <option key={opt.id} value={opt.id}>{opt.label}</option>
                      ))}
                  </select>
                  <div className="join-auth-hint">
                    {'终端模式在 Stage → Terminal 标签中显示可交互的 TUI（Claude / Kimi）；无头模式在后台执行，仅回放命令日志。'}
                  </div>
                </div>
              )}

              {/* Auth fields for selected backend */}
              {currentBackend?.id === 'pocket-vibe' ? <div className="join-auth-block">
                <p>远端身份和电脑配对请在远端控制设置管理。公网模式先使用本机 Host 开始会议，再从参与者选择已有远端会话。</p>
                <button className="join-auth-btn" onClick={() => void window.vibeMeet.settingsWindow.open()}>远端控制设置</button>
              </div> : currentBackend?.available ? (
                <>
                  <div className="join-auth-block">
                    <div className="join-auth-block-title">
                      <KeyRound size={13} aria-hidden="true" /> API Key
                      {currentBackend.loggedIn && (
                        <span className="join-auth-badge active">已生效</span>
                      )}
                    </div>
                    <div className="join-auth-row">
                      <input
                        type="password"
                        className="join-auth-input"
                        placeholder={currentBackend.hasApiKey ? '••••••••••••••••••••••' : '输入 API Key…'}
                        value={apiKeyInputs[currentBackend.id] ?? ''}
                        onChange={(e) => setApiKeyInputs((prev) => ({ ...prev, [currentBackend.id]: e.target.value }))}
                        onKeyDown={(e) => e.key === 'Enter' && void saveApiKey()}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="join-auth-btn"
                        onClick={saveApiKey}
                        disabled={apiKeyStatus === 'saving'}
                      >
                        {apiKeyStatus === 'saving' ? '正在保存…'
                          : apiKeyStatus === 'saved' ? '已保存 ✓'
                          : '保存'}
                      </button>
                    </div>
                    <input
                      type="text"
                      className="join-auth-input join-auth-input-full"
                      placeholder={`Base URL（可选）${currentBackend.baseUrl ? `：${currentBackend.baseUrl}` : ''}`}
                      value={baseUrlInput}
                      onChange={(e) => setBaseUrlInput(e.target.value)}
                      onBlur={(e) => {
                        if (e.target.value !== (currentBackend.baseUrl ?? '')) {
                          void saveBaseUrl(e.target.value);
                        }
                      }}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    {currentBackend.id !== 'codex' && currentBackend.models && currentBackend.models.length > 0 ? (
                      <select
                        className="join-auth-input join-auth-input-full lobby-backend-select"
                        value={modelInput || ''}
                        onChange={(e) => {
                          setModelInput(e.target.value);
                          void saveModel(e.target.value);
                        }}
                      >
                        <option value="">默认模型</option>
                        {currentBackend.models.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    ) : (
                      <>
                        <input
                          type="text"
                          className="join-auth-input join-auth-input-full"
                          list={currentBackend.models && currentBackend.models.length > 0
                            ? `${currentBackend.id}-lobby-model-suggestions`
                            : undefined}
                          placeholder={`Model (optional)${currentBackend.defaultModel ? ` — ${currentBackend.defaultModel}` : ''}`}
                          value={modelInput}
                          onChange={(e) => setModelInput(e.target.value)}
                          onBlur={(e) => {
                            if (e.target.value !== (currentBackend.model ?? '')) {
                              void saveModel(e.target.value);
                            }
                          }}
                          autoComplete="off"
                          spellCheck={false}
                        />
                        {currentBackend.models && currentBackend.models.length > 0 && (
                          <datalist id={`${currentBackend.id}-lobby-model-suggestions`}>
                            {currentBackend.models.map((m) => (
                              <option key={m} value={m} />
                            ))}
                          </datalist>
                        )}
                      </>
                    )}
                    {apiKeyStatus === 'error' && (
                      <div className="join-auth-error">Failed to save settings.</div>
                    )}
                    <div className="join-auth-hint">
                      Base URL and Model only apply when using an API key. Leave a field blank to clear it.
                    </div>
                  </div>

                  {/* OAuth login section — for backends that support it */}
                  {(currentBackend.id === 'claude-code' ||
                    currentBackend.id === 'kimi' ||
                    currentBackend.id === 'codex' ||
                    currentBackend.id === 'qoder') && (
                    <div className="join-auth-block">
                      <div className="join-auth-block-title">
                        <LogIn size={13} aria-hidden="true" /> {currentBackend.displayName} Account
                        {currentBackend.loggedIn && (
                          <span className="join-auth-badge active">已生效</span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="join-auth-btn join-auth-btn-login"
                        onClick={() => {
                          if (currentBackend.id === 'claude-code') {
                            void loginSubscription();
                          } else {
                            void loginOAuth(currentBackend.id);
                          }
                        }}
                        disabled={loginStatus === 'pending'}
                      >
                        {loginStatus === 'pending' ? '正在打开浏览器…'
                          : loginStatus === 'done' ? '已登录 ✓'
                          : currentBackend.loggedIn ? '重新登录'
                          : `登录 ${currentBackend.displayName}`}
                      </button>
                      {loginStatus === 'error' && (
                        <div className="join-auth-error">{loginError || '登录失败。'}</div>
                      )}
                      <div className="join-auth-hint">
                        会打开浏览器完成 OAuth 登录。需要{currentBackend.id === 'claude-code'
                          ? (currentBackend.claudeCodeCliSource === 'bundled' ? '应用内置的 ' : '本机 PATH 上的 ')
                          : '已安装的 '}{currentBackend.displayName} CLI。
                      </div>
                    </div>
                  )}
                </>
              ) : currentBackend ? (
                <div className="join-auth-block">
                  <div className="join-auth-hint">
                    {currentBackend.installHint ?? `没有安装 ${currentBackend.displayName}，安装后才能使用。`}
                  </div>
                  {currentBackend.installHint && currentBackend.installHint !== 'Bundled with AhaStation' && (
                    <button
                      type="button"
                      className="join-auth-btn lobby-install-btn"
                      onClick={() => { void installBackend(currentBackend.id); }}
                      disabled={installing !== null}
                    >
                      <DownloadCloud size={13} aria-hidden="true" />
                      {installing === currentBackend.id ? '正在安装…' : `安装 ${currentBackend.displayName}`}
                    </button>
                  )}
                </div>
              ) : null}

              {/* Install log renders outside the conditional above so it stays
                  visible after a successful install, when the backend becomes
                  available and the "not installed" block unmounts. */}
              {installLog && (
                <div className="join-auth-block">
                  <pre className="lobby-install-log">{installLog}</pre>
                </div>
              )}
            </div>
          )}
        </div>

        <section className="lobby-readiness">
          <button
            type="button"
            className="join-auth-toggle"
            onClick={() => { void openDiagnostics(); }}
          >
            <Activity size={14} aria-hidden="true" />
            <span>设备就绪</span>
            <span className="lobby-readiness-summary">
              {backends.filter((backend) => backend.supportsWorkers).length}/4 Worker
            </span>
            <ChevronDown size={14} className={diagnosticsOpen ? 'join-auth-chevron open' : 'join-auth-chevron'} />
          </button>

          {diagnosticsOpen && (
            <div className="device-readiness-panel">
              {diagnostics ? (
                <>
                  <div className="device-readiness-grid">
                    <div>
                      <span>系统</span>
                      <strong>{diagnostics.platform} · {diagnostics.arch}</strong>
                      <small>kernel {diagnostics.kernel} · {diagnostics.sessionType}</small>
                    </div>
                    <div>
                      <span>Electron / GPU</span>
                      <strong>{diagnostics.gpu.available ? '可用' : '诊断失败'}</strong>
                      <small>Electron {diagnostics.electronVersion}</small>
                    </div>
                    <div>
                      <span>音频 / 讯飞 ASR</span>
                      <strong>{diagnostics.audio.xfyun ? '讯飞已配置' : '讯飞需配置'}</strong>
                      <small>
                        麦克风 {microphoneLabel(diagnostics.audio.microphone)}
                        {' · '}
                        扬声器 {diagnostics.audio.speaker === 'available' ? '可用' : '待测试'}
                      </small>
                    </div>
                    <div>
                      <span>Git / 容量</span>
                      <strong>{diagnostics.workspace.worktree ? 'worktree 可用' : '需安装 Git'}</strong>
                      <small>{diagnostics.capacity.hosts} Host · {diagnostics.capacity.workers} Worker</small>
                    </div>
                  </div>

                  <div className="backend-readiness-list">
                    {backends.filter((backend) => ['claude-code', 'opencode', 'codex', 'kimi'].includes(backend.id)).map((backend) => (
                      <div className={`backend-readiness-row is-${backend.workerRuntimeState}`} key={backend.id}>
                        <div>
                          <strong>{backend.displayName}</strong>
                          {backend.workerReleaseTier === 'experimental' && (
                            <span className="backend-readiness-experimental" title="实验性 Worker：未通过首发稳定门禁，可能不稳定">实验</span>
                          )}
                          <span>
                            {backend.workerRuntimeState === 'available'
                              ? '可用'
                              : backend.workerRuntimeState === 'needs-login'
                                ? '需登录'
                                : backend.workerRuntimeState === 'needs-install'
                                  ? '需安装'
                                  : backend.workerRuntimeState === 'version-incompatible'
                                    ? '版本不兼容'
                                    : '诊断失败'}
                          </span>
                        </div>
                        <p>{backend.workerRuntimeReason}</p>
                        <small>
                          {backend.version ?? '版本未知'}
                          {backend.expectedVersion ? ` / 验证版本 ${backend.expectedVersion}` : ''}
                        </small>
                        {backend.id === 'claude-code' && backend.workerRuntimeState === 'version-incompatible' && (
                          <select
                            className="lobby-backend-select"
                            value={backend.claudeCodeCliSource ?? 'system'}
                            onChange={(e) => { void setClaudeCliSource(e.target.value as 'bundled' | 'system'); }}
                          >
                            <option value="system" disabled={backend.systemClaudeAvailable === false}>
                              系统 PATH {backend.systemClaudeVersion ? `(v${backend.systemClaudeVersion})` : '(已安装)'}
                            </option>
                            <option value="bundled" disabled={backend.bundledClaudeAvailable === false}>
                              内置 {backend.bundledClaudeVersion ? `(v${backend.bundledClaudeVersion})` : '(已安装)'}
                            </option>
                          </select>
                        )}
                        {backend.workerRuntimeState !== 'available' && (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedBackend(backend.id);
                              setAuthOpen(true);
                            }}
                          >
                            {backend.workerRuntimeState === 'needs-install'
                              ? '前往安装'
                              : backend.workerRuntimeState === 'needs-login'
                                ? '前往登录'
                                : '查看处理方式'}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="device-readiness-loading" aria-live="polite">
                  {diagnosticsError ?? '正在检查设备、音频、Git 和 Worker 契约…'}
                </div>
              )}
            </div>
          )}
        </section>

        <ProjectRooms
          rooms={rooms}
          observed={observed}
          firstLaunch={firstLaunch}
          opening={opening}
          onOpen={openRoom}
          onScanned={() => onFirstScanDone?.()}
        />

        {(lastError || openError) && (
          <div className="join-error">{openError ?? lastError}</div>
        )}

        <button
          type="button"
          className={`join-cta lobby-cta${firstLaunch ? ' is-secondary' : ''}`}
          onClick={() => setCreateOpen(true)}
          disabled={opening}
        >
          <FolderPlus size={16} aria-hidden="true" />
          <span>{opening ? '正在打开…' : '新建项目室'}</span>
        </button>

        <div className="join-hints">
          <span className="join-hint-item"><Mic size={14} aria-hidden="true" /> 默认开启语音</span>
          <span className="join-hint-item"><MonitorUp size={14} aria-hidden="true" /> 屏幕截图手动发送</span>
          <span className="join-hint-item">按 ⌥ 随时打断</span>
        </div>


        {(onEnterBoard || onReplayOnboarding || onEnterMeeting || onOpenExplore) && (
          <div className="lobby-footer-actions">
            {onEnterBoard && (
              <button type="button" className="lobby-footer-btn" onClick={onEnterBoard}>
                查看任务看板
              </button>
            )}
            {onOpenExplore && (
              <button type="button" className="lobby-footer-btn" onClick={onOpenExplore}>
                探索配套硬件与功能
              </button>
            )}
            {onReplayOnboarding && (
              <button type="button" className="lobby-footer-btn" onClick={onReplayOnboarding}>
                重播首次启动
              </button>
            )}
            <button
              type="button"
              className="lobby-footer-btn"
              aria-expanded={collabOpen}
              onClick={() => setCollabOpen((v) => !v)}
            >
              {collabOpen ? '收起多设备协作' : '多设备协作（实验）'}
            </button>
          </div>
        )}
        {collabOpen && (
          <SharedMeetingEntry backends={backends} defaultHost={selectedBackend} onEnter={() => onEnterMeeting?.()} />
        )}
      </div>
      {pickerModal}
      <CreateRoomDialog
        open={createOpen}
        recent={lobby.recent.map((r) => r.path)}
        onClose={() => setCreateOpen(false)}
        onReady={(path, mode, fresh) => {
          setCreateOpen(false);
          if (mode === 'cli') {
            rememberTerminalFolder(path);
            onOpenTerminal?.();
            return;
          }
          if (fresh) meetingStore.markFreshProject(path);
          void openCwd(path);
        }}
      />
    </div>
  );
}
