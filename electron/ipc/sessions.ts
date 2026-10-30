// sessions:* IPC — tab/meeting lifecycle. The renderer drives:
//   sessions:open(cwd, greeting)   → spin up an Orchestrator, register slot
//   sessions:close(id)             → graceful end + drop slot
//   sessions:set-active(id)        → focus a tab (mic/TTS/screen follow)
//   sessions:list                  → current live slots (metadata only)
//   sessions:list-restore          → openTabs + lastActiveCwd from last quit
//
// cwd uniqueness is enforced inside SessionRegistry.open(): if the cwd already
// has a live slot, we return { ok:false, error:'duplicate', sessionId:<existing>}
// and the renderer is expected to switch to that tab instead of opening a new
// one. Lazy restore (renderer hydrates placeholder tabs without spawning
// Orchestrators until clicked) means listRestore returns metadata only.

import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../orchestrator.js';
import { mergedSubprocessEnv } from '../settings-loader.js';
import { formatError } from '../format-error.js';
import {
  getBackendAuth,
  getSettings,
  pushRecentCwd,
  setOpenTabs,
  forgetRestoredTab,
} from '../store.js';
import type { IpcContext } from './context.js';
import { clearApprovedExternalDirs } from './documents.js';
import { MeetingRepository } from '../meeting-repository.js';
import { getBackendRegistry } from '../backends/registry.js';
import { fetchPocketVibeRemoteSessions } from '../backends/pocket-vibe-adapter.js';
import { getPocketVibeConnection } from '../remote-control.js';
import { parsePocketVibeRemoteHosts, parsePocketVibeRemoteTarget, resolveRemoteTarget, type PocketVibeRemoteTarget } from '../backends/pocket-vibe-target.js';

interface OpenPayload {
  cwd?: unknown;
  greeting?: unknown;
  backendId?: unknown;
  recoveryMeetingId?: unknown;
  remoteHosts?: unknown;
}

// Coalesce rapid-fire `setOpenTabs` writes (lobby-restore can fire 5+
// snapshots in 50 ms when the user had several tabs open last quit).
// 100 ms is below human-perceptible latency but easily long enough to fold
// the burst into a single fs write. `before-quit` calls `flushOpenTabsNow`
// to make sure the final state always lands on disk.
const SNAPSHOT_DEBOUNCE_MS = 100;
/** Upper bound for graceful orchestrator teardown on sessions:close. Recap
 *  (a model call) or a stuck worker can stall end() indefinitely; the
 *  registry slot must still be freed — otherwise the cwd stays mapped to a
 *  zombie session and every later open degrades to 'duplicate'. */
const END_TIMEOUT_MS = 15_000;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let snapshotPendingCtx: IpcContext | null = null;
// Lazy references have no registry slot yet. Opening/closing one meeting must
// not erase the other projects (or their native remote references).
let retainedRestoreTabs = new Map<string, NonNullable<ReturnType<typeof getSettings>['openTabs']>[number]>();
let lastActiveReference: string | null = null;

function writeSnapshotNow(ctx: IpcContext): void {
  const live = ctx.registry.list().map((s) => ({
    cwd: s.cwd, openedAt: s.openedAt,
    remoteHosts: parsePocketVibeRemoteHosts(ctx.getOrchestrator(s.id)?.listHosts()),
  }));
  for (const tab of live) retainedRestoreTabs.set(tab.cwd, tab);
  const tabs = [...retainedRestoreTabs.values()].filter((tab) => !live.some((row) => row.cwd === tab.cwd)).concat(live);
  const active = ctx.registry.getActive();
  if (active) lastActiveReference = active.cwd;
  if (!tabs.some((tab) => tab.cwd === lastActiveReference)) lastActiveReference = tabs[0]?.cwd ?? null;
  void setOpenTabs(tabs, lastActiveReference).catch((err) => {
    console.error('[sessions] failed to persist openTabs:', err);
  });
}

function snapshotOpenTabs(ctx: IpcContext): void {
  snapshotPendingCtx = ctx;
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    const pending = snapshotPendingCtx;
    snapshotPendingCtx = null;
    if (pending) writeSnapshotNow(pending);
  }, SNAPSHOT_DEBOUNCE_MS);
}

/** Cancels the pending debounce timer (if any) and writes the latest registry
 *  snapshot synchronously-scheduled (still async on disk). Call sites that
 *  need "this state must hit disk before I return": `sessions:close`,
 *  `before-quit`. */
export function flushOpenTabsNow(ctx: IpcContext): void {
  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
  snapshotPendingCtx = null;
  writeSnapshotNow(ctx);
}

export function registerSessionsIpc(ctx: IpcContext): void {
  retainedRestoreTabs = new Map((getSettings().openTabs ?? []).map((tab) => [tab.cwd, tab]));
  lastActiveReference = getSettings().lastActiveCwd ?? null;
  ipcMain.handle('sessions:open', async (_e, payload: OpenPayload) => {
    try {
      const rawCwd = typeof payload?.cwd === 'string' ? payload.cwd : '';
      const greeting = typeof payload?.greeting === 'string' ? payload.greeting : undefined;
      const backendId = typeof payload?.backendId === 'string' ? payload.backendId : undefined;
      let selectedBackendId = backendId ?? getSettings().defaultBackend ?? 'claude-code';
      const recoveryMeetingId = typeof payload?.recoveryMeetingId === 'string'
        ? payload.recoveryMeetingId
        : undefined;
      const candidateCwd = rawCwd && rawCwd.length > 0 ? rawCwd : homedir();

      // S8: validate cwd before doing anything. A compromised renderer could
      // pass /etc or any path; verify it exists, is a directory, and is
      // readable by us. Resolve to absolute form so relative segments like
      // "../" don't slip through.
      const resolvedCwd = path.resolve(candidateCwd);
      try {
        const stat = await fs.stat(resolvedCwd);
        if (!stat.isDirectory()) {
          return { ok: false, error: `Invalid cwd: not a directory (${resolvedCwd})` };
        }
        await fs.access(resolvedCwd, fsConstants.R_OK);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Invalid cwd: ${msg}` };
      }

      let recovery: { meetingId: string; seq: number; state: Record<string, unknown> } | undefined;
      if (recoveryMeetingId) {
        if (!/^[a-zA-Z0-9-]{1,64}$/.test(recoveryMeetingId)) {
          return { ok: false, error: 'Invalid recovery meeting id' };
        }
        recovery = (await MeetingRepository.listRecoverable())
          .find((entry) => entry.meetingId === recoveryMeetingId);
        if (!recovery) return { ok: false, error: 'Recoverable meeting not found' };
        if (path.resolve(String(recovery.state.cwd ?? '')) !== resolvedCwd) {
          return { ok: false, error: 'Recovery workspace does not match the selected folder' };
        }
        const hosts = Array.isArray(recovery.state.hosts) ? recovery.state.hosts : [];
        const defaultHost = hosts.find((host) => (
          typeof host === 'object' && host !== null && (host as { id?: unknown }).id === 'default'
        )) as { backendId?: unknown } | undefined;
        if (typeof defaultHost?.backendId === 'string') selectedBackendId = defaultHost.backendId;
      }

      // cwd uniqueness — bail before constructing an Orchestrator.
      const existing = ctx.registry.findByCwd(resolvedCwd);
      if (existing) {
        ctx.registry.setActive(existing.id);
        snapshotOpenTabs(ctx);
        return { ok: false, error: 'duplicate', sessionId: existing.id, cwd: resolvedCwd };
      }

      const sessionId = randomUUID();
      const backendAuth = getBackendAuth(selectedBackendId);
      const probe = await getBackendRegistry().probe(selectedBackendId, backendAuth
        ? {
            authMode: backendAuth.authMode,
            apiKey: backendAuth.apiKey,
            baseUrl: backendAuth.baseUrl,
            model: backendAuth.model,
          }
        : { authMode: 'none' });
      if (!probe.capabilities.coordinate) {
        return { ok: false, error: `backend '${selectedBackendId}' cannot coordinate` };
      }
      if (!probe.installed) {
        return { ok: false, error: `backend '${selectedBackendId}' runtime is unavailable` };
      }
      if (probe.auth === 'required') {
        return { ok: false, error: `backend '${selectedBackendId}' authentication is required` };
      }
      // Workers run with the user's real HOME so the local claude CLI sees
      // its OAuth login state (~/.claude). The shadow tree still exists for
      // bundled skills, but is no longer injected as the subprocess HOME.
      const workerEnv = mergedSubprocessEnv();
      // The talker normally runs Haiku for latency; when the user points at a
      // custom gateway/model via ANTHROPIC_MODEL we honor it so the talker
      // doesn't request a model the gateway can't serve.
      const talkerModel = workerEnv.ANTHROPIC_MODEL || undefined;
      let remoteHosts = parsePocketVibeRemoteHosts(recovery
        ? recovery.state.hosts
        : payload?.remoteHosts ?? getSettings().openTabs?.find((tab) => tab.cwd === resolvedCwd)?.remoteHosts);
      if (remoteHosts.some((host) => !host.remoteTarget.device_id)) {
        const catalog = await fetchPocketVibeRemoteSessions(getPocketVibeConnection(), true);
        if (catalog.ok) remoteHosts = parsePocketVibeRemoteHosts(remoteHosts.map((host) => {
          try { return { ...host, remoteTarget: resolveRemoteTarget(host.remoteTarget, catalog.directory) }; }
          catch { return host; }
        }));
      }

      // Pre-bind sessionId into the emit closure so every event this
      // orchestrator emits is automatically routed to the right renderer slot.
      const orch = new Orchestrator({
        emit: (e) => ctx.emitToRenderer({ ...e, sessionId }),
        cwd: resolvedCwd,
        autoApproveScope: ctx.getAutoApprove(),
        workerEnv,
        talkerModel,
        confirmDestructive: ctx.nativeConfirmDestructive,
        browserTabManager: ctx.browserTabManager,
        getObservedSnapshot: ctx.getObservedSnapshot,
        defaultBackendId: selectedBackendId,
        meetingId: recovery?.meetingId,
        // PTY attach is a runtime IPC concern: renderer slots are keyed by
        // sessionId, while a recovered meeting keeps its older durable ID.
        ptyScopeId: sessionId,
        recoverySeq: recovery?.seq,
        resumeBackendSessions: recovery
          ? Object.fromEntries((Array.isArray(recovery.state.hosts) ? recovery.state.hosts : [])
              .filter((host): host is Record<string, unknown> => typeof host === 'object' && host !== null)
              .flatMap((host) => {
                const native = host.backendSession;
                return typeof host.id === 'string'
                  && typeof native === 'object' && native !== null
                  && typeof (native as Record<string, unknown>).sessionId === 'string'
                  && typeof (native as Record<string, unknown>).protocol === 'string'
                  ? [[host.id, native as import('../backends/cli-backend.js').BackendSessionSnapshot]]
                  : [];
              }))
          : undefined,
        remoteHosts,
        recoveredTasks: recovery && Array.isArray(recovery.state.tasks)
          ? recovery.state.tasks.filter((task): task is Record<string, unknown> => typeof task === 'object' && task !== null)
          : undefined,
        recoveredPlanVersion: recovery && typeof recovery.state.planVersion === 'number'
          ? recovery.state.planVersion
          : undefined,
        recoveredReviewSessions: recovery && Array.isArray(recovery.state.reviewSessions)
          ? recovery.state.reviewSessions.filter(
              (session): session is import('../coordinator-review.js').CoordinatorReviewSession => (
                Boolean(session && typeof session === 'object' && !Array.isArray(session))
              ),
            )
          : undefined,
        // Invited host groups ride along so start() can re-add them; the
        // resume handles above are keyed by the same host ids.
        recoveredHosts: recovery
          ? (Array.isArray(recovery.state.hosts) ? recovery.state.hosts : [])
              .filter((host): host is Record<string, unknown> => typeof host === 'object' && host !== null)
              .flatMap((host) => (
                typeof host.id === 'string' && typeof host.backendId === 'string'
                  ? [{ id: host.id, backendId: host.backendId }]
                  : []
              ))
          : undefined,
      });

      const result = ctx.registry.open(sessionId, resolvedCwd, orch);
      if (result.kind === 'duplicate') {
        // Race: another open landed between our findByCwd and open. Drop the
        // half-built orchestrator, focus the winner, return duplicate.
        try { orch.end(); } catch { /* ignore */ }
        ctx.registry.setActive(result.existingId);
        snapshotOpenTabs(ctx);
        return { ok: false, error: 'duplicate', sessionId: result.existingId, cwd: resolvedCwd };
      }

      // First slot becomes active automatically inside registry.open(). For
      // subsequent opens we explicitly hand focus to the new tab — matches
      // user expectation that "+ Open another folder" jumps to that tab.
      ctx.registry.setActive(sessionId);

      // Snapshot openTabs immediately so a crash before start completes
      // doesn't lose the tab record. The renderer is told the slot is
      // 'starting' and will gate input until the session-ready event lands.
      snapshotOpenTabs(ctx);

      // Fire-and-forget the SDK spawn. The renderer holds slot.status
      // 'starting' until session-ready/session-start-failed arrives.
      void (async () => {
        try {
          await orch.start(greeting);
          // Slot may have been closed by the user while we were starting —
          // bail without emitting if so (orch.end was already called).
          if (!ctx.registry.get(sessionId)) return;
          ctx.emitToRenderer({
            source: 'system',
            sessionId,
            event: { kind: 'session-ready' },
          });
          // Persist recent + open tab list only after a successful start.
          // Only real user picks land in recents (skip the homedir fallback
          // when the user typed nothing) — otherwise "I never picked
          // anything" becomes indistinguishable from "I last picked my home
          // folder".
          if (rawCwd && rawCwd.length > 0) {
            pushRecentCwd(resolvedCwd).catch((err) => {
              console.error('[settings] failed to persist recentCwds:', err);
            });
          }
          snapshotOpenTabs(ctx);
        } catch (err: unknown) {
          const msg = formatError(err);
          // If the slot was already closed (user bailed), don't bother
          // emitting failed — the renderer no longer has a tab to update.
          const stillOpen = !!ctx.registry.get(sessionId);
          ctx.registry.close(sessionId);
          try { orch.end(); } catch { /* ignore */ }
          if (stillOpen) {
            ctx.emitToRenderer({
              source: 'system',
              sessionId,
              event: { kind: 'session-start-failed', error: `start failed: ${msg}` },
            });
          }
          // Re-snapshot so openTabs no longer lists the dead slot.
          snapshotOpenTabs(ctx);
        }
      })();

      return {
        ok: true,
        sessionId,
        cwd: resolvedCwd,
        backendId: selectedBackendId,
        recovered: Boolean(recovery),
        status: 'starting' as const,
        remoteHosts: parsePocketVibeRemoteHosts(orch.listHosts()),
      };
    } catch (err: unknown) {
      const msg = formatError(err);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('sessions:close', async (_e, payload: { id?: string }) => {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const slot = ctx.registry.get(id);
    if (!slot) return { ok: false, error: 'not-found' };
    retainedRestoreTabs.delete(slot.cwd);
    let endTimedOut = false;
    let endTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        slot.orchestrator.end(),
        new Promise<void>((resolve) => {
          endTimer = setTimeout(() => { endTimedOut = true; resolve(); }, END_TIMEOUT_MS);
        }),
      ]);
    } catch { /* ignore */ } finally {
      if (endTimer) clearTimeout(endTimer);
    }
    if (endTimedOut) {
      // Teardown is still in flight (its cached endPromise will finish
      // whenever it finishes); the registry must not wait on it.
      console.warn(`[sessions] orchestrator.end() exceeded ${END_TIMEOUT_MS}ms for ${id}; freeing the registry slot anyway`);
    }
    clearApprovedExternalDirs(id);
    ctx.registry.close(id);
    // Close is the one path where "tab still on disk after close" would be a
    // real bug — tests that re-launch immediately rely on it. Flush rather
    // than debounce.
    flushOpenTabsNow(ctx);
    return { ok: true, activeId: ctx.registry.getActiveId() };
  });

  ipcMain.handle('sessions:set-active', async (_e, payload: { id?: string }) => {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const ok = ctx.registry.setActive(id);
    if (!ok) return { ok: false, error: 'not-found' };
    snapshotOpenTabs(ctx);
    return { ok: true };
  });

  ipcMain.handle('sessions:list', async () => {
    return {
      ok: true,
      sessions: ctx.registry.list(),
      activeId: ctx.registry.getActiveId(),
    };
  });

  ipcMain.handle('sessions:list-restore', async () => {
    const s = getSettings();
    return {
      ok: true,
      openTabs: Array.isArray(s.openTabs) ? s.openTabs : [],
      recentCwds: Array.isArray(s.recentCwds) ? s.recentCwds : [],
      lastActiveCwd: typeof s.lastActiveCwd === 'string' ? s.lastActiveCwd : null,
    };
  });

  ipcMain.handle('sessions:forget-restored', async (_e, payload: { cwd?: string }) => {
    if (typeof payload?.cwd !== 'string' || !path.isAbsolute(payload.cwd)) return { ok: false, error: 'invalid cwd' };
    const live = ctx.registry.findByCwd(payload.cwd);
    if (live) return { ok: false, error: 'meeting is already open', sessionId: live.id };
    retainedRestoreTabs.delete(payload.cwd);
    await forgetRestoredTab(payload.cwd);
    return { ok: true };
  });

  ipcMain.handle('sessions:list-recoverable', async () => ({
    ok: true,
    meetings: await MeetingRepository.listRecoverable(),
  }));

  ipcMain.handle('sessions:resolve-recovered-task', async (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'payload must be an object' };
    const { sessionId, taskId, action } = payload as Record<string, unknown>;
    if (typeof taskId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(taskId)) {
      return { ok: false, error: 'invalid task id' };
    }
    if (
      action !== 'continue-read-only'
      && action !== 'continue-side-effecting'
      && action !== 'retry-attempt'
      && action !== 'resolve-integration-conflict'
      && action !== 'abandon-task'
    ) {
      return { ok: false, error: 'invalid recovery action' };
    }
    const orch = ctx.getOrchestrator(typeof sessionId === 'string' ? sessionId : null);
    if (!orch) return { ok: false, error: 'session not found' };
    return orch.resolveRecoveredTask(taskId, action);
  });

  // ---- Multi-host management -----------------------------------------------

  /** Add a host group to an existing session. The session's Orchestrator
   *  creates a new HostGroup tied to the specified backend. */
  // Empty-project kickoff: the user's 开始 click is the stage confirmation (AME-D23).
  ipcMain.handle('sessions:kickoff', async (_e, payload: unknown) => {
    const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
    const mode = p.mode === 'develop' ? 'develop' : p.mode === 'brainstorm' ? 'brainstorm' : null;
    const title = typeof p.title === 'string' ? p.title.trim().slice(0, 20) : '';
    const name = typeof p.name === 'string' ? p.name.trim().slice(0, 20) : '';
    if (!mode || typeof p.expertBackendId !== 'string' || !title || !name) {
      return { ok: false, error: 'mode, expertBackendId, title and name are required' };
    }
    const orch = ctx.getOrchestrator(typeof p.sessionId === 'string' ? p.sessionId : undefined);
    if (!orch) return { ok: false, error: 'session not found' };
    return orch.startKickoff({ mode, expertBackendId: p.expertBackendId, profile: { title, name } });
  });

  ipcMain.handle('sessions:handback-task', async (_e, payload: unknown) => {
    const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
    if (typeof p.taskId !== 'string') return { ok: false, error: 'taskId is required' };
    const orch = ctx.getOrchestrator(typeof p.sessionId === 'string' ? p.sessionId : undefined);
    if (!orch) return { ok: false, error: 'session not found' };
    return orch.handBackTask(p.taskId, typeof p.note === 'string' ? p.note.slice(0, 2000) : undefined);
  });

  ipcMain.handle('sessions:restart-owned-task', async (_e, payload: unknown) => {
    const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
    if (typeof p.taskId !== 'string') return { ok: false, error: 'taskId is required' };
    const orch = ctx.getOrchestrator(typeof p.sessionId === 'string' ? p.sessionId : undefined);
    if (!orch) return { ok: false, error: 'session not found' };
    return orch.restartOwnedTask(p.taskId);
  });

  ipcMain.handle('sessions:meeting-notes', async (_e, payload: unknown) => {
    const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
    const orch = ctx.getOrchestrator(typeof sessionId === 'string' ? sessionId : undefined);
    if (!orch) return { ok: false, error: 'session not found' };
    return { ok: true, notes: orch.getMeetingNotes() };
  });

  ipcMain.handle('sessions:add-host', async (_e, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: 'payload must be an object' };
    }
    const { sessionId, backendId, hostId, remoteTarget } = payload as {
      sessionId?: string;
      backendId?: string;
      hostId?: string;
      remoteTarget?: PocketVibeRemoteTarget;
    };
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const orch = ctx.getOrchestrator(sessionId);
    if (!orch) return { ok: false, error: 'session not found' };
    let target = remoteTarget;
    if (remoteTarget !== undefined) {
      const parsed = parsePocketVibeRemoteTarget(remoteTarget);
      if (backendId !== 'pocket-vibe' || !parsed) return { ok: false, error: '无效的远端会话引用。' };
      const directory = await fetchPocketVibeRemoteSessions(getPocketVibeConnection(), true);
      if (!directory.ok) return directory;
      try { target = resolveRemoteTarget(parsed, directory.directory); }
      catch (error) { return { ok: false, error: String(error) }; }
      orch.enrichRemoteTargets(directory.directory);
    }
    const result = orch.addHost(backendId, hostId, target);
    if (result.ok && remoteTarget) snapshotOpenTabs(ctx);
    return result;
  });

  /** Remove a host group from a session. Cannot remove the default host. */
  ipcMain.handle('sessions:remove-host', async (_e, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: 'payload must be an object' };
    }
    const { sessionId, hostId } = payload as { sessionId?: string; hostId?: string };
    if (typeof hostId !== 'string') {
      return { ok: false, error: 'hostId must be a string' };
    }
    const orch = ctx.getOrchestrator(sessionId);
    if (!orch) return { ok: false, error: 'session not found' };
    const result = orch.removeHost(hostId);
    if (result.ok) snapshotOpenTabs(ctx);
    return result;
  });

  /** List all host groups in a session. */
  ipcMain.handle('sessions:list-hosts', async (_e, payload: unknown) => {
    const sessionId = typeof (payload as { sessionId?: string })?.sessionId === 'string'
      ? (payload as { sessionId: string }).sessionId
      : null;
    const orch = ctx.getOrchestrator(sessionId);
    if (!orch) return { ok: false, error: 'session not found' };
    return { ok: true, hosts: orch.listHosts() };
  });

  ipcMain.handle('sessions:remote-sessions', async (_e, payload: { refresh?: boolean } | undefined) => {
    const auth = getPocketVibeConnection();
    return fetchPocketVibeRemoteSessions(auth ?? { authMode: 'none' }, payload?.refresh === true);
  });

  ipcMain.handle('sessions:set-coordinator', async (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'payload must be an object' };
    const { sessionId, hostId } = payload as { sessionId?: unknown; hostId?: unknown };
    if (typeof hostId !== 'string' || hostId.length === 0) return { ok: false, error: 'hostId is required' };
    const orch = ctx.getOrchestrator(typeof sessionId === 'string' ? sessionId : null);
    if (!orch) return { ok: false, error: 'session not found' };
    return orch.setCoordinator(hostId);
  });

  ipcMain.handle('sessions:restart-host', async (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'payload must be an object' };
    const { sessionId, hostId } = payload as { sessionId?: unknown; hostId?: unknown };
    if (typeof hostId !== 'string' || !hostId) return { ok: false, error: 'hostId is required' };
    const orch = ctx.getOrchestrator(typeof sessionId === 'string' ? sessionId : null);
    if (!orch) return { ok: false, error: 'session not found' };
    return orch.restartHost(hostId);
  });
}
