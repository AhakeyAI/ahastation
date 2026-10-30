import { promises as fs } from 'node:fs';
import { asRecord, sha1 } from './util.js';

export type SessionOrigin = 'worker' | 'station' | 'user-adopted' | 'user' | 'unknown';
export interface OwnershipIndex {
  available: boolean;
  pending: boolean;
  origins: Map<string, SessionOrigin>;
  /** In-memory change marker only; never leaves the local scan service. */
  token?: string;
}
export const ownershipKey = (agent: string, id: string): string => `${agent}:${id}`;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Read IF-2 only. Scanner never repairs, migrates or writes the registry. */
export async function readOwnership(path: string): Promise<OwnershipIndex> {
  const unavailable = (): OwnershipIndex => ({ available: false, pending: false, origins: new Map() });
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) return unavailable();
    const raw = await fs.readFile(path, 'utf8');
    const doc = asRecord(JSON.parse(raw));
    if (!doc || doc.schemaVersion !== 2 || !Number.isSafeInteger(doc.revision)
      || Number(doc.revision) < 0 || !Array.isArray(doc.entries) || !Array.isArray(doc.launches)) return unavailable();
    const origins = new Map<string, SessionOrigin>();
    const bindings = new Map<string, Record<string, unknown>>();
    for (const value of doc.entries) {
      const entry = asRecord(value);
      if (!entry || !['claude', 'codex'].includes(String(entry.agent))
        || typeof entry.sessionId !== 'string' || !entry.sessionId
        || !['worker', 'station', 'user-adopted'].includes(String(entry.origin))
        || !Number.isSafeInteger(entry.revision) || Number(entry.revision) < 1
        || typeof entry.registeredAt !== 'string' || !Number.isFinite(Date.parse(entry.registeredAt))) return unavailable();
      if ((entry.taskId === undefined) !== (entry.attemptId === undefined)) return unavailable();
      if (![entry.taskId, entry.attemptId, entry.workerId, entry.runtimeId]
        .every((value) => value === undefined || nonempty(value))) return unavailable();
      if (entry.origin === 'worker' && ![entry.taskId, entry.attemptId, entry.workerId, entry.runtimeId]
        .every((s) => typeof s === 'string' && s.length > 0)) return unavailable();
      const key = ownershipKey(entry.agent as string, entry.sessionId);
      if (origins.has(key)) return unavailable();
      origins.set(key, entry.origin as SessionOrigin);
      bindings.set(key, entry);
    }
    let pending = false;
    const runtimes = new Set<string>();
    for (const value of doc.launches) {
      const launch = asRecord(value);
      if (!launch || typeof launch.runtimeId !== 'string' || !launch.runtimeId
        || runtimes.has(launch.runtimeId) || !['reserved', 'spawned', 'bound', 'ended', 'aborted'].includes(String(launch.state))
        || !['claude', 'codex'].includes(String(launch.agent))
        || !['worker', 'station', 'user-adopted'].includes(String(launch.origin))
        || !nonempty(launch.hostEpoch) || !nonempty(launch.permissionOwnerRef)
        || !Number.isSafeInteger(launch.revision) || Number(launch.revision) < 1
        || ![launch.workerId, launch.taskId, launch.attemptId, launch.credentialRef, launch.sessionId]
          .every((value) => value === undefined || nonempty(value))
        || (launch.taskId === undefined) !== (launch.attemptId === undefined)) return unavailable();
      if (launch.origin === 'worker' && ![launch.workerId, launch.taskId, launch.attemptId, launch.credentialRef].every(nonempty)) return unavailable();
      if (launch.state === 'bound') {
        const bound = bindings.get(ownershipKey(String(launch.agent), String(launch.sessionId)));
        if (!nonempty(launch.sessionId) || !bound || bound.origin !== launch.origin
          || bound.runtimeId !== launch.runtimeId || bound.taskId !== launch.taskId || bound.attemptId !== launch.attemptId) return unavailable();
      }
      runtimes.add(launch.runtimeId);
      // Until association/cleanup is proven, an unbound launch is not a user session.
      if (launch.state !== 'ended' && launch.state !== 'bound') pending = true;
    }
    return { available: true, pending, origins, token: sha1(raw) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { available: true, pending: false, origins: new Map(), token: 'missing' };
    return unavailable();
  }
}
