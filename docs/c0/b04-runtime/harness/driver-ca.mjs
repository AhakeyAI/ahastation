// C-A driver: the existing AhaStation adapters (dist-electron), driven the
// same way the orchestrator builds a worker session (orchestrator.ts:489-570).
// Run from the repo root with the electron stub loader (see run.mjs).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { B04_DIR, brokerDecide } from './common.mjs';

// B04_DIST selects an alternative build (C-A′: Codex pin bumped, experimental).
const DIST = process.env.B04_DIST ?? join(B04_DIR, '..', '..', '..', 'dist-electron');
const { getBackendRegistry } = await import(pathToFileURL(join(DIST, 'backends', 'registry.js')).href);
const { CodexBackend } = await import(pathToFileURL(join(DIST, 'backends', 'codex-adapter.js')).href);
const { CodexAppServerTransport } = await import(pathToFileURL(join(DIST, 'backends', 'codex-app-server-transport.js')).href);
const { ClaudeCodeBackend } = await import(pathToFileURL(join(DIST, 'backends', 'claude-code-adapter.js')).href);
const { query: claudeQuery } = await import(pathToFileURL(join(DIST, 'claude-cli', 'driver.js')).href);
const codexProtocolUsage = [];
const claudeProtocolUsage = [];

function observedClaudeQuery(args) {
  const query = claudeQuery(args);
  return {
    initializationResult: () => query.initializationResult(),
    interrupt: () => query.interrupt(),
    setPermissionMode: (mode) => query.setPermissionMode(mode),
    close: () => query.close(),
    [Symbol.asyncIterator]() {
      const iterator = query[Symbol.asyncIterator]();
      return {
        async next() {
          const result = await iterator.next();
          const message = result.value;
          if (message?.type === 'result' || message?.type === 'rate_limit_event') {
            const { type, usage, modelUsage, total_cost_usd, rate_limit_info } = message;
            claudeProtocolUsage.push({ type, usage, modelUsage, total_cost_usd, rate_limit_info, fields: Object.keys(message).sort() });
          }
          return result;
        },
        return: () => iterator.return?.() ?? Promise.resolve({ value: undefined, done: true }),
      };
    },
  };
}

// B04_CODEX_BIN points the existing adapter at a different Codex binary
// (e.g. the global 0.156.1) to test protocol compatibility with a newer CLI.
function backendFor(provider) {
  if (provider === 'codex' && process.env.B04_CODEX_BIN) {
    return new CodexBackend({
      resolveBinary: () => process.env.B04_CODEX_BIN,
      createAppServerTransport: (options) => new CodexAppServerTransport({
        ...options,
        onNotification: (notification) => {
          if (/tokenUsage|rateLimits/i.test(notification.method)) {
            codexProtocolUsage.push(notification);
          }
          options.onNotification?.(notification);
        },
      }),
    });
  }
  if (provider === 'claude-code') return new ClaudeCodeBackend({ queryFactory: observedClaudeQuery });
  return getBackendRegistry().get(provider);
}

export const candidate = 'C-A';

export function versions(provider) {
  const model = provider === 'codex' ? process.env.B04_CODEX_MODEL : process.env.B04_CLAUDE_MODEL;
  return provider === 'codex'
    ? { app: process.env.B04_APP_VERSION ?? 'fix/runtime-a14-a20 4fce212', codex: process.env.B04_CODEX_VERSION ?? '0.156.1', model: model ?? 'account-default' }
    : { app: process.env.B04_APP_VERSION ?? 'fix/runtime-a14-a20 4fce212', claudeAgentSdk: '0.3.150 (bundled claude.exe)', model: model ?? 'account-default' };
}

/**
 * Start a worker run. `policy(req)` decides permissions; default = grant broker.
 * Returns a handle with an event log and control methods.
 */
export async function start({ provider, ws, task, policy, resumeSessionId, role = 'worker' }) {
  const backend = backendFor(provider);
  if (!backend) throw new Error(`backend ${provider} not registered`);
  const env = backend.buildEnv({ authMode: 'none' }, { HOME: homedir(), USERPROFILE: homedir() });
  const events = [];
  const t0 = Date.now();
  const handle = { backend, events, t0, session: null, permissions: [], ended: null, protocolUsage: provider === 'codex' ? codexProtocolUsage : claudeProtocolUsage };
  const decide = policy ?? ((req) => brokerDecide(ws, req));
  const emit = (e) => {
    const at = Date.now() - t0;
    events.push({ at, ...summarize(e) });
    if (e.kind === 'message' && (e.message?.type === 'result' || e.message?.type === 'rate_limit_event')) {
      const { type, usage, modelUsage, total_cost_usd, rate_limit_info } = e.message;
      handle.protocolUsage.push({ type, usage, modelUsage, total_cost_usd, rate_limit_info, fields: Object.keys(e.message).sort() });
    }
    if (e.kind === 'worker-signal' && e.signal.kind === 'tool' && e.signal.phase === 'started') {
      handle.lastToolDetail = e.signal.detail ?? '';
    }
    if (e.kind === 'permission-request') {
      // Codex fileChange approvals carry no path ({reason, grantRoot} only);
      // the path is on the tool event that precedes the request. Correlate.
      const verdict = decide({ toolName: e.toolName, input: e.input, toolDetail: handle.lastToolDetail });
      handle.permissions.push({ at, toolName: e.toolName, input: e.input, toolDetail: handle.lastToolDetail, ...verdict });
      handle.session?.resolvePermission(e.id, verdict.allow ? 'allow' : 'deny', verdict.allow ? undefined : verdict.why);
    }
    if (e.kind === 'worker-signal' && e.signal.kind === 'ended') handle.ended = { at, reason: e.signal.reason };
    // A failed turn is terminal for the harness even when no `ended` follows
    // (observed: Codex app-server model errors emit only `failed`).
    if (e.kind === 'worker-signal' && e.signal.kind === 'failed' && !handle.ended) {
      handle.failedAt = at;
      setTimeout(() => { if (!handle.ended) handle.ended = { at: Date.now() - t0, reason: 'failed-without-ended' }; }, 3000);
    }
    if (e.kind === 'ended' && !handle.ended) handle.ended = { at, reason: 'session-ended' };
  };
  handle.session = backend.createSession({
    cwd: ws,
    env,
    executionRole: role,
    autoApproveScope: 'off',
    // The repaired adapters must use the account default unless a probe
    // explicitly supplies a model override.
    ...((provider === 'codex' ? process.env.B04_CODEX_MODEL : process.env.B04_CLAUDE_MODEL)
      ? { model: provider === 'codex' ? process.env.B04_CODEX_MODEL : process.env.B04_CLAUDE_MODEL }
      : {}),
    extra: provider === 'codex' ? { codexTransport: 'app-server' } : {},
    ...(resumeSessionId ? { resumeSessionId } : {}),
  }, emit);
  await handle.session.start();
  handle.session.sendUserText(task);
  return handle;
}

export function send(handle, text) { handle.session.sendUserText(text); }

export async function stop(handle) {
  const before = handle.events.length;
  const t = Date.now();
  await handle.session.interrupt('user');
  // Confirmed = adapter reports the turn ended as interrupted.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !(handle.ended && handle.ended.reason === 'interrupted')) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    confirmed: handle.ended?.reason === 'interrupted',
    confirmMs: handle.ended ? Date.now() - t : null,
    eventsDuringStop: handle.events.length - before,
  };
}

export function sessionId(handle) {
  try { return handle.session.snapshot?.()?.sessionId ?? null; } catch { return null; }
}

export function end(handle) { try { handle.session.end(); } catch { /* idempotent */ } }

function summarize(e) {
  switch (e.kind) {
    case 'worker-signal': {
      const s = e.signal;
      if (s.kind === 'tool') return { kind: 'tool', tool: s.toolName, phase: s.phase, detail: s.detail?.slice(0, 200) };
      if (s.kind === 'progress') return { kind: 'progress', text: s.message.slice(0, 200) };
      if (s.kind === 'delivery') return { kind: 'delivery', summary: s.report?.summary?.slice?.(0, 200) };
      if (s.kind === 'failed') return { kind: 'failed', code: s.code, message: s.message.slice(0, 300) };
      return { kind: s.kind, reason: s.reason };
    }
    case 'permission-request': return { kind: 'permission-request', tool: e.toolName, input: JSON.stringify(e.input).slice(0, 300) };
    case 'message': return { kind: 'message', type: e.message?.type };
    case 'turn-status': return { kind: 'turn-status', status: e.status };
    case 'error': return { kind: 'error', error: String(e.error).slice(0, 300) };
    default: return { kind: e.kind };
  }
}
