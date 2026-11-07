// observed-store.ts — renderer mirror of the S0 observation layer.
//
// Pure in-memory, volatile store (a restart re-scans anyway — nothing to
// persist). Mirrors meeting-store's useSyncExternalStore pattern: a class
// with subscribe/getSnapshot, fed by window.vibeMeet.observe.onEvent and
// seeded once via getSnapshot(). Types are a hand-kept mirror of
// electron/observe/types.ts — the renderer never imports from electron/
// (the two tsconfigs don't share sources).

export type ObservedClientKind = 'claude-code' | 'codex' | 'kimi';
export type ObservedState = 'active' | 'waiting' | 'idle' | 'done' | 'unknown';
export type ObservedActivity = 'thinking' | 'executing' | 'waiting' | 'unknown';
export type ObservedTitleSource =
  | 'global-state'
  | 'session-index'
  | 'first-prompt'
  | 'summary'
  | 'project-fallback';

export interface ObservedSession {
  /** sha1(clientKind + nativeSessionId), independent of project relocation. */
  id: string;
  clientKind: ObservedClientKind;
  nativeSessionId: string;
  /** sha1(realpath(cwd)) — matches the orchestration project grouping. */
  projectId: string;
  projectName: string;
  cwd: string;
  title: string;
  state: ObservedState;
  activity: ObservedActivity;
  /** False when projected from a validated local IF-1 host snapshot. */
  inferred: boolean;
  origin?: 'worker' | 'station' | 'user-adopted' | 'user' | 'unknown';
  ownership?: 'owned' | 'unowned' | 'unresolved';
  phase?: string;
  connection?: string;
  model?: string;
  lastActiveAt: number;
  pid?: number;
  titleSource: ObservedTitleSource;
  isNoise: boolean;
  evidence: string[];
}

export interface ObservedSnapshot {
  sessions: ObservedSession[];
  scannedAt: number;
  access?: { enabled: boolean; roots: string[] };
  studioTasks?: Array<{ meetingId: string; taskId: string; cwd: string; title: string; status: string }>;
  diagnostics?: string[];
}

/** Preload surface for the observation layer. Optional on VibeMeetApi so a
 *  renderer running against an older preload degrades to "nothing observed". */
export interface ObserveApi {
  getSnapshot: () => Promise<ObservedSnapshot>;
  onEvent: (cb: (snapshot: ObservedSnapshot) => void) => () => void;
  allowDirectory?: () => Promise<{ ok: boolean; canceled?: boolean; error?: string }>;
  disable?: () => Promise<{ ok: boolean; error?: string }>;
}

type Listener = () => void;

/** Sticky empty snapshot — stable reference so useSyncExternalStore doesn't
 *  fire spurious renders before the first scan lands. */
const EMPTY_SNAPSHOT: ObservedSnapshot = { sessions: [], scannedAt: 0 };

class ObservedStore {
  private listeners = new Set<Listener>();
  private snapshot: ObservedSnapshot = EMPTY_SNAPSHOT;
  private subscribed = false;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    this.ensureSubscribed();
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): ObservedSnapshot => this.snapshot;

  private ensureSubscribed(): void {
    if (this.subscribed) return;
    const api = window.vibeMeet?.observe;
    // Older preload without the observe namespace → board shows nothing
    // observed; no crash, no retry (a reload picks up a newer preload).
    if (!api) return;
    this.subscribed = true;
    let receivedEvent = false;
    api.onEvent((snapshot) => {
      if (!snapshot || !Array.isArray(snapshot.sessions)) return;
      receivedEvent = true;
      this.snapshot = snapshot;
      this.notify();
    });
    // Seed from the latest scan — observe:event only fires on scan ticks, so
    // a board opened between ticks would otherwise sit empty for up to 10s.
    void api.getSnapshot()
      .then((snapshot) => {
        if (receivedEvent || !snapshot || !Array.isArray(snapshot.sessions)) return;
        this.snapshot = snapshot;
        this.notify();
      })
      .catch(() => { /* observer not ready — the next event will land */ });
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const observedStore = new ObservedStore();
