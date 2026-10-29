import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkers } from './hooks/useWorkers';
import { useMeetingSelector } from './hooks/useMeetingSelector';
import { useTabs } from './hooks/useTabs';
import { useCrossProjectTasks } from './hooks/useCrossProjectTasks';
import { useScreenShare } from './hooks/useScreenShare';
import { useBrowser } from './hooks/useBrowser';
import { useStageWindows } from './hooks/useStageWindows';
import { BOARD_TAB_ID, stageWindowStore } from './lib/stage-window-store';
import { cancelSpeech, isSpeechActive } from './hooks/useSpeech';
import { useAsr } from './hooks/useAsr';
import { useVoiceLock } from './hooks/useVoiceLock';
import { useVoicePreferences } from './hooks/useVoicePreferences';
import { useSpacebarMute } from './hooks/useSpacebarMute';
import { useTtsWiring } from './hooks/useTtsWiring';
import { useDragAndDrop } from './hooks/useDragAndDrop';
import { useHandheldMode } from './lib/handheld-mode';
import { planDisplayMigration } from './lib/display-migration';
import { meetingStore, type MeetingState } from './lib/meeting-store';
import { handleVoiceFinal } from './lib/voice-final';
import { remoteMentionIds, REMOTE_ATTACHMENT_ERROR } from '../electron/backends/pocket-vibe-target';
import { browserStore, requestHideBrowser } from './lib/browser-store';
import { toast } from './lib/toast';
import { Lobby } from './components/Lobby';
import { LocalTerminalWorkspace } from './components/LocalTerminalWorkspace';
import { UnifiedMeetingFrame } from './components/UnifiedMeetingFrame';
import {SharedApprovals} from './components/UnifiedMeetingParts';
import {useUnifiedMeeting,projectShared,selectSharedMeeting,sendShared,sharedMentionBackends,sharedRequest} from './lib/unified-meeting-store';
import { Onboarding, ONBOARDED_STORAGE_KEY, type OnboardingMode } from './components/Onboarding';
import { MinimizePrompt } from './components/MinimizePrompt';
import { TabStrip } from './components/TabStrip';
import { MeetingResumeBanner } from './components/MeetingResumeBanner';
import { meetingAvailability } from './lib/meeting-availability';
import { watchBackendList } from './lib/backend-refresh';
import { MeetingHeader } from './components/MeetingHeader';
import { AppTopBar } from './components/AppTopBar';
import { StatusBar } from './components/StatusBar';
import { BroadcastStrip } from './components/BroadcastStrip';
import { UsageStrip } from './components/UsageStrip';
import { VoiceControl } from './components/VoiceControl';
import { Camera, Gamepad2, MessageSquare, Monitor, MonitorUp, Square } from 'lucide-react';
import { MeetingControls } from './components/MeetingControls';
import { AgentDetailPanel } from './components/AgentDetailPanel';
import { ExplorePage } from './components/ExplorePage';
import { TasksView } from './components/TasksView';
import { ParticipantTile } from './components/ParticipantTile';
import { ScreenStage } from './components/ScreenStage';
import { SourcePicker } from './components/SourcePicker';
import { BottomToolbar } from './components/BottomToolbar';
import { SideDrawer } from './components/SideDrawer';
import { SettingsMenu } from './components/SettingsMenu';
import { VoiceGuideModal } from './components/VoiceGuideModal';
import { ParticipantPanel } from './components/ParticipantPanel';
import { ApprovalCard } from './components/ApprovalCard';
import { EditorOverlay } from './components/EditorOverlay';
import { Modal } from './components/Modal';
import { ToastViewport } from './components/ToastViewport';
import { PlanMeetingModal } from './components/PlanMeetingModal';
import {
  buildDirectAttachmentDirective,
  buildDirectDirective,
  buildPlanAttachmentDirective,
  buildPlanDirective,
  type DispatchMode,
} from './lib/dispatch-mode';
import type { AutoApproveScope, BackendInfo, DesktopSource, PendingPermission, SkillInfo } from './types';

/** First pending permission across all workers, mirroring the legacy useClaude
 *  aggregate. Low-frequency: only changes when a permission appears/resolves. */
function selectFirstPendingPermission(s: MeetingState): PendingPermission | null {
  for (const ws of s.workers.values()) {
    if (ws.pendingPermission) return ws.pendingPermission;
  }
  return null;
}

export function App() {
  const workers = useWorkers();
  const sharedState=useUnifiedMeeting();
  const sharedModel=useMemo(()=>sharedState.view&&sharedState.activeId?projectShared(sharedState.view,sharedState.activeId):undefined,[sharedState]);
  const [sharedInterrupt,setSharedInterrupt]=useState(false);
  const {
    restartSession, sendText, sendImage, sendAttachments, publishDroppedFiles,
    onDroppedFiles, resolvePermission, interrupt, setSpeakCallback,
  } = workers;
  // Low-frequency slices subscribed individually. High-frequency streams
  // (transcript/activity) are subscribed inside SideDrawer; the mic level and
  // elapsed timer bypass React entirely (mic-level channel / ElapsedTime).
  const running = useMeetingSelector((s) => s.running);
  const lastError = useMeetingSelector((s) => s.lastError);
  const pendingPermission = useMeetingSelector(selectFirstPendingPermission);
  const cwd = workers.cwd;
  const tabs = useTabs();
  const crossProjectTasks = useCrossProjectTasks();
  const { state: share, start: startShare, startSystemPicker, stop: stopShare, captureFrame, videoRef } = useScreenShare();
  const browser = useBrowser();
  const stageWindows = useStageWindows();

  const activeTab = useMemo(() => tabs.find((t) => t.isActive) ?? null, [tabs]);
  const meetingGate = meetingAvailability(activeTab, running);
  const hasTabs = tabs.length > 0;
  const hasLiveTab = !!sharedModel||!!(activeTab && !activeTab.placeholder);
  const activeOpenedAt = activeTab?.openedAt ?? null;

  // 对话面板默认收起：会议启动或切换会议后先看舞台（任务看板），需要时
  // 从顶栏「对话」展开；拖入文件、点参会者时仍会自动展开。
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The multi-device (collaboration) frame keeps its chat open by default —
  // its whole surface is the shared conversation.
  const [sharedDrawerOpen, setSharedDrawerOpen] = useState(true);
  const [ttsOn, setTtsOn] = useState(true);
  const [muted, setMuted] = useState(false);
  const [autoApproveScope, setAutoApproveScope] = useState<AutoApproveScope>('off');
  const [multiAgent, setMultiAgent] = useState(true);
  const [dispatchMode, setDispatchMode] = useState<DispatchMode>('direct');
  // P3 agent 详情面板（右侧滑出）：'user' 忽略，hostId/workerId 打开详情
  const [agentPanelId, setAgentPanelId] = useState<string | null>(null);
  // P6 探索页
  const [exploreOpen, setExploreOpen] = useState(false);
  /** Zero-session entry: after onboarding (or the Lobby's 查看任务看板 button)
   *  the main UI opens straight onto the task board without a session. Flips
   *  back off as soon as a real session tab exists so closing all tabs lands
   *  on the Lobby again. */
  const [boardOnly, setBoardOnly] = useState(false);
  const [localTerminalOpen, setLocalTerminalOpen] = useState(false);
  const [showLobby, setShowLobby] = useState(false);
  /** First launch ever → full 4-step flow; later cold starts → scan-only
   *  splash. Suppressed under the dev visual fixtures so screenshots of the
   *  Lobby/meeting stay deterministic. */
  const [onboardingMode, setOnboardingMode] = useState<OnboardingMode | null>(() => {
    if (import.meta.env.DEV
      && new URLSearchParams(window.location.search).has('ui-fixture')) return null;
    try {
      return window.localStorage.getItem(ONBOARDED_STORAGE_KEY) ? 'splash' : 'full';
    } catch {
      return 'full';
    }
  });
  /** Bumped every time the task board asks the meeting view to open a task, so
   *  re-clicking the same card after closing the inspector still reopens it. */
  const [taskFocus, setTaskFocus] = useState<{ taskId: string; seq: number } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [viewingFile, setViewingFile] = useState<{ relativePath: string } | null>(null);
  const [openParticipantsTabSignal, setOpenParticipantsTab] = useState(false);
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [mutedHostIds, setMutedHostIds] = useState<Set<string>>(new Set());
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const visualFixture = import.meta.env.DEV
    && new URLSearchParams(window.location.search).has('ui-fixture');

  useEffect(() => {
    if (!activeTab || activeTab.placeholder) return;
    void window.vibeMeet.setOrchestrationMode(activeTab.id, multiAgent);
  }, [activeTab?.id, activeTab?.placeholder, multiAgent]);

  const attentionCount = useMemo(
    () => crossProjectTasks.tasks.filter((t) => t.column === 'attention').length
      + crossProjectTasks.pendingPlans.length,
    [crossProjectTasks],
  );

  // P3 agent 详情面板数据解析：host tile → 该组 talker；worker tile → worker 本体
  const agentPanelData = useMemo(() => {
    if (!agentPanelId) return null;
    const hg = workers.hostGroups.get(agentPanelId) ?? null;
    const directWorker = workers.workerList.find((w) => w.id === agentPanelId) ?? null;
    const talker = hg
      ? workers.workerList.find((w) => w.role === 'talker' && (w.hostId || 'default') === hg.id) ?? null
      : null;
    return { worker: directWorker ?? talker, hostGroup: hg };
  }, [agentPanelId, workers.hostGroups, workers.workerList]);

  // 状态栏活跃任务计数（进行中 + 待批准 + 待验收）
  const activeTaskCount = useMemo(() => {
    const nodes = workers.plan?.nodes ?? [];
    const active = nodes.filter(
      (node) => !['accepted', 'done', 'failed', 'interrupted'].includes(node.status),
    ).length;
    return active + (pendingPermission ? 1 : 0) + (workers.pendingPlan ? 1 : 0);
  }, [workers.plan, pendingPermission, workers.pendingPlan]);

  const handleOpenTaskFromBoard = useCallback((sessionId: string, taskId: string) => {
    void meetingStore.setActive(sessionId);
    setTaskFocus((prev) => ({ taskId, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  const handleOpenPlanFromBoard = useCallback((sessionId: string) => {
    void meetingStore.setActive(sessionId);
  }, []);

  const enterBoardOnly = useCallback(() => {
    meetingStore.dismissRestoreHydration();
    setShowLobby(false);
    setBoardOnly(true);
    void stageWindowStore.setActiveWindow(BOARD_TAB_ID);
  }, []);

  const handleOnboardingFinish = useCallback((mode: OnboardingMode) => {
    setOnboardingMode(null);
    if (mode !== 'full') return;
    try {
      window.localStorage.setItem(ONBOARDED_STORAGE_KEY, '1');
    } catch { /* private mode etc. — the flow simply replays next launch */ }
    // First-launch finish with no session lands on the task board (Feature:
    // zero-project entry); with restored tabs the meeting view stays.
    if (!hasTabs) enterBoardOnly();
  }, [hasTabs, enterBoardOnly]);

  // Once a real session exists the zero-session entry is over — closing all
  // tabs then returns to the Lobby (the only place that opens folders).
  useEffect(() => {
    if (boardOnly && hasTabs) setBoardOnly(false);
  }, [boardOnly, hasTabs]);

  // Load available backends for the participants tab
  useEffect(() => {
    window.vibeMeet.skills.list().then((res) => {
      if (res.ok) setSkills(res.skills);
    }).catch(() => {});
  }, []);

  // Reload backends when main window regains focus (e.g. settings window closed)
  useEffect(() => {
    return watchBackendList(setBackends, (error) => toast.error(`刷新后端状态失败：${String(error)}`));
  }, []);

  const activeBackendIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [, hg] of workers.hostGroups) ids.add(hg.backendId);
    return ids;
  }, [workers.hostGroups]);

  // Sync the meeting store's default host group with the actual default backend
  useEffect(() => {
    const defaultBackend = backends.find((b) => b.isDefault);
    if (defaultBackend) {
      workers.syncDefaultBackend(defaultBackend.id);
    }
  }, [backends, workers]);

  // Map backendId → custom avatar data URL for participant panel rendering
  const customAvatars = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const b of backends) {
      if (b.customAvatar) map.set(b.iconId, b.customAvatar);
    }
    return map;
  }, [backends]);

  // SideDrawer renders the unified ApprovalCard for the first pending
  // permission across all workers (state.pendingPermission). Thread the
  // matching worker's resolving/error flags so that card stays in lock-step
  // with WorkerCard and TaskInspector for the same permission id.
  const drawerPermissionState = useMemo(() => {
    const pending = pendingPermission;
    if (!pending) return { resolving: false, error: null as string | null };
    const owner = workers.workerList.find((w) => w.pendingPermission?.id === pending.id);
    return {
      resolving: owner?.resolvingPermissionId === pending.id,
      error: owner?.permissionError ?? null,
    };
  }, [pendingPermission, workers.workerList]);

  // 批准卡片四要素上下文（04 BR-A2：项目/任务/客户端/动作缺一不渲染）
  const approvalMeta = useMemo(() => {
    const pending = pendingPermission;
    const ownerW = pending
      ? workers.workerList.find((w) => w.pendingPermission?.id === pending.id)
      : undefined;
    const project = cwd
      ? (cwd.split('/').filter(Boolean).pop() ?? cwd)
      : '当前项目';
    return {
      owner: ownerW?.title ?? 'Coordinator',
      backendId: ownerW?.backendId,
      project,
    };
  }, [pendingPermission, workers.workerList, cwd]);

  const speakingRef = useRef(false);
  const sendWithModeRef = useRef<(text: string) => void>(sendText);

  const voiceLock = useVoiceLock({ muted, setMuted, setAiSpeaking, speakingRef });
  const voicePrefs = useVoicePreferences();

  // Voice-lock enrollment bridge: the enrollment UI lives in the settings
  // window, but the mic/VAD pipeline lives here. The settings window sends
  // start/cancel commands over IPC; we run enrollment on this hook and stream
  // progress back so the panel can render it.
  useEffect(() => {
    return window.vibeMeet.onVoiceLockEnrollCmd((cmd) => {
      if (cmd === 'start') voiceLock.handleStartEnrollment();
      else if (cmd === 'cancel') voiceLock.handleCancelEnrollment();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceLock.handleStartEnrollment, voiceLock.handleCancelEnrollment]);

  useEffect(() => {
    window.vibeMeet.sendVoiceLockEnrollState({
      enrollment: voiceLock.enrollment,
      toast: voiceLock.enrollmentToast,
    });
  }, [voiceLock.enrollment, voiceLock.enrollmentToast]);

  // Stable element for both header variants — an inline JSX slot would break
  // the memoized MeetingHeader/AppTopBar on every App render.
  const settingsSlot = useMemo(
    () => <SettingsMenu badge={voiceLock.enrollmentActive} />,
    [voiceLock.enrollmentActive],
  );
  useSpacebarMute(muted, setMuted);
  useTtsWiring({ ttsOn, speakingRef, setAiSpeaking, setSpeakCallback });
  const dragDrop = useDragAndDrop({
    publishDroppedFiles,
    onFilesDropped: () => setDrawerOpen(true),
  });

  // aiSpeaking safety-net: clears stuck state when TTS controller drains
  useEffect(() => {
    if (!aiSpeaking) return;
    const id = window.setInterval(() => {
      if (speakingRef.current && !isSpeechActive()) {
        speakingRef.current = false;
        setAiSpeaking(false);
      }
    }, 300);
    return () => window.clearInterval(id);
  }, [aiSpeaking]);

  // Reset the participants-tab signal once SideDrawer has consumed it
  useEffect(() => {
    if (openParticipantsTabSignal && drawerOpen) {
      setOpenParticipantsTab(false);
    }
  }, [openParticipantsTabSignal, drawerOpen]);

  useEffect(() => {
    meetingStore.hydrateRestore().catch((err) => {
      console.error('[App] hydrateRestore failed:', err);
    });
  }, []);

  // Auto-open delivery files as individual top-level tabs when a new delivery arrives
  const lastDeliveryTaskId = useRef<string | null>(null);
  useEffect(() => {
    const delivery = workers.currentDelivery;
    if (!delivery) return;
    if (delivery.taskId === lastDeliveryTaskId.current) return;
    lastDeliveryTaskId.current = delivery.taskId;
    // Open each delivery file as its own independent top-level tab
    // Use the snapshot path (inside deliveries/) when available so files
    // are always read from the project directory, not external locations.
    for (const f of delivery.files) {
      const filePath = f.snapshotPath
        ?? (f.snapshotRelativePath && cwd ? `${cwd}/${f.snapshotRelativePath}` : f.path);
      stageWindows.openFile(filePath);
    }
  }, [workers.currentDelivery, stageWindows, cwd]);

  // Auto-open saved documents (from save_document MCP tool) as file tabs
  const lastSavedDocsRef = useRef<string[] | null>(null);
  useEffect(() => {
    const docs = workers.savedDocuments;
    const prev = lastSavedDocsRef.current;
    lastSavedDocsRef.current = docs;
    // savedDocuments is per-session-slot: switching meeting tabs swaps the
    // whole array. A length counter would desync there (a fresh slot's first
    // doc never opens) — so only auto-open when the SAME array grew by
    // appending, and never retro-open another slot's history.
    if (!prev || docs.length <= prev.length) return;
    const isAppend = prev.every((path, i) => docs[i] === path);
    if (!isAppend) return;
    for (const path of docs.slice(prev.length)) {
      stageWindows.openFile(path);
    }
  }, [workers.savedDocuments, stageWindows]);

  const micEnabled = !visualFixture && ((!showLobby&&hasLiveTab) || voiceLock.enrollmentActive);

  const onVoiceFinal = useCallback(async (text: string) => {
    const id = meetingStore.getActiveId();
    if(sharedModel){
      const mentionBackends=sharedMentionBackends(sharedModel,backends);
      await handleVoiceFinal(text,{polish:voicePrefs.voicePolishEnabled?(v)=>window.vibeMeet.polishAsrText(v):undefined,skills,backends:mentionBackends,activeBackendIds:new Set(mentionBackends.map(b=>b.id)),hosts:sharedModel.members.map(m=>({id:m.id,remoteTarget:{title:m.label}})),send:v=>sendShared(sharedModel,v),notify:message=>toast.error(message)});return;
    }
    if (!id) {
      console.warn('[voice] dropped — no active session');
      return;
    }
    await handleVoiceFinal(text, {
      polish: voicePrefs.voicePolishEnabled ? (value) => window.vibeMeet.polishAsrText(value) : undefined,
      skills, backends, activeBackendIds, hosts: workers.hostGroups.values(),
      send: (value) => sendWithModeRef.current(value),
      notify: (message) => { toast.error(message); },
    });
  }, [voicePrefs.voicePolishEnabled, skills, backends, activeBackendIds, workers.hostGroups,sharedModel]);

  const onBargeIn = useCallback(() => {
    if (speakingRef.current) {
      cancelSpeech();
      meetingStore.markBargeIn();
      speakingRef.current = false;
      setAiSpeaking(false);
    }
  }, []);

  const {
    mode: asrMode,
    listening: effectiveListening,
    supported: micSupported,
    lastError: micError,
    status: micStatus,
    retryable: micRetryable,
    retry: retryMic,
  } = useAsr({
    // Enrollment must capture even when the mic toggle is off — useAsr mounts
    // VAD for a tapSegment request, but only while `enabled` is true.
    enabled: micEnabled || voiceLock.enrollmentActive,
    onTranscript: onVoiceFinal,
    onBargeIn,
    paused: muted,
    suppressed: aiSpeaking,
    voiceLockEnabled: voiceLock.voiceLockEnabled,
    voicePrintEmbedding: voiceLock.voicePrintEmbedding,
    onVoiceLockReject: voiceLock.handleVoiceLockReject,
    tapSegment: voiceLock.enrollmentActive ? voiceLock.handleEnrollmentSegment : undefined,
  });

  useEffect(() => {
    meetingStore.setAutoApproveScope(autoApproveScope);
    void (async () => {
      const res = await window.vibeMeet.setAutoApprove(autoApproveScope);
      if (!res.ok || !running) return;
      const id = meetingStore.getActiveId();
      // Only 'all' bypasses SDK permission checks entirely. 'read' keeps the
      // default mode so canUseTool still runs — the session-level scope then
      // auto-allows safe tools and escalates destructive ones.
      void window.vibeMeet.setPermissionMode(
        id,
        autoApproveScope === 'all' ? 'bypassPermissions' : 'default',
      );
    })();
  }, [autoApproveScope, running]);

  useEffect(() => {
    // Auto-resolve pending cards only under 'all'. Under 'read', anything
    // that reached the UI card was already classified as non-safe upstream
    // (safe tools never become pending), so it must stay a manual decision.
    if (autoApproveScope === 'all' && pendingPermission) {
      void resolvePermission(pendingPermission.id, 'allow');
    }
  }, [autoApproveScope, pendingPermission, resolvePermission]);

  const leave = useCallback(async () => {
    // These pre-steps must never throw — a failure here used to skip closeTab
    // entirely, leaving the session alive main-side with no way back in.
    try { cancelSpeech(); } catch { /* teardown continues */ }
    speakingRef.current = false;
    setAiSpeaking(false);
    try { stopShare(); } catch { /* teardown continues */ }
    const id = meetingStore.getActiveId();
    if (id) {
      try { await meetingStore.closeTab(id); }
      catch (error) { toast.error(`关闭会议失败：${String(error)}`); }
    }
    setBoardOnly(false);
    if (!meetingStore.getTabs().length) setShowLobby(true);
  }, [stopShare]);

  const continueMeeting = useCallback(async () => {
    if (!activeTab) return;
    const result = await meetingStore.continueMeeting(activeTab.id);
    if (result && !result.ok) toast.error(result.error ?? '会议启动失败');
  }, [activeTab]);

  const goHome = useCallback(() => {
    meetingStore.dismissRestoreHydration();
    selectSharedMeeting(null);
    setShowLobby(true);
  }, []);

  const handlePickSource = useCallback(async (src: DesktopSource) => {
    await startShare(src.id, src.name);
  }, [startShare]);

  const toggleShare = useCallback(async () => {
    if (share.active) {
      stopShare();
      return;
    }
    try {
      const useSystem = await window.vibeMeet.useSystemPicker();
      if (useSystem) {
        await startSystemPicker();
      } else {
        setPickerOpen(true);
      }
    } catch {
      setPickerOpen(true);
    }
  }, [share.active, stopShare, startSystemPicker]);

  const handleSnapshot = useCallback(async () => {
    const dataUrl = captureFrame();
    if (!dataUrl) return;
    const caption = `Here is the current view of "${share.sourceName ?? 'my screen'}". Take a look and let me know what you see.`;
    if(sharedModel){
      const projectId=String(sharedModel.meeting.mainProjectId??'');
      const base64=dataUrl.split(',')[1];
      try{const ref=await sharedRequest('files.stage',{projectId,files:[{name:'screen-'+Date.now()+'.png',dataBase64:base64,sizeBytes:Math.floor(base64.length*3/4)-(base64.endsWith('==')?2:base64.endsWith('=')?1:0)}]});if(!(ref as {cancelled?:boolean}).cancelled)await sendShared(sharedModel,caption,undefined,[ref]);}catch(error){toast.error(String(error));}return;
    }
    await sendImage(dataUrl, caption);
  }, [captureFrame, sendImage, share.sourceName,sharedModel]);

  // Stable callbacks for memoized children — inline arrows in JSX would
  // create fresh references every render and silently defeat React.memo.
  const toggleMute = useCallback(() => setMuted((v) => !v), []);
  const toggleTts = useCallback(() => setTtsOn((v) => !v), []);
  const toggleChat = useCallback(() => setDrawerOpen((v) => !v), []);
  const toggleCompanion = useCallback(() => { void window.vibeMeet.companion?.toggle(); }, []);
  const openPermissionModal = useCallback(() => setPermModalOpen(true), []);
  const toggleMultiAgent = useCallback(() => setMultiAgent((v) => !v), []);
  const openExplore = useCallback(() => setExploreOpen(true), []);
  const closeAgentPanel = useCallback(() => setAgentPanelId(null), []);
  const openParticipantsTab = useCallback(() => {
    setDrawerOpen(true);
    setOpenParticipantsTab(true);
  }, []);
  const handleSelectParticipant = useCallback((id: string) => {
    if (id !== 'user') setAgentPanelId(id);
  }, []);
  const handleViewFile = useCallback((path: string) => {
    setViewingFile({ relativePath: path });
    stageWindows.openFile(path);
    // stageWindows.openFile is a stable useCallback; the wrapper object is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageWindows.openFile]);
  const handleAddHost = useCallback(async (backendId: string) => {
    const result = await workers.addHostGroup(backendId);
    if (result && !result.ok) {
      toast.error(`邀请成员失败：${result.error ?? '未知原因'}`);
      return;
    }
    // Refresh backends after adding a host
    window.vibeMeet.backendAuth.list().then(setBackends).catch(() => setBackends([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workers.addHostGroup]);

  const handleToggleMuteHost = useCallback((hostId: string) => {
    setMutedHostIds((prev) => {
      const next = new Set(prev);
      if (next.has(hostId)) next.delete(hostId);
      else next.add(hostId);
      return next;
    });
  }, []);

  const handleRemoveHost = useCallback(async (hostId: string) => {
    if (hostId === 'default') return;
    const result = await workers.removeHostGroup(hostId);
    if (result && !result.ok) toast.error(`移出成员失败：${result.error ?? '未知原因'}`);
  }, [workers]);

  const handleSetCoordinator = useCallback(async (hostId: string) => {
    const result = await workers.setCoordinator(hostId);
    if (!result.ok) toast.error(`切换主持人失败：${result.error ?? '未知原因'}`);
  }, [workers]);

  const handleRestartHost = useCallback(async (hostId: string) => {
    const result = await workers.restartHost(hostId);
    if (!result.ok) toast.error(`重连成员失败：${result.error ?? '未知原因'}`);
  }, [workers]);

  // Handheld UI mode (§3.3): resolved mode drives the root <html> class via
  // the hook; this flag switches the toolbar variant + approval modal AND
  // the editor form factor (overlay in handheld, independent window else).
  const { mode: uiMode, override: uiModeOverride } = useHandheldMode();
  const handheld = uiMode === 'handheld';
  // A newly started or switched-to meeting opens with the chat drawer closed.
  const activeMeetingId = activeTab?.id;
  useEffect(() => {
    if (activeMeetingId) setDrawerOpen(false);
  }, [activeMeetingId]);
  const handheldInitialDrawerApplied = useRef(false);
  useEffect(() => {
    if (!handheld || handheldInitialDrawerApplied.current) return;
    handheldInitialDrawerApplied.current = true;
    setDrawerOpen(false);
  }, [handheld]);
  const [permModalOpen, setPermModalOpen] = useState(false);
  const permissionCount = workers.workerList.filter((w) => w.pendingPermission).length;
  // Pragmatic update notice (Phase 6b): shown only when the probe actually
  // found a newer release tag (no-op while the repo is private).
  const [updateInfo, setUpdateInfo] = useState<{ latest: string; url: string } | null>(null);
  useEffect(() => window.vibeMeet.onUpdateAvailable((info) => setUpdateInfo(info)), []);
  // Handheld editor overlay (Phase 6a): the hostId currently shown in the
  // App-internal overlay, or null. Overlay ≠ route — App stays mounted.
  const [overlayHostId, setOverlayHostId] = useState<string | null>(null);

  const handleOpenEditor = useCallback((backendId: string, hostId: string) => {
    if (!meetingGate.ready) { toast.error(meetingGate.reason); return; }
    if (handheld) {
      // Handheld form factor: App-internal overlay, no separate window.
      setOverlayHostId(hostId);
      return;
    }
    const sessionId = activeTab?.id ?? 'default';
    const editorCwd = cwd || '.';
    const title = `${backendId} - ${hostId}`;
    void window.vibeMeet.openCodeEditor.open({
      backendId,
      hostId,
      sessionId,
      cwd: editorCwd,
      title,
    });
  }, [handheld, activeTab?.id, cwd, meetingGate.ready, meetingGate.reason]);

  // Dual-display migration (Phase 6a §3.2, AUTO mode only): when the
  // resolved mode flips after a display add/remove, convert the editor form
  // factor — overlay → independent window on desktop, window → overlay on
  // handheld. Scene (file/scroll) round-trips via the scene store.
  const prevUiModeRef = useRef(uiMode);
  useEffect(() => {
    const prev = prevUiModeRef.current;
    prevUiModeRef.current = uiMode;
    if (prev === uiMode) return;
    if (!meetingGate.ready) return;
    void (async () => {
      const wins = await window.vibeMeet.openCodeEditor.list().catch(() => null);
      const editorWindows = wins && wins.ok ? wins.windows.map((w) => w.hostId) : [];
      const actions = planDisplayMigration({
        override: uiModeOverride,
        modeBefore: prev,
        modeAfter: uiMode,
        overlay: { open: overlayHostId !== null, hostId: overlayHostId },
        editorWindows,
      });
      for (const action of actions) {
        if (action.kind === 'overlay-to-window') {
          const hostId = action.hostId;
          setOverlayHostId(null);
          const backendId = workers.hostGroups.get(hostId)?.backendId ?? 'opencode';
          void window.vibeMeet.openCodeEditor.open({
            backendId,
            hostId,
            sessionId: activeTab?.id ?? 'default',
            cwd: cwd || '.',
            title: `${backendId} - ${hostId}`,
          });
        } else {
          void window.vibeMeet.openCodeEditor.close(action.hostId);
          setOverlayHostId(action.hostId);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiMode]);

  const sendWithMode = useCallback(async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const remoteMention = remoteMentionIds(trimmed, [...workers.hostGroups.values()]).length > 0;
    if (remoteMention) {
      await sendText(trimmed);
      return;
    }
    if (!multiAgent) {
      await sendText(trimmed);
      return;
    }
    const directive = dispatchMode === 'plan'
      ? buildPlanDirective(trimmed)
      : trimmed;
    // Chat shows only the user's words; the model still gets the full directive.
    await sendText(directive, { displayText: trimmed });
  }, [dispatchMode, multiAgent, sendText, workers.hostGroups]);

  sendWithModeRef.current = sendWithMode;

  const sendAttachmentsWithMode = useCallback(
    async (staged: Parameters<typeof sendAttachments>[0], raw: string) => {
      const trimmed = raw.trim();
      if (staged.length && remoteMentionIds(trimmed, [...workers.hostGroups.values()], true).length) {
        return { ok: false, error: REMOTE_ATTACHMENT_ERROR };
      }
      if (!multiAgent) {
        return sendAttachments(staged, trimmed);
      }
      const directive = dispatchMode === 'plan'
        ? buildPlanAttachmentDirective(trimmed)
        : trimmed;
      return sendAttachments(staged, directive, {
        displayText: trimmed.length > 0 ? trimmed : undefined,
      });
    },
    [dispatchMode, multiAgent, sendAttachments, workers.hostGroups],
  );

  // Memoized element trees handed to memoized children. Inline JSX in props
  // is a fresh object every render and would defeat React.memo downstream.
  const selfTile = useMemo(() => (
    <ParticipantTile
      name="You"
      role="You"
      initials="You"
      variant="self"
      speaking={effectiveListening && !muted}
      muted={muted}
      status={muted ? '已静音' : effectiveListening ? '说话中' : '麦克风空闲'}
      ariaLabel="查看我派出的任务"
    />
  ), [effectiveListening, muted]);

  const galleryContent = useMemo(() => (!meetingGate.ready ? <div className="drawer-empty">{meetingGate.reason}</div> :
    <ParticipantPanel
      workers={workers.workerList}
      hostGroups={workers.hostGroups}
      customAvatars={customAvatars}
      mutedHostIds={mutedHostIds}
      aiSpeaking={aiSpeaking}
      onResolvePermission={resolvePermission}
      onToggleMuteHost={handleToggleMuteHost}
      onRemoveHost={handleRemoveHost}
      coordinatorHostId={workers.coordinatorHostId}
      onSetCoordinator={handleSetCoordinator}
      onRestartHost={handleRestartHost}
      onOpenParticipantsTab={openParticipantsTab}
      onOpenEditor={handleOpenEditor}
      onSelectParticipant={handleSelectParticipant}
      selfTile={selfTile}
    />
  ), [
    workers.workerList, workers.hostGroups, workers.coordinatorHostId,
    meetingGate.ready, meetingGate.reason,
    customAvatars, mutedHostIds, aiSpeaking, resolvePermission,
    handleToggleMuteHost, handleRemoveHost, handleSetCoordinator,
    handleRestartHost, openParticipantsTab, handleOpenEditor,
    handleSelectParticipant, selfTile,
  ]);

  const controlsSlot = useMemo(() => (!handheld ? (
    <MeetingControls
      autoApproveScope={autoApproveScope}
      onChangeAutoApproveScope={setAutoApproveScope}
      multiAgent={multiAgent}
      onToggleMultiAgent={toggleMultiAgent}
    />
  ) : undefined), [handheld, autoApproveScope, multiAgent, toggleMultiAgent]);

  useEffect(()=>sharedModel&&!showLobby?requestHideBrowser():undefined,[sharedModel?.meeting.id,showLobby]);

  const toolbar=(<BottomToolbar
        muted={muted}
        onToggleMute={toggleMute}
        micSupported={micSupported}
        listening={effectiveListening}
        asrMode={asrMode}
        micStatus={micStatus}
        micRetryable={micRetryable}
        onRetryMic={retryMic}
        ttsOn={ttsOn}
        onToggleTts={toggleTts}
        sharing={share.active}
        onToggleShare={toggleShare}
        snapshotEnabled={share.active && (running||!!sharedModel)}
        onSnapshot={handleSnapshot}
        onInterrupt={sharedModel?()=>setSharedInterrupt(true):interrupt}
        chatOpen={sharedModel ? sharedDrawerOpen : drawerOpen}
        onToggleChat={sharedModel ? () => setSharedDrawerOpen((v) => !v) : toggleChat}
        onLeave={sharedModel?goHome:leave}
        onToggleCompanion={toggleCompanion}
        handheld={handheld}
        permissionCount={sharedModel?(sharedModel.view.snapshot.entities.approval??[]).filter(a=>a.status==='pending'&&sharedModel.tasks.some(t=>t.id===a.taskId&&t.attemptId===a.attemptId)).length:permissionCount}
        onOpenPermission={openPermissionModal}
        controlsSlot={sharedModel?undefined:controlsSlot}
      />);
  if (localTerminalOpen) {
    return <LocalTerminalWorkspace onBack={() => setLocalTerminalOpen(false)} />;
  }
  if(sharedModel&&!showLobby)return <><UnifiedMeetingFrame key={sharedModel.meeting.id} model={sharedModel} backends={backends} settingsSlot={settingsSlot} toolbar={toolbar} onHome={goHome} view="meeting" onView={() => {}} requestInterrupt={sharedInterrupt} onInterruptClose={()=>setSharedInterrupt(false)} onSubscribeDroppedFiles={onDroppedFiles} drawerOpen={sharedDrawerOpen} ttsOn={ttsOn} onSpeaking={setAiSpeaking} screen={{share,videoRef,onStop:stopShare}} dragHandlers={{onDragEnter:dragDrop.onDragEnter,onDragOver:dragDrop.onDragOver,onDragLeave:dragDrop.onDragLeave,onDrop:dragDrop.onDrop}}/><SourcePicker open={pickerOpen} onClose={()=>setPickerOpen(false)} onPick={handlePickSource}/><VoiceGuideModal open={voicePrefs.guideOpen} onClose={voicePrefs.handleGuideClose} onDismissForever={voicePrefs.handleDismissForever}/><MinimizePrompt/>{permModalOpen&&<div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-label="本会议工具审批" className="unified-dialog"><h2>本会议工具审批</h2><SharedApprovals model={sharedModel}/><button onClick={()=>setPermModalOpen(false)}>关闭审批</button></section></div>}<ToastViewport/></>;

  if (showLobby || (!hasTabs && !boardOnly)) {
    return (
      <>
        <Lobby
          lastError={lastError}
          onEnterBoard={enterBoardOnly}
          onOpenTerminal={() => setLocalTerminalOpen(true)}
          onEnterMeeting={() => setShowLobby(false)}
          onReplayOnboarding={() => setOnboardingMode('full')}
          onOpenExplore={openExplore}
        />
        {exploreOpen && <ExplorePage onClose={() => setExploreOpen(false)} />}
        {onboardingMode && (
          <Onboarding mode={onboardingMode} onFinish={handleOnboardingFinish} />
        )}
        <MinimizePrompt />
        <ToastViewport />
      </>
    );
  }

  return (
    <div
      className={`mtg${dragDrop.dropActive ? ' mtg-dropping' : ''}`}
      onDragEnter={dragDrop.onDragEnter}
      onDragOver={dragDrop.onDragOver}
      onDragLeave={dragDrop.onDragLeave}
      onDrop={dragDrop.onDrop}
    >
      {/* 单会议收敛（一台设备一个会议，调度所有任务）：掌机模式或确有
          多会话并存时才显示 TabStrip；默认不暴露多会议 Tab。 */}
      {(handheld || tabs.length > 1) && <TabStrip tabs={tabs} />}
      {handheld && <div className="meeting-navigation"><button type="button" onClick={goHome}>首页 / 选择目录</button></div>}
      <MeetingResumeBanner tab={activeTab ?? undefined} error={lastError} onContinue={() => void continueMeeting()} onHome={goHome} />
      {handheld ? (
        <MeetingHeader
          cwd={cwd}
          startedAt={activeOpenedAt}
          autoApproveScope={autoApproveScope}
          onChangeAutoApproveScope={setAutoApproveScope}
          multiAgent={multiAgent}
          onToggleMultiAgent={toggleMultiAgent}
          settingsSlot={settingsSlot}
        />
      ) : (
        <AppTopBar
          onHome={goHome}
          settingsSlot={settingsSlot}
          actions={(
            <>
              {controlsSlot}
              <VoiceControl
                muted={muted}
                onToggleMute={toggleMute}
                micSupported={micSupported}
                listening={effectiveListening}
                asrMode={asrMode}
                micStatus={micStatus}
                micRetryable={micRetryable}
                onRetryMic={retryMic}
                ttsOn={ttsOn}
                onToggleTts={toggleTts}
              />
              <button type="button" className={`aha-topbar-toggle${drawerOpen ? ' is-on' : ''}`} onClick={toggleChat}
                aria-pressed={drawerOpen} title={drawerOpen ? '收起对话' : '展开对话'}>
                <MessageSquare size={15} aria-hidden="true" />
                <span>对话</span>
              </button>
              <button type="button" className="aha-topbar-toggle" onClick={toggleCompanion}
                title="开关 AhaBar 悬浮条（待批准快捷键）">
                <Gamepad2 size={15} aria-hidden="true" />
                <span>AhaBar</span>
              </button>
            </>
          )}
        />
      )}

      {!handheld && (
        <BroadcastStrip briefings={workers.coordinatorBriefings} onInterrupt={onBargeIn} />
      )}

      <main className="mtg-main">
        <section className="stage-wrap">
          <ScreenStage
            share={share}
            videoRef={videoRef}
            onPickSource={() => setPickerOpen(true)}
            onStopShare={stopShare}
            workers={workers.workerList}
            hostGroups={workers.hostGroups}
            plan={workers.plan}
            coordinatorBriefings={workers.coordinatorBriefings}
            running={running}
            aiSpeaking={aiSpeaking}
            galleryContent={galleryContent}
            delivery={workers.currentDelivery}
            finalMeetingDelivery={workers.finalMeetingDelivery}
            finalMeetingDecision={workers.finalMeetingDecision}
            sessionId={meetingGate.sessionId}
            cwd={cwd ?? undefined}
            focusTask={taskFocus}
            onAcceptDelivery={() => workers.acceptDelivery()}
            onReviseDelivery={(fb: string) => workers.reviseDelivery(fb)}
            onAcceptFinalMeetingDelivery={() => workers.acceptFinalMeetingDelivery()}
            onRequestFinalMeetingRework={(reason: string) => workers.requestFinalMeetingRework(reason)}
            viewingFile={viewingFile}
            onCloseFileView={() => setViewingFile(null)}
            stageWindows={stageWindows.windows}
            activeWindowId={stageWindows.activeWindowId}
            onSelectWindow={stageWindows.setActiveWindow}
            onCloseWindow={stageWindows.closeWindow}
            onCreateWindow={stageWindows.createWindow}
            onPopOutWindow={(id: string) => {
              if (window.vibeMeet?.popoutStage) {
                const win = stageWindows.windows.find((w) => w.id === id);
                void window.vibeMeet.popoutStage(id, win?.type ?? 'activity');
              }
            }}
            onResolvePermission={resolvePermission}
            browserTabs={browser.state.tabs}
            browserActiveTabId={browser.state.activeTabId}
            browserViewportRef={browser.viewportRef}
            onBrowserOpenTab={browser.openTab}
            onBrowserCloseTab={browser.closeTab}
            onBrowserSetActive={browser.setActiveTab}
            onBrowserNavigate={browser.navigate}
            onBrowserBack={browser.goBack}
            onBrowserForward={browser.goForward}
            onBrowserReload={browser.reload}
            customAvatars={customAvatars}
            boardAttention={attentionCount}
            boardContent={(
              <TasksView
                data={crossProjectTasks}
                onOpenTask={handleOpenTaskFromBoard}
                onOpenPlan={handleOpenPlanFromBoard}
              />
            )}
          />
        </section>

        <SideDrawer
          open={drawerOpen}
          pending={pendingPermission}
          pendingResolving={drawerPermissionState.resolving}
          pendingError={drawerPermissionState.error}
          approvalMeta={approvalMeta}
          onResolve={resolvePermission}
          onSend={sendWithMode}
          onSendAttachments={sendAttachmentsWithMode}
          onSubscribeDroppedFiles={onDroppedFiles}
          multiAgent={multiAgent}
          dispatchMode={dispatchMode}
          onChangeDispatchMode={setDispatchMode}
          disabled={!meetingGate.ready}
          disabledReason={meetingGate.reason}
          sessionId={meetingGate.sessionId}
          onViewFile={handleViewFile}
          viewingFilePath={viewingFile?.relativePath ?? null}
          backends={backends}
          activeBackendIds={activeBackendIds}
          onAddHost={handleAddHost}
          forceParticipantsTab={openParticipantsTabSignal}
          composerTools={handheld ? undefined : (
            <>
              <button type="button" className={`composer-tool${share.active ? ' is-danger' : ''}`} onClick={toggleShare}
                title={share.active ? '停止共享屏幕' : '共享屏幕给 Host'}>
                {share.active ? <Monitor size={14} aria-hidden="true" /> : <MonitorUp size={14} aria-hidden="true" />}
                <span>{share.active ? '停止共享' : '共享屏幕'}</span>
              </button>
              <button type="button" className="composer-tool" onClick={handleSnapshot} disabled={!(share.active && running)}
                title={share.active ? '把当前画面发给 Host' : '先共享屏幕，才能截图'}>
                <Camera size={14} aria-hidden="true" />
                <span>截图</span>
              </button>
              <button type="button" className="composer-tool" onClick={interrupt} title="打断 Host 当前的回复">
                <Square size={14} aria-hidden="true" />
                <span>打断</span>
              </button>
            </>
          )}
        />

        {!handheld && agentPanelData && (
          <AgentDetailPanel
            worker={agentPanelData.worker}
            hostGroup={agentPanelData.hostGroup}
            backends={backends}
            cwd={cwd}
            onClose={closeAgentPanel}
            onOpenEditor={handleOpenEditor}
          />
        )}
      </main>

      {handheld && toolbar}

      {/* 额度条：各 AI 剩余额度（对标 Orca 状态栏额度），放在底部状态栏上方，
          面板向上展开。外部会话改在任务看板里看。 */}
      {!handheld && <UsageStrip placement="bottom" />}

      {!handheld && (
        <StatusBar
          clientCount={workers.hostGroups.size}
          activeTaskCount={activeTaskCount}
          cwd={cwd}
          startedAt={activeOpenedAt}
        />
      )}

      {handheld && permModalOpen && pendingPermission && (
        <Modal
          open
          backdropClassName="perm-modal-backdrop"
          className="perm-modal"
          ariaLabel="权限审批"
          onClose={() => setPermModalOpen(false)}
        >
          <ApprovalCard
            pending={pendingPermission}
            owner={approvalMeta.owner}
            backendId={approvalMeta.backendId}
            project={approvalMeta.project}
            onDecide={async (id, decision) => {
              const res = await resolvePermission(id, decision);
              if (res && res.ok) setPermModalOpen(false);
              return res;
            }}
          />
        </Modal>
      )}

      {meetingGate.ready && overlayHostId && (
        <EditorOverlay
          hostId={overlayHostId}
          sessionId={activeTab?.id ?? 'default'}
          cwd={cwd || '.'}
          hosts={[...workers.hostGroups.entries()].map(([id, hg]) => ({ hostId: id, backendId: hg.backendId }))}
          onSwitchHost={setOverlayHostId}
          onClose={() => setOverlayHostId(null)}
          muted={muted}
          listening={effectiveListening}
          onToggleMute={() => setMuted((v) => !v)}
          onInterrupt={interrupt}
        />
      )}

      <SourcePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={handlePickSource}
      />

      <VoiceGuideModal
        open={voicePrefs.guideOpen}
        onClose={voicePrefs.handleGuideClose}
        onDismissForever={voicePrefs.handleDismissForever}
      />

      <ToastViewport />

      <PlanMeetingModal
        open={Boolean(workers.pendingPlan)}
        brief={workers.pendingPlanBrief}
        tasks={workers.pendingPlan ?? []}
        backends={backends}
        onReject={() => workers.decidePendingPlan(false)}
        onSubmit={(tasks,brief) => workers.decidePendingPlan(true, tasks,brief)}
      />

      {exploreOpen && <ExplorePage onClose={() => setExploreOpen(false)} />}
      {onboardingMode && (
        <Onboarding mode={onboardingMode} onFinish={handleOnboardingFinish} />
      )}

      {(lastError || micError || updateInfo) && (
        <div className="banner-stack">
          {(lastError || micError) && (
            <div className="error-banner">
              <span className="error-banner__text">{lastError ?? micError}</span>
              {lastError && !running && (
                <button
                  type="button"
                  className="error-banner__reconnect"
                  onClick={() => { void restartSession(); }}
                >
                  Reconnect
                </button>
              )}
              {!lastError && micError && micRetryable && (
                <button
                  type="button"
                  className="error-banner__reconnect"
                  onClick={retryMic}
                >
                  Retry microphone
                </button>
              )}
            </div>
          )}

          {updateInfo && (
            <div className="error-banner error-banner--info">
              <span className="error-banner__text">新版本 {updateInfo.latest} 可用</span>
              <a className="error-banner__reconnect" href={updateInfo.url} target="_blank" rel="noreferrer">
                前往下载
              </a>
            </div>
          )}
        </div>
      )}

      {onboardingMode && (
        <Onboarding mode={onboardingMode} onFinish={handleOnboardingFinish} />
      )}

      <MinimizePrompt />
    </div>
  );
}
