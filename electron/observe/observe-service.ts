// Consent-gated, read-only Claude/Codex session discovery. Full snapshots are
// volatile: native client files and the IF-2 registry are never modified.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { canReadProject, withinDirectory, NO_SCAN_ACCESS, type ScanAccess } from './scan-access.js';
import { readOwnership, ownershipKey, type OwnershipIndex } from './ownership.js';
import { clientRoots, readSessionIdentity } from './session-identity.js';
import { readStudioHistory } from './studio-history.js';
import { projectObservation } from './observation-projection.js';
import { correlate } from './correlate.js';
import { associate, extractSessionIdFromCommand, associationKey, detectMcpServerPids,
  loadClaudePidFiles, mcpHeldRolloutPaths, type Association, type ClaudePidFileEntry } from './mapping.js';
import { captureProcessSnapshot, findClientPids, lsofOpenFiles, type ProcessSnapshot } from './process/darwin.js';
import { listClaudeTranscripts, parseClaudeTranscript } from './statefiles/claude-projects.js';
import { listCodexRollouts, parseCodexRollout } from './statefiles/codex-sessions.js';
import type { ClientKind, CodexDesktopTailSignals, CodexTailSignals, ObservedFileSignal,
  ObservedSession, ObservedSnapshot, SelfExclusion } from './types.js';
import { defaultExec, type ExecImpl } from './util.js';

export interface ObserveServiceOptions {
  homeDir: string;
  userData?: string;
  getAccess?: () => ScanAccess;
  configRoots?: ReturnType<typeof clientRoots>;
  /** Trusted local IF-1 full snapshot, when the host producer is available. */
  getHookSnapshot?: () => unknown;
  publish: (snapshot: ObservedSnapshot) => void;
  getSelfExclusion?: () => SelfExclusion;
  fastMs?: number;
  slowMs?: number;
  now?: () => number;
  execImpl?: ExecImpl;
  snapshotProvider?: () => Promise<ProcessSnapshot>;
  realpathImpl?: (path: string) => Promise<string>;
}
interface FileMarker { mtimeMs: number; sizeBytes: number; signal: ObservedFileSignal | null }

/** Merge CLI rollout signals with Codex Desktop thread signals, keeping one
 * row per thread id. The same id can exist in both worlds — the desktop app
 * resumes CLI sessions — and two rows would duplicate a board card (and its
 * React key). Colliding ids merge into ONE `codex-merged` signal carrying
 * both sides whole: liveness is only known per-tick in correlate, so the
 * merge never picks a winner. (The old fresher-side-wins rule dropped the
 * stale CLI row AND the live desktop row's host pid with it, hiding open
 * desktop windows whenever the rollout file happened to be newer.)
 * Top-level identity fields stay on the CLI rollout's per-thread evidence:
 * fd→rollout association and MCP ghost suppression key on the rollout path,
 * and the desktop cwd can be an app-wide workspace-root fallback. Display
 * fields (title/titleSource) seed from the fresher side — correlate re-picks
 * them per-tick and only falls back to this recency choice when neither
 * side is live. Desktop-side recency uses chat-process updates only: the
 * global-state mtime is app-wide, not per-thread. */
export function mergeCodexDesktopSignals(
  codexSignals: ObservedFileSignal[],
  desktopSignals: ObservedFileSignal[],
): ObservedFileSignal[] {
  const desktopById = new Map<string, ObservedFileSignal>();
  const passthrough: ObservedFileSignal[] = [];
  for (const signal of desktopSignals) {
    if (signal.tailSignals.kind === 'codex-desktop') {
      desktopById.set(signal.nativeSessionId, signal);
    } else {
      passthrough.push(signal);
    }
  }
  const merged: ObservedFileSignal[] = [];
  for (const cli of codexSignals) {
    const desktop = desktopById.get(cli.nativeSessionId);
    if (!desktop) {
      merged.push(cli);
      continue;
    }
    desktopById.delete(cli.nativeSessionId);
    merged.push(mergeCollidingSignals(cli, desktop));
  }
  return [...merged, ...desktopById.values(), ...passthrough];
}

/** One row for a CLI↔desktop collision: both tails kept whole under
 * `codex-merged` so correlate can run the live side's rules per tick. */
function mergeCollidingSignals(
  cli: ObservedFileSignal,
  desktop: ObservedFileSignal,
): ObservedFileSignal {
  // Callers only pass kind-checked signals (codex rollout ⨯ codex-desktop).
  const cliTail = cli.tailSignals as CodexTailSignals;
  const desktopTail = desktop.tailSignals as CodexDesktopTailSignals;
  const desktopFresher = desktopTail.lastChatUpdateAtMs > cli.mtimeMs;
  const display = desktopFresher ? desktop : cli;
  const secondary = desktopFresher ? cli : desktop;
  return {
    clientKind: 'codex',
    nativeSessionId: cli.nativeSessionId,
    cwd: cli.cwd,
    filePath: cli.filePath,
    mtimeMs: Math.max(cli.mtimeMs, desktop.mtimeMs),
    sizeBytes: cli.sizeBytes + desktop.sizeBytes,
    title: display.title ?? secondary.title,
    titleSource: display.title ? display.titleSource : secondary.titleSource,
    model: cli.model ?? desktop.model,
    tailSignals: {
      kind: 'codex-merged',
      desktop: {
        ...desktopTail,
        title: desktop.title,
        titleSource: desktop.titleSource,
        filePath: desktop.filePath,
        mtimeMs: desktop.mtimeMs,
      },
      cli: {
        ...cliTail,
        title: cli.title,
        titleSource: cli.titleSource,
        filePath: cli.filePath,
        mtimeMs: cli.mtimeMs,
      },
    },
  };
}

export class ObserveService {
  private readonly options: ObserveServiceOptions;
  private readonly getAccess: () => ScanAccess;
  private readonly roots: ReturnType<typeof clientRoots>;
  private readonly now: () => number;
  private readonly execImpl: ExecImpl;
  private readonly realpathImpl: (path: string) => Promise<string>;
  private readonly markers = {
    'claude-code': new Map<string, FileMarker>(),
    codex: new Map<string, FileMarker>(),
  };
  private pidFileMap = new Map<number, ClaudePidFileEntry>();
  private lastPidRefresh = Number.NEGATIVE_INFINITY;
  private generation = 0;
  private running = false;
  private ticking = false;
  private timer: NodeJS.Timeout | null = null;
  private lastSessions: ObservedSession[] = [];

  constructor(options: ObserveServiceOptions) {
    this.options = options;
    this.getAccess = options.getAccess ?? (() => NO_SCAN_ACCESS);
    this.roots = options.configRoots ?? clientRoots(options.homeDir);
    this.now = options.now ?? Date.now;
    this.execImpl = options.execImpl ?? defaultExec;
    this.realpathImpl = options.realpathImpl ?? ((path) => fs.realpath(path));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  /** Invalidate in-flight reads as well as cached/visible content. */
  invalidate(): void {
    this.generation++;
    this.markers['claude-code'].clear(); this.markers.codex.clear();
    this.pidFileMap.clear(); this.lastPidRefresh = Number.NEGATIVE_INFINITY;
    this.lastSessions = [];
    this.options.publish({ sessions: [], scannedAt: this.now(), access: this.getAccess(), studioTasks: [] });
  }
  get sessions(): ObservedSession[] { return this.lastSessions; }

  private async loop(): Promise<void> {
    while (this.running) {
      try { await this.tickOnce(); } catch { /* Retry on the next tick. */ }
      if (!this.running) return;
      const active = this.lastSessions.some((s) => s.state === 'active');
      const delay = active ? this.options.fastMs ?? 2_000 : this.options.slowMs ?? 10_000;
      await new Promise<void>((resolve) => { this.timer = setTimeout(resolve, delay); });
    }
  }

  async tickOnce(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const access = this.getAccess();
      const generation = this.generation;
      const accessToken = JSON.stringify(access);
      const current = () => generation === this.generation && JSON.stringify(this.getAccess()) === accessToken;
      if (!access.enabled || !access.roots.length) {
        this.invalidate();
        return;
      }
      const now = this.now();
      const ownership: OwnershipIndex = this.options.userData
        ? await readOwnership(join(this.options.userData, 'sessions', 'owned.json'))
        : { available: true, pending: false, origins: new Map() };
      const history = this.options.userData
        ? await readStudioHistory(this.options.userData, access, this.realpathImpl)
        : { tasks: [], internalIds: new Set<string>() };
      const injected = this.options.getSelfExclusion?.() ?? { pids: new Set<number>(), sessionIds: new Set<string>() };
      const self: SelfExclusion = { pids: new Set(injected.pids), sessionIds: new Set([...injected.sessionIds, ...history.internalIds]) };
      if (!current()) return;

      let snapshot: ProcessSnapshot;
      try { snapshot = await (this.options.snapshotProvider?.() ?? captureProcessSnapshot(this.execImpl)); }
      catch { snapshot = { byPid: new Map(), childrenOf: new Map(), capturedAt: now }; }
      const frontier = [...self.pids];
      for (let i = 0; i < frontier.length; i++) {
        for (const child of snapshot.childrenOf.get(frontier[i]) ?? []) {
          if (!self.pids.has(child)) { self.pids.add(child); frontier.push(child); }
        }
      }
      for (const pid of self.pids) {
        const command = snapshot.byPid.get(pid)?.command;
        const id = command ? extractSessionIdFromCommand(command) : null;
        if (id) self.sessionIds.add(id);
      }
      // PID files contain routing metadata, not global prompts/titles.
      if (now - this.lastPidRefresh >= (this.options.slowMs ?? 10_000)) {
        this.pidFileMap = await loadClaudePidFiles(this.options.homeDir, this.roots.claude);
        this.lastPidRefresh = now;
      }
      const signals = [
        ...await this.scanObserver('claude-code', access, ownership, self.sessionIds, current),
        ...await this.scanObserver('codex', access, ownership, self.sessionIds, current),
      ];
      if (!current()) return;
      const claudePids = findClientPids(snapshot, ['claude']);
      const codexPids = findClientPids(snapshot, ['codex']);
      const mcpPids = detectMcpServerPids(snapshot);
      const lsofPids = [...new Set([...claudePids, ...codexPids, ...mcpPids])].filter((pid) => !self.pids.has(pid));
      const lsofByPid = process.platform === 'win32' ? new Map() : await lsofOpenFiles(lsofPids, this.execImpl);
      const realpathOf = await this.buildRealpathResolver(signals, lsofByPid);
      const associations = new Map<string, Association>();
      const clients: Array<{ kind: ClientKind; pids: number[] }> = [
        { kind: 'claude-code', pids: claudePids }, { kind: 'codex', pids: codexPids },
      ];
      for (const client of clients) {
        for (const [id, association] of associate({ clientKind: client.kind, pids: client.pids,
          signals: signals.filter((s) => s.clientKind === client.kind), snapshot, lsofByPid,
          pidFileMap: client.kind === 'claude-code' ? this.pidFileMap : undefined,
          realpathOf, selfExclusion: self })) {
          associations.set(associationKey(client.kind, id), association);
        }
      }
      const sessions = correlate({ signals, associations, snapshot, realpathOf, now,
        selfSessionIds: self.sessionIds, suppressedPaths: mcpHeldRolloutPaths(lsofByPid, mcpPids) });
      let hookSnapshot: unknown = null;
      try { hookSnapshot = this.options.getHookSnapshot?.() ?? null; }
      catch { hookSnapshot = {}; } // An unavailable configured producer cannot assert a state.
      const next: ObservedSession[] = [];
      const seen = new Set<string>();
      for (const session of sessions) {
        if (!current()) return;
        if (!await canReadProject(session.cwd, access, this.realpathImpl)) continue;
        const agent = session.clientKind === 'claude-code' ? 'claude' : 'codex';
        const origin = ownership.origins.get(ownershipKey(agent, session.nativeSessionId));
        if (origin === 'worker' || origin === 'station') continue;
        const unresolved = !ownership.available || (!origin && ownership.pending);
        session.origin = origin ?? (unresolved ? 'unknown' : 'user');
        session.ownership = unresolved ? 'unresolved' : origin ? 'owned' : 'unowned';
        if (unresolved) { session.state = 'unknown'; session.activity = 'unknown'; }
        const projected = projectObservation(session, hookSnapshot);
        if (projected.origin === 'worker' || projected.origin === 'station' || seen.has(projected.id)) continue;
        seen.add(projected.id); next.push(projected);
      }
      // Directory grants and revocation are checked again after every async read.
      if (!current()) return;
      if (this.options.userData) {
        const latest = await readOwnership(join(this.options.userData, 'sessions', 'owned.json'));
        if (!current()) return;
        if (latest.token !== ownership.token || latest.available !== ownership.available) {
          this.invalidate(); // A concurrent launch/binding must not briefly become a user row.
          return;
        }
      }
      this.lastSessions = next;
      this.options.publish({ sessions: next, scannedAt: this.now(), access, studioTasks: history.tasks,
        diagnostics: ownership.available ? [] : ['ownership-unavailable'] });
    } finally { this.ticking = false; }
  }

  private async scanObserver(kind: 'claude-code' | 'codex', access: ScanAccess,
    ownership: OwnershipIndex, selfIds: Set<string>, current: () => boolean): Promise<ObservedFileSignal[]> {
    const markers = this.markers[kind];
    try {
      const config = kind === 'claude-code' ? this.roots.claude : this.roots.codex;
      const root = await fs.realpath(config);
      const refs = kind === 'claude-code'
        ? await listClaudeTranscripts(this.options.homeDir, 500, config)
        : await listCodexRollouts(this.options.homeDir, 500, config);
      const signals: ObservedFileSignal[] = [];
      for (const ref of refs) {
        if (!current()) return [];
        try {
          if (!withinDirectory(root, await fs.realpath(ref.filePath))) continue;
          const identity = await readSessionIdentity(ref.filePath, kind);
          if (!identity || selfIds.has(identity.sessionId)
            || !await canReadProject(identity.cwd, access, this.realpathImpl) || !current()) {
            markers.delete(ref.filePath); continue;
          }
          const origin = ownership.origins.get(ownershipKey(kind === 'claude-code' ? 'claude' : 'codex', identity.sessionId));
          if (origin === 'worker' || origin === 'station') { markers.delete(ref.filePath); continue; }
          if (!ownership.available || (!origin && ownership.pending)) {
            // Do not read internal messages while launch/ownership is unresolved.
            markers.delete(ref.filePath);
            signals.push({ ...ref, clientKind: kind, nativeSessionId: identity.sessionId, cwd: identity.cwd,
              tailSignals: kind === 'claude-code'
                ? { kind: 'claude', trailingRealUser: false, unclosedToolUse: false, messagesSeen: 0 }
                : { kind: 'codex', generating: false, pendingFunctionCalls: 0, sawTaskComplete: false, isExec: false, turnCount: 0 } });
            continue;
          }
          const cached = markers.get(ref.filePath);
          const signal = cached && cached.mtimeMs === ref.mtimeMs && cached.sizeBytes === ref.sizeBytes
            ? cached.signal : kind === 'claude-code' ? await parseClaudeTranscript(ref) : await parseCodexRollout(ref, new Map());
          if (!current()) return [];
          markers.set(ref.filePath, { mtimeMs: ref.mtimeMs, sizeBytes: ref.sizeBytes, signal });
          if (signal?.nativeSessionId === identity.sessionId && signal.cwd === identity.cwd) signals.push(signal);
        } catch { markers.delete(ref.filePath); }
      }
      const scanned = new Set(refs.map((ref) => ref.filePath));
      for (const key of markers.keys()) if (!scanned.has(key)) markers.delete(key);
      return signals;
    } catch { markers.clear(); return []; }
  }

  private async buildRealpathResolver(signals: ObservedFileSignal[], lsofByPid: Map<number, { cwd?: string }>) {
    // Resolve afresh per scan: a changed mount/symlink must not reuse old access.
    const paths = new Set(signals.map((s) => s.cwd));
    for (const entry of lsofByPid.values()) if (entry.cwd) paths.add(entry.cwd);
    const resolved = new Map<string, string>();
    for (const path of paths) {
      try { resolved.set(path, await this.realpathImpl(path)); }
      catch { resolved.set(path, path); }
    }
    return (path: string) => resolved.get(path) ?? path;
  }
}
