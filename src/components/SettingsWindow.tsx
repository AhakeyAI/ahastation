// SettingsWindow — standalone settings page loaded in its own BrowserWindow
// via ?view=settings. Opaque solid background, no glass/transparency.
// Left nav lists the settings sections (shared with the top-bar dropdown);
// the right pane shows one section at a time.

import { Component, useCallback, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { useVoicePreferences } from '../hooks/useVoicePreferences';
import { useRemoteVoiceLock } from '../hooks/useRemoteVoiceLock';
import { MemoryPanel } from './MemoryPanel';
import { VoiceSelector } from './VoiceSelector';
import { VoiceLockPanel } from './VoiceLockPanel';
import { SkillManagerPanel } from './SkillManagerPanel';
import { UpcomingSettingsPanel } from './UpcomingSettingsPanel';
import { BackendSettings } from './BackendSettings';
import { UnifiedCollaborationSettings } from './UnifiedCollaborationSettings';
import { IDEManagerPanel } from './IDEManagerPanel';
import { VoiceGuideModal } from './VoiceGuideModal';
import { SPEAKER_MODEL_ID } from '../lib/speaker-embedding';
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, resolveSettingsSection, type SettingsSectionId } from '../lib/settings-sections';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class SettingsErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[SettingsWindow] Uncaught error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="settings-window">
          <header className="settings-window-header">
            <h1 className="settings-window-title">设置</h1>
          </header>
          <div className="settings-window-body" style={{ padding: 24, textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
            <h2 style={{ fontSize: 16, marginBottom: 8 }}>设置加载失败</h2>
            <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
              {this.state.error.message || 'An unexpected error occurred'}
            </p>
            <button
              type="button"
              className="settings-window-close"
              style={{ position: 'static', padding: '8px 20px', fontSize: 13 }}
              onClick={() => window.close()}
            >
              关闭窗口
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** AhaTalk 处理路径（原顶栏胶囊）。本地已可用；自有 Key / Cloud 后端未建（M3-7）。 */
function AhaTalkPath() {
  const paths = [
    { id: 'local', title: '本地', hint: '在本机识别和整理，内容不上传', ready: true },
    { id: 'key', title: '自有 Key', hint: '直连你自己的模型服务', ready: false },
    { id: 'cloud', title: 'AhaTalk Cloud', hint: '交给 AhaTalk 托管处理', ready: false },
  ];
  return (
    <div className="settings-choice" role="radiogroup" aria-label="AhaTalk 处理路径">
      {paths.map((p) => (
        <div key={p.id} role="radio" aria-checked={p.id === 'local'} aria-disabled={!p.ready}
          className={`settings-choice-item${p.id === 'local' ? ' is-active' : ''}${p.ready ? '' : ' is-disabled'}`}>
          <span className="settings-choice-title">{p.title}</span>
          <span className="settings-choice-hint">{p.hint}</span>
          {!p.ready && <span className="settings-choice-tag">开发中</span>}
        </div>
      ))}
    </div>
  );
}

function readFocusParam(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('focus');
  } catch {
    return null;
  }
}

function SettingsWindowInner() {
  const voicePrefs = useVoicePreferences({ autoOpenGuide: false });
  const [appVersion, setAppVersion] = useState<string>('');
  const [updateInfo, setUpdateInfo] = useState<{ latest: string; url: string } | null>(null);
  const [active, setActive] = useState<SettingsSectionId>(() => resolveSettingsSection(readFocusParam()));
  // Enrollment runs on the main window's mic pipeline — this hook drives the
  // panel over the enrollment bridge instead of a disconnected local capture.
  const voiceLock = useRemoteVoiceLock();

  useEffect(() => {
    void window.vibeMeet.appVersion().then(setAppVersion).catch(() => {});
    return window.vibeMeet.onUpdateAvailable((info) => setUpdateInfo(info));
  }, []);

  // The top-bar dropdown re-targets an already-open window.
  useEffect(() => window.vibeMeet.settingsWindow.onFocusSection((payload) => {
    setActive(resolveSettingsSection(payload.section));
  }), []);

  const handleClose = useCallback(() => {
    void window.vibeMeet.settingsWindow.close();
  }, []);

  const section = SETTINGS_SECTIONS.find((s) => s.id === active) ?? SETTINGS_SECTIONS[0];
  const voiceProps = {
    voices: voicePrefs.voices,
    selectedVoiceName: voicePrefs.selectedVoiceName,
    onChange: voicePrefs.handleVoiceChange,
    onOpenGuide: voicePrefs.handleOpenGuide,
    filterMode: voicePrefs.filterMode,
    onChangeFilterMode: voicePrefs.handleFilterModeChange,
    voicePolishEnabled: voicePrefs.voicePolishEnabled,
    onChangeVoicePolish: voicePrefs.handleVoicePolishChange,
    reportModeEnabled: voicePrefs.reportModeEnabled,
    onChangeReportMode: voicePrefs.handleReportModeChange,
    handheldMode: voicePrefs.handheldMode,
    onChangeHandheldMode: voicePrefs.handleHandheldModeChange,
    xfyunAsr: voicePrefs.xfyunAsr,
    onXfyunAsrInput: voicePrefs.handleXfyunAsrInput,
    onXfyunAsrCommit: voicePrefs.handleXfyunAsrCommit,
    xfyunDirty: voicePrefs.xfyunDirty,
    xfyunSaveState: voicePrefs.xfyunSaveState,
  };

  return (
    <div className="settings-window">
      <header className="settings-window-header">
        <h1 className="settings-window-title">设置</h1>
        <button
          type="button"
          className="settings-window-close"
          onClick={handleClose}
          aria-label="关闭设置"
        >
          ✕
        </button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分区">
          {SETTINGS_GROUPS.map((group) => (
            <div className="settings-nav-group" key={group.label}>
              <div className="settings-nav-label">{group.label}</div>
              {group.sections.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={`settings-nav-item${item.id === active ? ' is-active' : ''}`}
                    aria-current={item.id === active ? 'page' : undefined}
                    onClick={() => setActive(item.id)}
                  >
                    <Icon size={15} aria-hidden="true" />
                    <span>{item.title}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <main className="settings-window-body" key={section.id}>
          <header className="settings-section-head">
            <h2>{section.title}</h2>
            <p>{section.description}</p>
          </header>
          {active === 'backends' && <BackendSettings />}
          {active === 'ahatalk' && (
            <>
              <div className="settings-subhead">处理路径</div>
              <AhaTalkPath />
              <div className="settings-subhead">识别与整理</div>
              <VoiceSelector {...voiceProps} part="talk" />
            </>
          )}
          {active === 'speech' && <VoiceSelector {...voiceProps} part="speech" />}
          {active === 'ide' && <IDEManagerPanel />}
          {active === 'skills' && <SkillManagerPanel />}
          {active === 'memory' && <MemoryPanel />}
          {active === 'voicelock' && (
            <VoiceLockPanel
              enabled={voiceLock.voiceLockEnabled}
              enrolledAt={voiceLock.voicePrint?.enrolledAt ?? null}
              modelMatches={voiceLock.voicePrint?.model === SPEAKER_MODEL_ID}
              enrollment={voiceLock.enrollment}
              recentlyRejected={voiceLock.recentlyRejected}
              enrollmentToast={voiceLock.enrollmentToast}
              onToggleEnabled={voiceLock.handleToggleVoiceLock}
              onStartEnroll={voiceLock.handleStartEnrollment}
              onCancelEnroll={voiceLock.handleCancelEnrollment}
              onClearEnrollment={voiceLock.handleClearEnrollment}
            />
          )}
          {active === 'collab' && <UnifiedCollaborationSettings />}
          {active === 'general' && (
            <>
              <div className="settings-version">
                <span>当前版本 v{appVersion || '…'}</span>
                {updateInfo
                  ? <a href={updateInfo.url} target="_blank" rel="noreferrer">新版本 {updateInfo.latest} 可用，前往下载</a>
                  : <span className="settings-version-ok">已是最新</span>}
              </div>
              <VoiceSelector {...voiceProps} part="general" />
            </>
          )}
          {active === 'upcoming' && <UpcomingSettingsPanel />}
        </main>
      </div>
      {voicePrefs.guideOpen && (
        <VoiceGuideModal
          open={voicePrefs.guideOpen}
          onClose={voicePrefs.handleGuideClose}
          onDismissForever={voicePrefs.handleDismissForever}
        />
      )}
    </div>
  );
}

export function SettingsWindow() {
  return (
    <SettingsErrorBoundary>
      <SettingsWindowInner />
    </SettingsErrorBoundary>
  );
}
