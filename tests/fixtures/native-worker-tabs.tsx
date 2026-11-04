// Offline renderer smoke: no CLI, model, credentials, or production IPC.
import React, { useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { ScreenStage } from '../../src/components/ScreenStage';
import { stageWindowStore } from '../../src/lib/stage-window-store';
import { meetingStore, type WorkerState } from '../../src/lib/meeting-store';
import '../../src/styles.css';

const dataListeners = new Set<(event: { workerId: string; data: string }) => void>();
const exitListeners = new Set<(event: { workerId: string }) => void>();
const replay = new Map<string, string>();
const attached: string[] = [];
let manualStarts = 0;
Object.assign(window, { vibeMeet: {
  onEvent: () => () => {},
  browser: { setVisible: async () => {} },
  shellPty: { create: async () => { manualStarts++; throw new Error('must not launch a second CLI'); } },
  tasks: { getSnapshot: async () => ({ ok: false, error: 'isolated fixture' }) },
  workerPty: {
    attach: async (id: string) => { attached.push(id); return { ok: true, replay: btoa(replay.get(id) ?? '') }; },
    detach: async () => ({ ok: true }), resize: async () => ({ ok: true }),
    takeoverStatus: async () => ({ ok: true, takenOver: false }),
    onData: (fn: (event: { workerId: string; data: string }) => void) => { dataListeners.add(fn); return () => dataListeners.delete(fn); },
    onExit: (fn: (event: { workerId: string }) => void) => { exitListeners.add(fn); return () => exitListeners.delete(fn); },
  },
} });

function Fixture() {
  const [workers, setWorkers] = useState<WorkerState[]>([]);
  const state = useSyncExternalStore(stageWindowStore.subscribe, stageWindowStore.getSnapshot);
  const snapshot = { ...meetingStore.getSnapshot(), workers: new Map(workers.map(w => [w.id, w])) };
  // The real Workbench reads the meeting projection; supply the same fixture workers.
  meetingStore.getSnapshot = () => snapshot;
  Object.assign(window, { workerTabsFixture: {
    spawn(id: string, title: string, status = 'running') {
      replay.set(id, `Codex task ${id}\r\n$ inspect project\r\ninitial output ${id}\r\n`);
      setWorkers(previous => [...previous.filter(w => w.id !== id), {
        id, title, role: 'worker', backendId: 'codex-terminal', status,
        hostId: 'default', startedAt: 100, endedAt: null, deps: [],
        transcript: [], activity: [], commandLog: [], pendingPermission: null,
        resolvingPermissionId: null, permissionError: null, currentTool: null,
        currentToolInput: null, lastText: '', responding: false, summary: '',
        specialty: 'general', taskHistory: [],
      } as WorkerState]);
    },
    output(id: string, text: string) {
      replay.set(id, (replay.get(id) ?? '') + text);
      for (const fn of dataListeners) fn({ workerId: id, data: btoa(text) });
    },
    finish(id: string) {
      setWorkers(previous => previous.map(w => w.id === id ? { ...w, status: 'accepted' } : w));
      for (const fn of exitListeners) fn({ workerId: id });
    },
    reopen: (id: string) => stageWindowStore.createWindow('terminal', { workerId: id }),
    ledger: () => ({ attached, manualStarts, windows: stageWindowStore.getSnapshot().windows }),
  } });
  const ok = async () => ({ ok: true as const });
  return <div style={{ height: '100vh', display: 'flex' }}><ScreenStage
    share={{ active: false } as never} videoRef={{ current: null }} onPickSource={() => {}} onStopShare={() => {}}
    workers={workers} hostGroups={new Map()} plan={null} coordinatorBriefings={[]}
    running={false} aiSpeaking={false} galleryContent={<div>Offline Worker task fixture</div>}
    delivery={null} finalMeetingDelivery={null} finalMeetingDecision={null} sessionId="fixture-meeting"
    onAcceptDelivery={ok} onReviseDelivery={async () => ({ ok: true, route: 'worker' })}
    onAcceptFinalMeetingDelivery={ok} onRequestFinalMeetingRework={ok} onResolvePermission={ok}
    stageWindows={state.windows} activeWindowId={state.activeWindowId}
    onSelectWindow={id => { void stageWindowStore.setActiveWindow(id); }}
    onCloseWindow={id => { void stageWindowStore.closeWindow(id); }}
    onCreateWindow={(type, opts) => { void stageWindowStore.createWindow(type, opts); }}
    boardContent={<div>Task board</div>} />
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
