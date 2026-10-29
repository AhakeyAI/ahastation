import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseObservation, type HookAgent, type HookObservationInput } from './protocol.js';
import { ensurePrivateHookDirectory } from './file-security.js';

export interface ObservationV1 {
  protocol: 'aha.if1'; schemaVersion: 1; eventId: string; publisherEpoch: string;
  seq: number; receivedAt: string;
  kind: 'tool.before' | 'permission.requested' | 'tool.after' | 'turn.ended';
  subject: { deviceId: string; agent: HookAgent; sessionId: string; runtimeId: null;
    origin: 'user' | 'unknown'; ownership: 'unowned' | 'unresolved'; controlMode: 'none' | 'unknown' };
  source: { type: 'cli-hook'; name: string; invocationId: string; turnId?: string; toolUseId?: string };
  state: { phase: 'running' | 'waiting-permission' | 'unknown'; process: 'unknown';
    connection: 'connected'; reason: string; pendingApprovalCount: 0 };
  toolName?: string;
}
export interface ObservationCursor { deviceId: string; publisherEpoch: string; seq: number }
export interface HookHostOptions {
  endpointPath: string; profileId: string; deviceId: string;
  /** Must check local scan authorization AND IF-2 tri-state lookup. No I/O
   * delegated to the hook. null drops unauthorized/owned/adopted sessions.
   * unresolved can be displayed only after the independent scan check. */
  classifyAuthorized: (input: Readonly<HookObservationInput>) => 'user' | 'unresolved' | null;
  queueCapacity?: number; retention?: number; maxSessions?: number;
  onDiagnostic?: (code: string) => void;
}

/** Observation-only local ingress. Deliberately has no approval API. */
export class GlobalHookHost {
  private epoch = randomUUID();
  private readonly token = randomBytes(32).toString('hex');
  private server?: Server;
  private lease?: number;
  private used = false;
  private readonly diagnostics = new Set<string>();
  private seq = 0;
  private queue: HookObservationInput[] = [];
  private draining = false;
  private readonly sessions = new Map<string, ObservationV1>();
  private readonly ring: ObservationV1[] = [];
  private readonly seen = new Map<string, string>();
  constructor(private readonly options: HookHostOptions) {
    if (!options.profileId.trim() || !options.deviceId.trim()) throw new Error('invalid-hook-host-identity');
    for (const [value, max] of [[options.queueCapacity, 1024], [options.retention, 1000], [options.maxSessions, 1000]]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > max!)) throw new Error('invalid-hook-host-limit');
    }
  }

  async start(): Promise<void> {
    if (this.used) throw new Error('hook-host-instance-already-used');
    this.used = true; // a new publisher lifecycle must get a new epoch/token
    ensurePrivateHookDirectory(dirname(this.options.endpointPath));
    this.lease = openSync(`${this.options.endpointPath}.lock`, 'wx', 0o600);
    const server = createServer((req, res) => {
      const auth = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${this.token}`);
      if (req.headers.origin || req.method !== 'POST' || req.url !== '/observe'
        || req.headers['content-type'] !== 'application/json'
        || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        res.writeHead(403).end(); req.resume(); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => { res.writeHead(408).end(); req.destroy(); }, 100);
      req.on('close', () => clearTimeout(timer));
      req.on('error', () => clearTimeout(timer));
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16 * 1024) { clearTimeout(timer); res.writeHead(413).end(); req.destroy(); }
        else chunks.push(chunk);
      });
      req.on('end', () => {
        clearTimeout(timer);
        if (res.writableEnded) return;
        let input;
        try { input = parseObservation(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { /* reject */ }
        if (!input) { res.writeHead(400).end(); return; }
        if (this.queue.length >= (this.options.queueCapacity ?? 128)) { res.writeHead(429).end(); return; }
        this.queue.push(input);
        res.writeHead(202).end();
        if (!this.draining) {
          this.draining = true;
          setImmediate(() => this.drain());
        }
      });
    });
    server.maxConnections = 32;
    server.headersTimeout = 1000;
    server.requestTimeout = 1000;
    try { await new Promise<void>((yes, no) => {
      server.once('error', no); server.listen(0, '127.0.0.1', () => { server.removeListener('error', no); yes(); });
    }); } catch (error) { this.releaseLease(); throw error; }
    const port = (server.address() as { port: number }).port;
    // One global install belongs to one profile. Refuse another live host;
    // installer lock/lease is the cross-process single-owner boundary.
    this.server = server;
    try {
      mkdirSync(dirname(this.options.endpointPath), { recursive: true, mode: 0o700 });
      const temp = `${this.options.endpointPath}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify({ protocol: 'aha.hooks.local.v1',
        port, token: this.token, profileId: this.options.profileId }), { flag: 'wx', mode: 0o600 });
      renameSync(temp, this.options.endpointPath);
    } catch (error) { await this.stop(); throw error; }
  }

  private drain(): void {
    const queue = this.queue.splice(0);
    this.draining = false;
    for (const input of queue) {
      try { this.publish(input); } catch { this.diagnose('observation-classifier-failed'); }
    }
  }

  private publish(input: HookObservationInput): void {
    if (!this.server) return;
    const sessionKey = `${input.agent}:${input.sessionId}`;
    const origin = this.options.classifyAuthorized(Object.freeze({ ...input }));
    if (origin !== 'user' && origin !== 'unresolved') {
      this.forgetSession(sessionKey);
      return;
    }
    const previous = this.sessions.get(sessionKey);
    if (previous && previous.subject.origin !== (origin === 'user' ? 'user' : 'unknown')) {
      this.forgetSession(sessionKey);
    }
    const key = `${input.agent}:${input.invocationId}`;
    const body = JSON.stringify(input);
    if (this.seen.has(key)) {
      if (this.seen.get(key) !== body) this.diagnose('observation-id-conflict');
      return;
    }
    this.seen.set(key, body);
    if (this.seen.size > 1000) this.seen.delete(this.seen.keys().next().value!);
    const seq = ++this.seq;
    const event: ObservationV1 = {
      protocol: 'aha.if1', schemaVersion: 1, publisherEpoch: this.epoch, seq,
      eventId: `${this.epoch}:${seq}`, receivedAt: new Date().toISOString(),
      kind: ({ PreToolUse: 'tool.before', PermissionRequest: 'permission.requested',
        PostToolUse: 'tool.after', Stop: 'turn.ended' } as const)[input.event],
      subject: { deviceId: this.options.deviceId, agent: input.agent, sessionId: input.sessionId,
        runtimeId: null, origin: origin === 'user' ? 'user' : 'unknown',
        ownership: origin === 'user' ? 'unowned' : 'unresolved', controlMode: origin === 'user' ? 'none' : 'unknown' },
      source: { type: 'cli-hook', name: input.event, invocationId: input.invocationId,
        ...(input.turnId ? { turnId: input.turnId } : {}), ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}) },
      // A hook is not process evidence. Stop/Post also cannot establish idle:
      // Claude has no reliable turn identity and tools may still be pending.
      state: { phase: origin === 'unresolved' || input.event === 'Stop' || input.event === 'PostToolUse'
        ? 'unknown' : input.event === 'PermissionRequest' ? 'waiting-permission' : 'running',
      process: 'unknown', connection: 'connected', reason: origin === 'unresolved' ? 'ownership-unresolved'
        : input.event === 'PermissionRequest' ? 'native-permission' : 'hook-observed', pendingApprovalCount: 0 },
      ...(input.toolName ? { toolName: input.toolName } : {}),
    };
    this.ring.push(event);
    this.sessions.set(sessionKey, event);
    if (this.sessions.size > (this.options.maxSessions ?? 1000)) this.sessions.delete(this.sessions.keys().next().value!);
    this.trim();
  }

  private trim(): void {
    const cutoff = Date.now() - 300_000;
    while (this.ring.length && (this.ring.length > (this.options.retention ?? 1000)
      || Date.parse(this.ring[0].receivedAt) < cutoff)) this.ring.shift();
  }
  private diagnose(code: string): void {
    if (this.diagnostics.has(code) || this.diagnostics.size >= 10) return;
    this.diagnostics.add(code);
    try { this.options.onDiagnostic?.(code); } catch { /* diagnostics cannot break ingress */ }
  }
  private forgetSession(key: string): void {
    if (!this.sessions.has(key) && !this.ring.some(event => `${event.subject.agent}:${event.subject.sessionId}` === key)) return;
    this.sessions.delete(key);
    // Rebuild the observation stream: even a consumer already at the latest
    // cursor must resnapshot and remove its formerly authorized projection.
    this.ring.length = 0;
    this.seen.clear();
    this.seq = 0;
    this.epoch = randomUUID();
  }
  /** Ownership and scan authorization can change without another hook. Never
   * replay a formerly authorized user projection after revocation/adoption. */
  private refreshAuthorization(): void {
    // The session cache may be smaller than the replay ring. Recheck both.
    const latest = new Map(this.ring.map(event => [`${event.subject.agent}:${event.subject.sessionId}`, event]));
    for (const [key, event] of this.sessions) latest.set(key, event);
    for (const [key, event] of latest) {
      let origin: ReturnType<HookHostOptions['classifyAuthorized']> = null;
      try {
        origin = this.options.classifyAuthorized(Object.freeze({
          protocol: 'aha.if1', schemaVersion: 1, agent: event.subject.agent,
          sessionId: event.subject.sessionId, event: event.source.name as HookObservationInput['event'],
          invocationId: event.source.invocationId, toolName: event.toolName,
          turnId: event.source.turnId, toolUseId: event.source.toolUseId,
        }));
      } catch { this.diagnose('observation-classifier-failed'); }
      if ((origin !== 'user' && origin !== 'unresolved')
        || event.subject.origin !== (origin === 'user' ? 'user' : 'unknown')) this.forgetSession(key);
    }
  }
  getSnapshot() {
    this.refreshAuthorization();
    return structuredClone({ protocol: 'aha.if1' as const, schemaVersion: 1 as const,
      deviceId: this.options.deviceId, publisherEpoch: this.epoch, watermark: this.seq,
      sessions: [...this.sessions.values()].map(({ subject, state }) => ({ subject,
        state: this.server ? state : { ...state, phase: 'unknown' as const, connection: 'disconnected' as const, reason: 'host-unavailable' } })) });
  }
  /** Read-only incremental subscription/poll; no await between snapshot and
   * cursor capture. Slow consumers must resnapshot, never silently skip. */
  subscribe(after: ObservationCursor): { status: 'ok'; events: ObservationV1[]; cursor: ObservationCursor }
    | { status: 'resnapshot-required' } {
    this.refreshAuthorization();
    this.trim();
    if (!this.server || after.deviceId !== this.options.deviceId || after.publisherEpoch !== this.epoch
      || !Number.isSafeInteger(after.seq) || after.seq < 0 || after.seq > this.seq
      || after.seq < (this.ring[0]?.seq ?? this.seq + 1) - 1) return { status: 'resnapshot-required' };
    const events = this.ring.filter(e => e.seq > after.seq);
    // Revocation can remove a suffix or an interior event, not just the head.
    if (events.length !== this.seq - after.seq) return { status: 'resnapshot-required' };
    return structuredClone({ status: 'ok', events,
      cursor: { deviceId: this.options.deviceId, publisherEpoch: this.epoch, seq: this.seq } });
  }
  async stop(): Promise<void> {
    const server = this.server; this.server = undefined;
    try {
      if (JSON.parse(readFileSync(this.options.endpointPath, 'utf8')).token === this.token) unlinkSync(this.options.endpointPath);
    } catch { /* absent or replaced endpoint: never remove another host */ }
    this.queue = [];
    if (server) await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
    this.releaseLease();
  }
  private releaseLease(): void {
    if (this.lease !== undefined) {
      closeSync(this.lease); this.lease = undefined;
      try { unlinkSync(`${this.options.endpointPath}.lock`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}
