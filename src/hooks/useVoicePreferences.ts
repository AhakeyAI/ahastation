import { useCallback, useEffect, useRef, useState } from 'react';
import { setSelectedVoiceName, setSpeechFilterMode, useVoices, warmupTTS } from './useSpeech';
import type { SpeechFilterMode } from '../lib/speech-format';
import type { HandheldOverride } from '../lib/handheld-mode';
import { hasPremiumChineseVoice, listChineseVoices } from '../lib/voice-quality';
import type { XfyunAsrCredentials } from '../types';

const DEFAULT_XFYUN_ASR: XfyunAsrCredentials = { appId: '', apiKey: '', apiSecret: '' };

/** `autoOpenGuide: false` keeps the voice guide closed until the user asks
 *  (secondary windows such as Settings would otherwise each pop it). */
export function useVoicePreferences({ autoOpenGuide = true }: { autoOpenGuide?: boolean } = {}) {
  const [selectedVoiceName, setSelectedVoiceNameState] = useState<string | null>(null);
  const [guidanceDismissed, setGuidanceDismissed] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  // getVoicePref() is async; until it resolves guidanceDismissed holds its
  // initial `false`, which the auto-open effect below would happily act on.
  // Gate the effect on prefLoaded so a persisted "don't show again" can't
  // be raced past on every window mount.
  const [prefLoaded, setPrefLoaded] = useState(false);
  const [guidanceClosedThisSession, setGuidanceClosedThisSession] = useState(false);
  const [filterMode, setFilterModeState] = useState<SpeechFilterMode>('strict');
  const [voicePolishEnabled, setVoicePolishEnabled] = useState(false);
  const [reportModeEnabled, setReportModeEnabled] = useState(false);
  const [handheldMode, setHandheldMode] = useState<HandheldOverride>('auto');
  const [xfyunAsr, setXfyunAsr] = useState<XfyunAsrCredentials>(DEFAULT_XFYUN_ASR);
  // Latest form values for the onBlur commit - state inside a callback
  // would go stale between keystrokes.
  const xfyunAsrRef = useRef(xfyunAsr);
  // Explicit-save UX: dirty tracks unsaved edits; saveState drives the
  // 保存并重连 button label so the user gets unambiguous feedback instead
  // of relying on blur-commit alone.
  const [xfyunDirty, setXfyunDirty] = useState(false);
  const [xfyunSaveState, setXfyunSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const { voices, ready: voicesReady } = useVoices();
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

  useEffect(() => {
    let cancelled = false;
    window.vibeMeet.getVoicePref().then((pref) => {
      if (cancelled) return;
      setSelectedVoiceNameState(pref.selectedVoiceName);
      setGuidanceDismissed(pref.guidanceDismissed);
      setFilterModeState(pref.speechFilterMode);
      setVoicePolishEnabled(pref.voicePolishEnabled);
      setReportModeEnabled(pref.reportModeEnabled);
      setHandheldMode(pref.handheldMode);
      setXfyunAsr(pref.xfyunAsr);
      xfyunAsrRef.current = pref.xfyunAsr;
      setSelectedVoiceName(pref.selectedVoiceName);
      setSpeechFilterMode(pref.speechFilterMode);
      setPrefLoaded(true);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // "Don't show again" clicked in another window: the main process
  // broadcasts settings:voice-pref-changed — re-fetch so this window stops
  // nagging without waiting for a remount.
  useEffect(() => {
    const unsubscribe = window.vibeMeet.onVoicePrefChanged?.(() => {
      window.vibeMeet.getVoicePref().then((pref) => {
        setGuidanceDismissed(pref.guidanceDismissed);
      }).catch(() => {});
    });
    return () => { unsubscribe?.(); };
  }, []);

  useEffect(() => {
    if (!voicesReady) return;
    warmupTTS();
  }, [voicesReady]);

  useEffect(() => {
    if (!autoOpenGuide || !isMac || !voicesReady || !prefLoaded) return;
    const chineseAny = listChineseVoices(voices).length > 0;
    const hasPremium = hasPremiumChineseVoice(voices);
    if (hasPremium || guidanceDismissed) {
      setGuideOpen(false);
      return;
    }
    if (!guidanceClosedThisSession && chineseAny) {
      setGuideOpen(true);
    }
  }, [autoOpenGuide, isMac, voicesReady, voices, guidanceDismissed, guidanceClosedThisSession, prefLoaded]);

  const handleVoiceChange = useCallback((name: string | null) => {
    setSelectedVoiceNameState(name);
    setSelectedVoiceName(name);
    void window.vibeMeet.setVoicePref({ selectedVoiceName: name });
  }, []);

  const handleFilterModeChange = useCallback((mode: SpeechFilterMode) => {
    setFilterModeState(mode);
    setSpeechFilterMode(mode);
    void window.vibeMeet.setVoicePref({ speechFilterMode: mode });
  }, []);

  const handleVoicePolishChange = useCallback((enabled: boolean) => {
    setVoicePolishEnabled(enabled);
    void window.vibeMeet.setVoicePref({ voicePolishEnabled: enabled });
  }, []);

  const handleReportModeChange = useCallback((enabled: boolean) => {
    setReportModeEnabled(enabled);
    void window.vibeMeet.setVoicePref({ reportModeEnabled: enabled });
  }, []);

  const handleHandheldModeChange = useCallback((mode: HandheldOverride) => {
    setHandheldMode(mode);
    void window.vibeMeet.setVoicePref({ handheldMode: mode });
  }, []);

  // Typing only updates local state; the write to settings.json happens on
  // blur (handleXfyunAsrCommit) so each keystroke doesn't hit disk.
  const handleXfyunAsrInput = useCallback((patch: Partial<XfyunAsrCredentials>) => {
    setXfyunAsr((prev) => {
      const next = { ...prev, ...patch };
      xfyunAsrRef.current = next;
      return next;
    });
    setXfyunDirty(true);
    setXfyunSaveState((s) => (s === 'saved' ? 'idle' : s));
  }, []);

  // Explicit save (button) and blur-commit share this path. On success the
  // main process broadcasts settings:voice-pref-changed, every useAsr hook
  // re-probes availability, and the mic capture restarts against the new
  // credentials — no app restart needed.
  const handleXfyunAsrCommit = useCallback(async (): Promise<boolean> => {
    setXfyunSaveState('saving');
    try {
      const res = await window.vibeMeet.setVoicePref({ xfyunAsr: xfyunAsrRef.current });
      if (res && res.ok === false) {
        setXfyunSaveState('error');
        return false;
      }
      setXfyunDirty(false);
      setXfyunSaveState('saved');
      window.setTimeout(() => {
        setXfyunSaveState((s) => (s === 'saved' ? 'idle' : s));
      }, 3000);
      return true;
    } catch {
      setXfyunSaveState('error');
      return false;
    }
  }, []);

  const handleOpenGuide = useCallback(() => setGuideOpen(true), []);
  const handleGuideClose = useCallback(() => {
    setGuideOpen(false);
    setGuidanceClosedThisSession(true);
  }, []);
  const handleDismissForever = useCallback(() => {
    setGuidanceDismissed(true);
    setGuidanceClosedThisSession(true);
    setGuideOpen(false);
    void window.vibeMeet.setVoicePref({ guidanceDismissed: true });
  }, []);

  return {
    selectedVoiceName,
    filterMode,
    voicePolishEnabled,
    reportModeEnabled,
    handheldMode,
    xfyunAsr,
    voices,
    voicesReady,
    guideOpen,
    handleVoiceChange,
    handleFilterModeChange,
    handleVoicePolishChange,
    handleReportModeChange,
    handleHandheldModeChange,
    handleXfyunAsrInput,
    handleXfyunAsrCommit,
    xfyunDirty,
    xfyunSaveState,
    handleOpenGuide,
    handleGuideClose,
    handleDismissForever,
  };
}
