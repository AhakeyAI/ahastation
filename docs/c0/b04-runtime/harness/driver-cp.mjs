// C-P driver: Paseo 0.12.0 daemon via the PUBLIC @getpaseo/client root export.
// The public agent handle has no interrupt/cancel; stop() uses the public CLI
// (`paseo stop <id>`), which is the documented way to interrupt.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brokerDecide } from './common.mjs';

const PASEO = join(homedir(), 'aha-c0', 'paseo');
const PASEO_HOME = join(homedir(), 'aha-c0', 'paseo-home');
const { createPaseoClient } = await import(
  pathToFileURL(join(PASEO, 'node_modules', '@getpaseo', 'client', 'dist', 'index.js')).href
);

export const candidate = 'C-P';

export function versions(provider) {
  return provider === 'codex'
    ? { paseo: '0.12.0', codex: 'global 0.156.1', model: process.env.B04_CODEX_MODEL ?? 'gpt-6-sol' }
    : { paseo: '0.12.0', claudeCode: 'global 2.1.309', model: process.env.B04_CLAUDE_MODEL ?? 'claude-sonnet-5-5' };
}

let client = null;
async function getClient() {
  if (!client) {
    client = createPaseoClient({ url: process.env.B04_PASEO_URL ?? 'ws://127.0.0.1:6767/ws' });
    await client.connect();
  }
  return client;
}

export async function start({ provider, ws, task, policy }) {
  const c = await getClient();
  const events = [];
  const t0 = Date.now();
  const handle = { events, t0, agent: null, permissions: [], ended: null, answered: new Set(), raw: [] };
  const decide = policy ?? ((req) => brokerDecide(ws, req));
  const providerId = provider === 'claude-code' ? 'claude' : 'codex';
  const model = provider === 'codex'
    ? (process.env.B04_CODEX_MODEL ?? 'gpt-6-sol')
    : (process.env.B04_CLAUDE_MODEL ?? 'claude-sonnet-5-5');
  // Claude: `default` mode (ask through canUseTool). Codex: Paseo's strictest
  // preset is `auto` (on-request + workspace-write). Passing the C-A policy
  // approval_policy='untrusted' fails on Codex 0.156.1 ("no longer supported"),
  // so commands inside the sandbox run without asking — a recorded difference.
  const config = provider === 'codex'
    ? {
        provider: `${providerId}/${model}`,
        modeId: 'auto',
        ...(process.env.B04_CODEX_APPROVAL ? { options: { approval_policy: process.env.B04_CODEX_APPROVAL } } : {}),
      }
    : { provider: `${providerId}/${model}`, modeId: 'default' };
  handle.config = config;
  handle.agent = await c.agents.create({ config, cwd: ws, prompt: task });
  let sawRunning = false;
  const onUpdate = (update) => {
    const at = Date.now() - t0;
    const agent = update?.agent ?? update?.payload ?? update;
    if (process.env.B04_RAW) handle.raw.push({ at, update });
    const status = agent?.status ?? handle.agent.status;
    if (status && status !== handle.lastStatus) {
      events.push({ at, kind: 'status', status });
      handle.lastStatus = status;
    }
    if (status === 'running') sawRunning = true;
    if (status === 'error' && !handle.ended) {
      handle.ended = { at, reason: 'error', lastError: agent?.lastError ?? handle.agent.lastError ?? null };
    }
    const pending = agent?.pendingPermissions ?? handle.agent.pendingPermissions ?? [];
    for (const p of pending) {
      const id = p.id ?? p.requestId;
      if (!id || handle.answered.has(id)) continue;
      handle.answered.add(id);
      void answerPermission(handle, p, decide, t0);
    }
    if (sawRunning && (status === 'idle' || status === 'error' || status === 'closed') && !handle.ended) {
      handle.ended = { at, reason: status === 'idle' ? 'completed' : status };
    }
  };
  handle.unsubscribe = handle.agent.subscribe(onUpdate);
  onUpdate(handle.agent.current?.() ?? {});
  // The live subscription delivered only the first status change in the
  // probe; poll refresh() so idle/pending permissions are not missed.
  handle.poll = setInterval(async () => {
    try {
      const r = await handle.agent.refresh();
      onUpdate(r?.agent ?? handle.agent.current?.() ?? {});
      handle.polls = (handle.polls ?? 0) + 1;
    } catch (err) {
      events.push({ at: Date.now() - t0, kind: 'error', error: `refresh: ${String(err).slice(0, 200)}` });
    }
  }, 1500);
  return handle;
}

// Codex permission requests carry no path (e.g. CodexFileChange "command
// failed; retry without sandbox?"). The path lives on the timeline tool call
// whose callId equals metadata.itemId — look it up, as a host broker must.
async function answerPermission(handle, p, decide, t0) {
  const at = Date.now() - t0;
  let toolDetail = '';
  const input = p.input ?? {};
  if (p.detail?.filePath) toolDetail = p.detail.filePath;
  const itemId = p.metadata?.itemId;
  if (!toolDetail && itemId) {
    try {
      const page = await handle.agent.timeline.refetch({ direction: 'tail', limit: 20 });
      const hit = (page.entries ?? []).find((e) => e.item?.callId === itemId);
      toolDetail = hit?.item?.detail?.filePath ?? hit?.item?.detail?.command ?? '';
    } catch { /* fail closed below */ }
  }
  const command = p.detail?.command ?? input.command;
  const req = { toolName: p.name ?? p.kind ?? 'unknown', input: command ? { ...input, command } : input, toolDetail };
  const verdict = decide(req);
  handle.permissions.push({ at, toolName: req.toolName, title: p.title, description: p.description, toolDetail, ...verdict });
  handle.events.push({ at, kind: 'permission-request', tool: req.toolName, detail: `${p.title ?? ''} ${p.description ?? ''} ${toolDetail}`.slice(0, 300) });
  try {
    await handle.agent.respondToPermission({
      requestId: p.id,
      response: verdict.allow ? { behavior: 'allow' } : { behavior: 'deny', message: verdict.why },
    });
  } catch (err) {
    handle.events.push({ at: Date.now() - t0, kind: 'error', error: `respond: ${String(err).slice(0, 200)}` });
  }
}

export function send(handle, text) {
  return handle.agent.send(text);
}

export async function stop(handle) {
  const before = handle.events.length;
  const t = Date.now();
  const cli = join(PASEO, 'node_modules', '.bin', process.platform === 'win32' ? 'paseo.cmd' : 'paseo');
  const out = await new Promise((resolve) => {
    execFile(cli, ['stop', handle.agent.id, '--home', PASEO_HOME], { shell: process.platform === 'win32', timeout: 30_000 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && handle.agent.status === 'running') await new Promise((r) => setTimeout(r, 100));
  return {
    confirmed: out.code === 0 && handle.agent.status !== 'running',
    confirmMs: Date.now() - t,
    cli: { code: out.code, stdout: String(out.stdout).slice(0, 300), stderr: String(out.stderr).slice(0, 300) },
    statusAfter: handle.agent.status,
    eventsDuringStop: handle.events.length - before,
  };
}

/** Drop the client connection (simulated network loss / host restart), wait,
 *  reconnect with a NEW client, re-attach to the same agent. Returns what the
 *  public API exposes about history that happened while disconnected. */
export async function reconnect(handle, gapMs) {
  const id = handle.agent.id;
  const lostAt = Date.now();
  clearInterval(handle.poll);
  try { handle.unsubscribe?.(); } catch { /* ignore */ }
  await closeAll();
  await new Promise((r) => setTimeout(r, gapMs));
  const c = await getClient();
  handle.agent = c.agents.ref(id);
  const refreshed = await handle.agent.refresh();
  const page = await handle.agent.timeline.refetch({ direction: 'tail', limit: 200 });
  const entries = page.entries ?? [];
  const inGap = entries.filter((e) => {
    const t = Date.parse(e.timestamp ?? '');
    return Number.isFinite(t) && t >= lostAt && t <= Date.now();
  });
  // Resume polling for completion.
  handle.poll = setInterval(async () => {
    try {
      const r = await handle.agent.refresh();
      const st = r?.agent?.status;
      if (st && st !== handle.lastStatus) { handle.events.push({ at: Date.now() - handle.t0, kind: 'status', status: st }); handle.lastStatus = st; }
      if ((st === 'idle' || st === 'error') && !handle.ended) handle.ended = { at: Date.now() - handle.t0, reason: st === 'idle' ? 'completed' : 'error' };
    } catch { /* keep polling */ }
  }, 1500);
  return {
    statusAfter: refreshed?.agent?.status ?? null,
    entries: entries.length,
    entriesDuringGap: inGap.length,
    gap: page.gap ?? null,
    staleCursor: page.staleCursor ?? null,
    reset: page.reset ?? null,
  };
}

export async function timelineToolCount(handle) {
  try {
    const page = await handle.agent.timeline.refetch({ direction: 'tail', limit: 200 });
    return (page.entries ?? []).filter((e) => e.item?.type === 'tool_call').length;
  } catch { return null; }
}

export function sessionId(handle) {
  return handle.agent?.runtimeInfo?.sessionId ?? null;
}

export function usage(handle) {
  return handle.agent?.lastUsage ?? null;
}

export async function timeline(handle) {
  try { return await handle.agent.timeline.refetch({ limit: 200 }); } catch (err) { return { error: String(err) }; }
}

export function end(handle) {
  clearInterval(handle.poll);
  try { handle.unsubscribe?.(); } catch { /* ignore */ }
}

export async function closeAll() {
  if (client) { try { await client.close(); } catch { /* ignore */ } client = null; }
}
