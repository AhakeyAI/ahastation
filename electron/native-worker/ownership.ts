import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { createPrivateHookFile, ensurePrivateHookDirectory } from '../global-hooks/file-security.js';

const id = z.string().min(1).max(500).regex(/^[^\x00-\x1f\x7f]+$/);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1);
const binding = {
  agent: z.enum(['claude', 'codex']), origin: z.literal('worker'),
  runtimeId: id, hostEpoch: id, workerId: id, taskId: id, attemptId: id,
  permissionOwnerRef: id, credentialRef: id,
};
const processSchema = z.object({ pid: z.number().int().positive(), startId: id, bootId: id }).strict();
const launchSchema = z.object({ ...binding, revision,
  state: z.enum(['reserved', 'spawned', 'bound', 'ended', 'aborted']),
  registeredAt: z.string().datetime(), processIdentity: processSchema.optional(), sessionId: id.optional(),
}).strict().superRefine((v, ctx) => {
  if ((v.state === 'spawned' || v.state === 'bound') && !v.processIdentity
    || v.state === 'bound' && !v.sessionId) ctx.addIssue({ code: 'custom', message: 'incomplete launch' });
});
const entrySchema = z.object({ ...binding, sessionId: id, revision, registeredAt: z.string().datetime(), ended: z.boolean().optional() }).strict();
const fileSchema = z.object({ schemaVersion: z.literal(2), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  entries: z.array(entrySchema).max(100_000), launches: z.array(launchSchema).max(100_000),
}).strict().superRefine((v, ctx) => {
  const sessions = new Set<string>(), runtimes = new Set<string>(), activeWorkers = new Set<string>(), activeAttempts = new Set<string>();
  for (const e of v.entries) {
    const key = JSON.stringify([e.agent, e.sessionId]);
    if (sessions.has(key)) ctx.addIssue({ code: 'custom', message: 'duplicate session' });
    sessions.add(key);
  }
  for (const l of v.launches) {
    if (runtimes.has(l.runtimeId)) ctx.addIssue({ code: 'custom', message: 'duplicate runtime' });
    runtimes.add(l.runtimeId);
    if (!['ended', 'aborted'].includes(l.state)) {
      const attempt = JSON.stringify([l.taskId, l.attemptId]);
      if (activeWorkers.has(l.workerId) || activeAttempts.has(attempt)) ctx.addIssue({ code: 'custom', message: 'duplicate active attempt' });
      activeWorkers.add(l.workerId); activeAttempts.add(attempt);
    }
    if (l.state === 'bound' && !v.entries.some(e => e.runtimeId === l.runtimeId && e.agent === l.agent
      && e.sessionId === l.sessionId && e.taskId === l.taskId && e.attemptId === l.attemptId
      && e.hostEpoch === l.hostEpoch && e.credentialRef === l.credentialRef && e.permissionOwnerRef === l.permissionOwnerRef)) {
      ctx.addIssue({ code: 'custom', message: 'entry/launch mismatch' });
    }
  }
});
export type ProcessIdentity = z.infer<typeof processSchema>;
export type WorkerLaunch = z.infer<typeof launchSchema>;
export type OwnershipFile = z.infer<typeof fileSchema>;
export type WorkerBinding = Pick<WorkerLaunch, keyof typeof binding>;

/** Internal service, never renderer/hook IPC. Caller must be the profile's
 * trusted launcher. Station/user-adopted need their real owner mapping before
 * extending this writer; unsupported existing schemas are unavailable. */
export class WorkerOwnershipService {
  readonly path: string;
  private lease?: number;
  private closed = false;
  constructor(profileDirectory: string) {
    this.path = join(profileDirectory, 'sessions', 'owned.json');
    ensurePrivateHookDirectory(dirname(this.path));
    // One process writer; no stale-lock deletion or direct-write fallback.
    this.lease = openSync(`${this.path}.writer`, 'wx', 0o600);
  }
  read(): OwnershipFile {
    if (this.closed) throw new Error('ownership-unavailable');
    try {
      const st = lstatSync(this.path);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 32 * 1024 * 1024) throw new Error('invalid ownership file');
      return fileSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch { throw new Error('ownership-unavailable'); }
  }
  /** Only explicit profile initialization may create an absent file. Read
   * failure or a missing file during an active run never becomes empty. */
  initialize(): void {
    if (this.closed) throw new Error('ownership-unavailable');
    if (existsSync(this.path)) { this.read(); return; }
    this.commit({ schemaVersion: 2, revision: 0, entries: [], launches: [] });
  }
  private commit(value: OwnershipFile): void {
    const data = fileSchema.parse(value);
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      createPrivateHookFile(temp, JSON.stringify(data));
      const fd = openSync(temp, 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.path);
      // fsync directory on POSIX; Windows atomic replacement is tested in CI.
      if (process.platform !== 'win32') {
        const dir = openSync(dirname(this.path), 'r');
        try { fsyncSync(dir); } finally { closeSync(dir); }
      }
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  reserve(bindingValue: WorkerBinding): WorkerLaunch {
    const file = this.read();
    const candidate = launchSchema.parse({ ...bindingValue, state: 'reserved', revision: 1, registeredAt: new Date().toISOString() });
    const existing = file.launches.find(l => l.runtimeId === candidate.runtimeId);
    if (existing) {
      if (Object.keys(binding).every(k => existing[k as keyof WorkerBinding] === candidate[k as keyof WorkerBinding])
        && existing.state === 'reserved') return structuredClone(existing);
      throw new Error('launch-conflict');
    }
    if (file.launches.some(l => !['ended', 'aborted'].includes(l.state)
      && (l.workerId === candidate.workerId || (l.taskId === candidate.taskId && l.attemptId === candidate.attemptId)))) {
      throw new Error('active-attempt-conflict');
    }
    file.launches.push(candidate); file.revision++; this.commit(file);
    return structuredClone(candidate);
  }
  attach(runtimeId: string, expectedRevision: number, processIdentity: ProcessIdentity): WorkerLaunch {
    const file = this.read(), launch = file.launches.find(l => l.runtimeId === runtimeId);
    const process = processSchema.parse(processIdentity);
    if (launch?.state === 'spawned' && launch.revision === expectedRevision + 1
      && JSON.stringify(launch.processIdentity) === JSON.stringify(process)) return structuredClone(launch);
    if (!launch || launch.revision !== expectedRevision || launch.state !== 'reserved') throw new Error('launch-conflict');
    launch.processIdentity = process;
    launch.state = 'spawned'; launch.revision++; file.revision++; this.commit(file);
    return structuredClone(launch);
  }
  bind(runtimeId: string, expectedRevision: number, sessionId: string): WorkerLaunch {
    id.parse(sessionId);
    const file = this.read(), launch = file.launches.find(l => l.runtimeId === runtimeId);
    if (!launch) throw new Error('launch-conflict');
    if (launch.state === 'bound' && launch.sessionId === sessionId && launch.revision === expectedRevision + 1) return structuredClone(launch);
    if (launch.revision !== expectedRevision || launch.state !== 'spawned') throw new Error('launch-conflict');
    // Reusing a historical session requires a separately verified rebind. This
    // new-launch writer deliberately refuses to overwrite any prior origin.
    if (file.entries.some(e => e.agent === launch.agent && e.sessionId === sessionId)) throw new Error('session-conflict');
    const entry = entrySchema.parse({ ...Object.fromEntries(Object.keys(binding).map(k => [k, launch[k as keyof WorkerBinding]])),
      sessionId, revision: 1, registeredAt: launch.registeredAt });
    file.entries.push(entry); launch.sessionId = sessionId; launch.state = 'bound';
    launch.revision++; file.revision++; this.commit(file);
    return structuredClone(launch);
  }
  end(runtimeId: string, expectedRevision: number): void {
    const file = this.read(), launch = file.launches.find(l => l.runtimeId === runtimeId);
    if (!launch || launch.revision !== expectedRevision) throw new Error('launch-conflict');
    if (launch.state === 'ended' || launch.state === 'aborted') return;
    launch.state = launch.state === 'bound' ? 'ended' : 'aborted'; launch.revision++;
    const entry = file.entries.find(e => e.runtimeId === runtimeId);
    if (entry) { entry.ended = true; entry.revision++; }
    file.revision++; this.commit(file);
  }
  lookup(agent: 'claude' | 'codex', sessionId: string) {
    try {
      const f = this.read();
      const entry = f.entries.find(e => e.agent === agent && e.sessionId === sessionId);
      return entry ? { status: 'owned' as const, entry } : {
        status: f.launches.some(l => !['ended', 'aborted'].includes(l.state)) ? 'unresolved' as const : 'absent' as const,
      };
    } catch { return { status: 'unavailable' as const }; }
  }
  close(): void {
    this.closed = true;
    if (this.lease !== undefined) { closeSync(this.lease); this.lease = undefined; unlinkSync(`${this.path}.writer`); }
  }
}
