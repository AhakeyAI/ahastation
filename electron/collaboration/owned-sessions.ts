import { app } from 'electron';
import { join, resolve } from 'node:path';
import { DurableState } from './durable-state.js';

export interface OwnedSessionRecord {
  agent: string;
  sessionId: string;
  origin: 'station' | 'worker' | 'user-adopted';
  taskId: string;
  attemptId: string;
  registeredAt: string;
}

// Serialize all Station instances writing this local file in the current process.
// Separate scanner processes must coordinate through the agreed registry writer.
const writes = new Map<string, Promise<void>>();

function validRecord(value: unknown): value is OwnedSessionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as OwnedSessionRecord;
  return ['agent', 'sessionId', 'taskId', 'attemptId', 'registeredAt'].every(
    key => typeof row[key as keyof OwnedSessionRecord] === 'string' && !!row[key as keyof OwnedSessionRecord].trim(),
  ) && ['station', 'worker', 'user-adopted'].includes(row.origin)
    && Number.isFinite(Date.parse(row.registeredAt));
}

/** Register only a session this component actually created, never a scanned user session. */
export function registerOwnedSession(
  input: Omit<OwnedSessionRecord, 'registeredAt'>,
  file = join(app.getPath('userData'), 'sessions', 'owned.json'),
): Promise<void> {
  const record = { ...input, registeredAt: new Date().toISOString() };
  if (!validRecord(record)) return Promise.reject(new Error('会话归属登记参数无效'));
  const absolute = resolve(file);
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  const operation = (writes.get(key) ?? Promise.resolve()).then(async () => {
    const state = new DurableState<OwnedSessionRecord[]>(absolute, []);
    // Invalid JSON or records stop before any atomic replacement.
    await state.load();
    const records = state.read();
    if (!Array.isArray(records) || !records.every(validRecord)) throw new Error('本机会话归属清单损坏，保留原文件等待核对');
    const previous = records.find(row => row.agent === record.agent && row.sessionId === record.sessionId);
    if (previous) {
      if (previous.origin !== record.origin || previous.taskId !== record.taskId || previous.attemptId !== record.attemptId) {
        throw new Error('会话已有其他归属，保留原登记；不能将已有用户会话改为 Station 会话');
      }
      return;
    }
    await state.update(rows => { rows.push(record); });
  });
  const settled = operation.then(() => {}, () => {});
  writes.set(key, settled);
  void settled.then(() => { if (writes.get(key) === settled) writes.delete(key); });
  return operation;
}
