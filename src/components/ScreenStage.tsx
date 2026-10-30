import {
  memo,
  ReactNode,
  RefObject,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  cloneElement,
  isValidElement,
} from 'react';
import type { ScreenShareState } from '../hooks/useScreenShare';
import type { DeliverySnapshot, HostGroupState, WorkerState } from '../lib/meeting-store';
import type {
  BrowserTabInfo,
  CommandRun,
  CoordinatorBriefing,
  FinalMeetingDecision,
  MeetingDelivery,
  MeetingPlan,
} from '../types';
import { ACTIVITY_TAB_ID, BOARD_TAB_ID, type StageWindow, type StageWindowType, type StageWindowOptions } from '../lib/stage-window-store';
import { computeWorkerCapacity } from '../lib/worker-capacity';
import { isTerminalWorkerBackendId } from '../lib/terminal-backends';
import { FileViewer } from './FileViewer';
import { BrowserStage } from './BrowserStage';
import { StageTabBar } from './StageTabBar';
import { MeetingNotesPanel } from './MeetingNotesPanel';
import { TerminalPanel } from './TerminalPanel';
import { ShellTerminal } from './ShellTerminal';
import { RealTerminal } from './RealTerminal';
import { WorkerWorkbench } from './WorkerWorkbench';
import { ActivityTabContent } from './ActivityTabContent';
import { DeliveryViewer } from './DeliveryViewer';
import { TaskInspector } from './TaskInspector';
import { FinalMeetingDelivery } from './FinalMeetingDelivery';
import type {UnifiedModel} from '../lib/unified-meeting-store';
import {SharedParticipants} from './ParticipantPanel';
import {SharedUserTasksPanel} from './UserTasksPanel';
import {SharedTaskInspector} from './TaskInspector';

export interface SharedScreenContext {share:ScreenShareState;videoRef:RefObject<HTMLVideoElement>;onStop:()=>void}
export function SharedScreenStage({model,onInvite,taskId,onTask,onCloseTask,screen}:{model:UnifiedModel;onInvite:()=>void;taskId:string|null;onTask:(id:string)=>void;onCloseTask:()=>void;screen:SharedScreenContext}){
  return <section className="stage-wrap unified-stage"><SharedParticipants model={model} onInvite={onInvite} onOpenTask={onTask}/><div className="unified-workspace">{screen.share.active&&<section className="unified-screen"><header>{screen.share.sourceName}<button onClick={screen.onStop}>停止屏幕共享</button></header><video ref={screen.videoRef} autoPlay muted playsInline style={{maxHeight:'38vh',maxWidth:'100%'}}/></section>}{taskId?<SharedTaskInspector key={model.meeting.id+':'+taskId} model={model} taskId={taskId} onClose={onCloseTask}/>:<SharedUserTasksPanel model={model} onOpenTask={onTask}/>}</div></section>;
}


function matchesWorker(w: WorkerState, workerId: string): boolean {
  return w.id === workerId || w.hostId === workerId;
}

interface ScreenStageProps {
  share: ScreenShareState;
  videoRef: RefObject<HTMLVideoElement>;
  onPickSource: () => void;
  onStopShare: () => void;
  workers: WorkerState[];
  hostGroups: Map<string, HostGroupState>;
  plan: MeetingPlan | null;
  coordinatorBriefings: CoordinatorBriefing[];
  running: boolean;
  aiSpeaking: boolean;
  galleryContent: ReactNode;
  delivery: DeliverySnapshot | null;
  finalMeetingDelivery: MeetingDelivery | null;
  finalMeetingDecision: FinalMeetingDecision | null;
  sessionId: string | null;
  cwd?: string;
  /** Task the cross-project board asked us to open. `seq` changes on every
   *  request so re-picking the same task after closing the inspector works. */
  focusTask?: { taskId: string; seq: number } | null;
  onAcceptDelivery: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onReviseDelivery: (feedback: string) => Promise<
    | { ok: true; route: 'worker' | 'talker'; queued?: boolean }
    | { ok: false; error: string }
  >;
  onAcceptFinalMeetingDelivery: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onRequestFinalMeetingRework: (reason: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  viewingFile?: { relativePath: string } | null;
  onCloseFileView?: () => void;
  stageWindows: StageWindow[];
  activeWindowId: string | null;
  onSelectWindow: (id: string) => void;
  onCloseWindow: (id: string) => void;
  onCreateWindow: (type: StageWindowType, opts?: StageWindowOptions) => void;
  onPopOutWindow?: (id: string) => void;
  /** Open the user's native CLI for a worker that has no PTY of its own. */
  onOpenNativeCli?: (target: { backendId?: string; title?: string }) => void;
  onResolvePermission: (id: string, decision: 'allow' | 'deny') => Promise<{ ok: true } | { ok: false; error: string }> | void;
  browserTabs?: BrowserTabInfo[];
  browserActiveTabId?: string | null;
  browserViewportRef?: RefObject<HTMLDivElement>;
  onBrowserOpenTab?: () => void;
  onBrowserCloseTab?: (id: string) => void;
  onBrowserSetActive?: (id: string) => void;
  onBrowserNavigate?: (tabId: string, url: string) => void;
  onBrowserBack?: (tabId: string) => void;
  onBrowserForward?: (tabId: string) => void;
  onBrowserReload?: (tabId: string) => void;
  /** Map of iconId → custom avatar data URL */
  customAvatars?: Map<string, string | null>;
  /** Task board rendered by the pinned 「任务看板」 tab (the stage default). */
  boardContent?: ReactNode;
  /** 待批准 + 待确认 count, badged on the board tab. */
  boardAttention?: number;
  /** Expert-owned sub-agent tasks (AME-D14): taskId → owner hostId + title. */
  ownedTasks?: Map<string, { hostId: string; title: string }> | null;
}


export const ScreenStage = memo(function ScreenStage({
  share,
  videoRef,
  onPickSource: _onPickSource,
  onStopShare,
  workers,
  hostGroups,
  plan,
  coordinatorBriefings,
  running,
  aiSpeaking = false,
  galleryContent,
  delivery,
  finalMeetingDelivery,
  finalMeetingDecision,
  sessionId,
  cwd,
  focusTask,
  onAcceptDelivery,
  onReviseDelivery,
  onAcceptFinalMeetingDelivery,
  onRequestFinalMeetingRework,
  viewingFile,
  onCloseFileView,
  stageWindows,
  activeWindowId,
  onSelectWindow,
  onCloseWindow,
  onCreateWindow,
  onPopOutWindow,
  onOpenNativeCli,
  onResolvePermission,
  browserTabs = [],
  browserActiveTabId = null,
  browserViewportRef,
  onBrowserOpenTab,
  onBrowserCloseTab,
  onBrowserSetActive,
  onBrowserNavigate,
  onBrowserBack,
  onBrowserForward,
  onBrowserReload,
  customAvatars,
  boardContent,
  boardAttention = 0,
  ownedTasks,
}: ScreenStageProps) {
  const [selectedParticipantId, setSelectedParticipantId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  /** Bumped on every task open so the inspector returns to Overview even for the same taskId. */
  const [inspectorOpenSeq, setInspectorOpenSeq] = useState(0);
  const [inspectorHeight, setInspectorHeight] = useState(76);
  const [inspectorFullscreen, setInspectorFullscreen] = useState(false);
  const dragState = useRef<{ pointerId: number; startY: number } | null>(null);
  const suppressInspectorClick = useRef(false);

  /** Task requested by the cross-project board whose plan hasn't arrived yet.
   *  Suppresses the stale-selection sweep below during the switch. */
  const awaitingFocus = useRef<string | null>(null);

  const handleSelectTask = useCallback((id: string) => {
    awaitingFocus.current = null;
    setSelectedTaskId(id);
    setInspectorOpenSeq((seq) => seq + 1);
    setInspectorHeight(76);
    setInspectorFullscreen(false);
    if (activeWindowId !== ACTIVITY_TAB_ID) {
      onSelectWindow(ACTIVITY_TAB_ID);
    }
  }, [activeWindowId, onSelectWindow]);

  /** Open the docked Task Inspector from the Worker Workbench without switching
   *  the stage window away from the terminal - the TUI stays visible while the
   *  dock expands below for deep review (diff / verification / permissions). */
  const handleOpenInspectorFromWorkbench = useCallback((id: string) => {
    setSelectedTaskId(id);
    setInspectorOpenSeq((seq) => seq + 1);
    setInspectorHeight(76);
    setInspectorFullscreen(false);
  }, []);

  const handleSelectParticipant = useCallback((id: string) => {
    setSelectedParticipantId(id);
    // Worker tiles double as the in-meeting task picker now that TaskRail is
    // gone — open the inspector when the tile maps to a plan node.
    if ((plan?.nodes ?? []).some((node) => node.id === id)) {
      handleSelectTask(id);
      return;
    }
    if (activeWindowId !== ACTIVITY_TAB_ID) {
      onSelectWindow(ACTIVITY_TAB_ID);
    }
  }, [activeWindowId, onSelectWindow, plan, handleSelectTask]);

  useEffect(() => {
    if (!selectedTaskId) return;
    if ((plan?.nodes ?? []).some((node) => node.id === selectedTaskId)) {
      awaitingFocus.current = null;
      return;
    }
    // Switching projects from the board sets the selection before the target
    // session's plan swaps in, so hold the selection until its node lands.
    if (awaitingFocus.current === selectedTaskId) return;
    setSelectedTaskId(null);
  }, [plan, selectedTaskId]);

  // Depends on seq alone: the board can hand us the same taskId twice and the
  // inspector still has to come back up. Set awaitingFocus BEFORE selection so
  // the plan-sweep effect cannot clear the card during a cross-project switch
  // (handleSelectTask used to null the ref first, racing the hold).
  const focusSeq = focusTask?.seq;
  const focusTaskId = focusTask?.taskId;
  useEffect(() => {
    if (focusSeq === undefined || !focusTaskId) return;
    awaitingFocus.current = focusTaskId;
    setSelectedTaskId(focusTaskId);
    setInspectorOpenSeq((seq) => seq + 1);
    setInspectorHeight(76);
    setInspectorFullscreen(false);
    // Opened from the board tab: keep the board under the docked inspector.
  }, [focusSeq, focusTaskId]);

  // Auto-open a stage terminal window when a terminal-mode worker spawns, so
  // the human can supervise the TUI without manually clicking each worker
  // card. Dedup by workerId so re-renders never reopen a window the user
  // closed. Running workers qualify; an expert's sub-agent also qualifies
  // after it has stopped, so 重新开始 is still on screen. backendId arrives
  // with the first worker event, which is what makes the terminal-mode check
  // reliable.
  const autoOpenedTerminals = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const w of workers) {
      if (w.role !== 'worker') continue;
      if (!isTerminalWorkerBackendId(w.backendId)) continue;
      if (autoOpenedTerminals.current.has(w.id)) continue;
      const owned = ownedTasks?.get(w.id);
      // A recovered sub-agent is often already stopped. Still open its tab
      // so 重新开始 is on screen after the app comes back.
      const stoppedOwned = Boolean(owned) && ['failed', 'done', 'interrupted', 'accepted'].includes(w.status);
      if (w.status !== 'running' && !stoppedOwned) continue;
      autoOpenedTerminals.current.add(w.id);
      const owner = owned ? hostGroups.get(owned.hostId)?.profile : undefined;
      // An expert's sub-agent opens as the third tab (子 Agent), selected.
      void onCreateWindow('terminal', owned
        ? { workerId: w.id, title: `子 Agent · ${owner?.name ?? '专家'}`, subagentOwner: owned.hostId }
        : { workerId: w.id, title: w.title });
    }
  }, [workers, onCreateWindow, ownedTasks, hostGroups]);

  // Every "open terminal" entry lands here. A terminal-mode worker already
  // runs its native CLI in a PTY, so it gets the stage workbench; any other
  // backend (OpenCode, SDK, app-server, remote) has nothing to attach to and
  // opens the matching native CLI in the CLI workspace instead.
  const openWorkerTerminal = useCallback((workerId: string) => {
    const matches = workers.filter((w) => matchesWorker(w, workerId));
    const ptyWorker = matches.find((w) => isTerminalWorkerBackendId(w.backendId));
    if (ptyWorker || !onOpenNativeCli) {
      void onCreateWindow('terminal', { workerId: ptyWorker?.id ?? workerId, ...(ptyWorker ? { title: ptyWorker.title } : {}) });
      return;
    }
    const target = matches[0];
    onOpenNativeCli({
      backendId: target?.backendId ?? hostGroups.get(target?.hostId ?? workerId)?.backendId,
      title: target?.title,
    });
  }, [workers, hostGroups, onCreateWindow, onOpenNativeCli]);

  const isPtyTerminalWindow = useCallback((win: StageWindow) => (
    win.type === 'terminal' && !!win.workerId
      && workers.some((w) => matchesWorker(w, win.workerId!) && isTerminalWorkerBackendId(w.backendId))
  ), [workers]);

  const handlePopOut = useCallback((id: string) => {
    const win = stageWindows.find((w) => w.id === id);
    if (win?.type === 'terminal' && onOpenNativeCli) {
      if (win.workerId) openWorkerTerminal(win.workerId);
      else onOpenNativeCli({});
      return;
    }
    onPopOutWindow?.(id);
  }, [stageWindows, onOpenNativeCli, openWorkerTerminal, onPopOutWindow]);

  const handleInspectorPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    dragState.current = { pointerId: event.pointerId, startY: event.clientY };
    suppressInspectorClick.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handleInspectorPointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientY - dragState.current.startY) > 4) {
      suppressInspectorClick.current = true;
    }
    const next = Math.max(44, Math.min(100, ((window.innerHeight - event.clientY) / window.innerHeight) * 100));
    setInspectorHeight(next);
    setInspectorFullscreen(next >= 96);
  }, []);

  const finishInspectorDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    dragState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setInspectorHeight((current) => {
      if (current >= 88) {
        setInspectorFullscreen(true);
        return 100;
      }
      if (current <= 56) return 52;
      return 76;
    });
  }, []);

  const toggleInspectorFullscreen = useCallback(() => {
    setInspectorFullscreen((current) => {
      setInspectorHeight(current ? 76 : 100);
      return !current;
    });
  }, []);

  const activeWindow = stageWindows.find((w) => w.id === activeWindowId) ?? null;
  const isActivityTab = activeWindow?.type === 'activity' || activeWindowId === ACTIVITY_TAB_ID;
  const isBoardTab = activeWindow?.type === 'board';
  const selectedTaskWorker = selectedTaskId
    ? workers.find((worker) => worker.role !== 'talker' && worker.id === selectedTaskId)
    : undefined;
  const capacity = useMemo(
    () => computeWorkerCapacity(plan?.nodes ?? []),
    [plan],
  );

  // For terminal stage windows, project the high-fidelity Bash command log.
  // When no workerId is specified, aggregate every worker chronologically.
  const terminalCommands = useMemo(() => {
    if (activeWindow?.type !== 'terminal') return [] as CommandRun[];
    if (activeWindow.workerId) {
      const target = workers.find(
        (w) => w.id === activeWindow.workerId || w.hostId === activeWindow.workerId,
      );
      return target?.commandLog ?? [];
    }
    const merged: CommandRun[] = [];
    for (const w of workers) {
      for (const run of w.commandLog ?? []) merged.push(run);
    }
    merged.sort((a, b) => a.startedAt - b.startedAt);
    return merged;
  }, [activeWindow, workers]);

  // Terminal-mode workers get a live interactive pty instead of the replay.
  const terminalPtyWorker = useMemo(() => {
    if (activeWindow?.type !== 'terminal' || !activeWindow.workerId) return undefined;
    return workers.find(
      (w) => matchesWorker(w, activeWindow.workerId!) && isTerminalWorkerBackendId(w.backendId),
    );
  }, [activeWindow, workers]);

  // When the terminal worker's own delivery arrives, show it in the workbench
  // sidebar instead of letting the global DeliveryViewer cover the stage - the
  // TUI stays visible so the human can keep supervising.
  const terminalOwnsDelivery = Boolean(
    terminalPtyWorker && delivery?.workerId === terminalPtyWorker.id,
  );
  const manualTerminalActive = Boolean(activeWindow?.localCliId);
  const visibleFinalDelivery = manualTerminalActive ? null : finalMeetingDelivery;
  const stageDeliveryCovered = Boolean(delivery) && !terminalOwnsDelivery && !manualTerminalActive;

  const stageClass = share.active
    ? 'stage-sharing'
    : isActivityTab
      ? 'stage-default'
      : isBoardTab
        ? 'stage-default stage-board'
      : activeWindow?.type === 'browser'
        ? 'stage-browser'
        : activeWindow?.type === 'file'
          ? 'stage-file'
          : 'stage-default';

  return (
    <div className={`stage ${stageClass}${selectedTaskId ? ' has-task-inspector' : ''}`}>
      {share.active && (
        <>
          <video
            ref={videoRef}
            className="stage-video"
            autoPlay
            playsInline
            muted
          />
          <div className="stage-banner">
            <span className="stage-banner-dot" />
            Sharing your screen · {share.sourceName}
            <button className="stage-banner-stop" onClick={onStopShare}>Stop</button>
          </div>
        </>
      )}

      {share.error && !share.active && (
        <div className="stage-error-floating">{share.error}</div>
      )}

      {!share.active && (
        <>
          <div className="stage-gallery">
            {isValidElement(galleryContent)
              ? cloneElement(galleryContent, {
                  onSelectParticipant: handleSelectParticipant,
                  onOpenTerminal: openWorkerTerminal,
                } as any)
              : galleryContent}
          </div>

          {capacity.saturated && (
            <div className="stage-capacity-banner" role="status" aria-live="polite">
              <span>Worker 已满载（{capacity.active}/4）</span>
              <small>{capacity.waiting} 项任务正在等待执行名额；已运行任务不会被抢占。</small>
            </div>
          )}

          <StageTabBar
            windows={stageWindows}
            activeWindowId={activeWindowId}
            onSelect={onSelectWindow}
            onClose={onCloseWindow}
            onCreate={(type, opts) => onCreateWindow(type, { ...opts, cwd })}
            onPopOut={onPopOutWindow || onOpenNativeCli ? handlePopOut : undefined}
            canPopOut={(win) => !isPtyTerminalWindow(win)}
            popOutLabel={(win) => win.type === 'terminal' ? '在 CLI 工作区打开' : '在新窗口中打开'}
            badges={{ [BOARD_TAB_ID]: boardAttention }}
          />

          <div className="stage-content">
            {visibleFinalDelivery ? (
              <FinalMeetingDelivery
                delivery={visibleFinalDelivery}
                decision={finalMeetingDecision}
                onAccept={onAcceptFinalMeetingDelivery}
                onRequestRework={onRequestFinalMeetingRework}
              />
            ) : stageDeliveryCovered ? (
              <div className="stage-delivery-content">
                <DeliveryViewer
                  delivery={delivery!}
                  sessionId={sessionId}
                  aiSpeaking={aiSpeaking}
                  onAccept={onAcceptDelivery}
                  onRevise={onReviseDelivery}
                />
              </div>
            ) : isBoardTab ? (
              <div className="stage-board-content">{boardContent}</div>
            ) : isActivityTab && (
              <div className="stage-workspace-content">
              <MeetingNotesPanel cwd={cwd} />
              <ActivityTabContent
                workers={workers}
                hostGroups={hostGroups}
                plan={plan}
                coordinatorBriefings={coordinatorBriefings}
                running={running}
                aiSpeaking={aiSpeaking}
                onResolvePermission={onResolvePermission}
                selectedId={selectedParticipantId}
                onOpenInTerminal={openWorkerTerminal}
                customAvatars={customAvatars}
                sessionId={sessionId}
                onOpenTask={handleSelectTask}
              />
              </div>
            )}

            {!stageDeliveryCovered && !visibleFinalDelivery && activeWindow?.type === 'browser' && browserViewportRef && onBrowserOpenTab && onBrowserCloseTab && onBrowserSetActive && onBrowserNavigate && onBrowserBack && onBrowserForward && onBrowserReload && (
              <div className="stage-browser-content">
                <BrowserStage
                  tabs={browserTabs}
                  activeTabId={browserActiveTabId}
                  viewportRef={browserViewportRef}
                  onOpenTab={onBrowserOpenTab}
                  onCloseTab={onBrowserCloseTab}
                  onSetActive={onBrowserSetActive}
                  onNavigate={onBrowserNavigate}
                  onBack={onBrowserBack}
                  onForward={onBrowserForward}
                  onReload={onBrowserReload}
                />
              </div>
            )}

            {!stageDeliveryCovered && !visibleFinalDelivery && activeWindow?.type === 'terminal' && (
              <div className="stage-terminal-content">
                {activeWindow.localCliId ? (
                  <ShellTerminal key={activeWindow.id} terminalId={activeWindow.id}
                    shellId={activeWindow.shellId}
                    cliId={activeWindow.localCliId === 'shell' ? undefined : activeWindow.localCliId}
                    cwd={activeWindow.cwd} continueSession={activeWindow.continueSession}
                    initialPrompt={activeWindow.initialPrompt} />
                ) : terminalPtyWorker ? (
                  <WorkerWorkbench
                    key={terminalPtyWorker.id}
                    workerId={terminalPtyWorker.id}
                    sessionId={sessionId!}
                    onOpenInspector={handleOpenInspectorFromWorkbench}
                    onAcceptDelivery={onAcceptDelivery}
                    onReviseDelivery={onReviseDelivery}
                    subagent={activeWindow.subagentOwner ? {
                      ownerTitle: hostGroups.get(activeWindow.subagentOwner)?.profile?.title ?? '专家',
                      ownerName: hostGroups.get(activeWindow.subagentOwner)?.profile?.name ?? '',
                      taskTitle: ownedTasks?.get(terminalPtyWorker.id)?.title ?? terminalPtyWorker.title,
                    } : undefined}
                  />
                ) : (
                  <TerminalPanel commands={terminalCommands} />
                )}
              </div>
            )}

            {!stageDeliveryCovered && !visibleFinalDelivery && activeWindow?.type === 'file' && activeWindow.filePath && (
              <div className="stage-file-content">
                <FileViewer
                  relativePath={activeWindow.filePath}
                  sessionId={sessionId}
                  onClose={() => {
                    onCloseWindow(activeWindow.id);
                    onCloseFileView?.();
                  }}
                />
              </div>
            )}
          </div>

          {selectedTaskId && sessionId && (
            <div
              className={`task-inspector-dock${inspectorFullscreen ? ' is-task-inspector-fullscreen' : ''}`}
              style={{ '--task-inspector-height': `${inspectorHeight}dvh` } as React.CSSProperties}
            >
              <button
                type="button"
                className="task-inspector-drag-handle"
                onPointerDown={handleInspectorPointerDown}
                onPointerMove={handleInspectorPointerMove}
                onPointerUp={finishInspectorDrag}
                onPointerCancel={finishInspectorDrag}
                onClick={() => {
                  if (suppressInspectorClick.current) {
                    suppressInspectorClick.current = false;
                    return;
                  }
                  toggleInspectorFullscreen();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    toggleInspectorFullscreen();
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setInspectorHeight((current) => Math.min(100, current + 12));
                  } else if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setInspectorFullscreen(false);
                    setInspectorHeight((current) => Math.max(44, current - 12));
                  } else if (event.key === 'Home') {
                    event.preventDefault();
                    setInspectorFullscreen(true);
                    setInspectorHeight(100);
                  } else if (event.key === 'End') {
                    event.preventDefault();
                    setInspectorFullscreen(false);
                    setInspectorHeight(52);
                  }
                }}
                aria-label={inspectorFullscreen ? '收起任务检查器' : '展开任务检查器至全屏'}
                aria-valuemin={44}
                aria-valuemax={100}
                aria-valuenow={Math.round(inspectorHeight)}
              >
                <span aria-hidden />
              </button>
              <TaskInspector
                sessionId={sessionId}
                taskId={selectedTaskId}
                openSeq={inspectorOpenSeq}
                worker={selectedTaskWorker}
                onClose={() => setSelectedTaskId(null)}
                onResolvePermission={onResolvePermission}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
});
