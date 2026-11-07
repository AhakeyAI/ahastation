import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { asRecord, sanitizeTitle } from './util.js';
import { canReadProject, type ScanAccess } from './scan-access.js';

export interface StudioTaskSummary {
  meetingId: string; taskId: string; cwd: string; title: string; status: string;
}

/** Read persisted snapshots without calling recovery, which may rewrite/clean files. */
export async function readStudioHistory(userData: string, access: ScanAccess,
  realpath: (path: string) => Promise<string> = (path) => fs.realpath(path)) {
  const tasks: StudioTaskSummary[] = [];
  const internalIds = new Set<string>();
  if (!access.enabled) return { tasks, internalIds };
  const root = join(userData, 'meetings');
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return { tasks, internalIds };
  const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  let remainingBytes = 32 * 1024 * 1024;
  for (const dir of dirs.slice(0, 500)) {
    if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
    try {
      const path = join(root, dir.name, 'snapshot.json');
      const stat = await fs.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) continue;
      if (stat.size > remainingBytes) continue;
      remainingBytes -= stat.size;
      const data = asRecord(JSON.parse(await fs.readFile(path, 'utf8')));
      const state = asRecord(data?.state);
      if (!state) continue;
      // These IDs are exclusion evidence only; never execution credentials or user rows.
      for (const item of [...(Array.isArray(state.hosts) ? state.hosts : []), ...(Array.isArray(state.tasks) ? state.tasks : [])]) {
        const record = asRecord(item);
        const backend = asRecord(record?.backendSession);
        if (typeof backend?.sessionId === 'string') internalIds.add(backend.sessionId);
      }
      if (typeof state.cwd !== 'string' || !await canReadProject(state.cwd, access, realpath)) continue;
      for (const value of Array.isArray(state.tasks) ? state.tasks : []) {
        const task = asRecord(value);
        if (!task || typeof task.id !== 'string') continue;
        tasks.push({ meetingId: dir.name, taskId: task.id, cwd: state.cwd,
          title: sanitizeTitle(typeof task.title === 'string' ? task.title : task.id),
          status: sanitizeTitle(typeof task.status === 'string' ? task.status : 'unknown') });
      }
    } catch { /* Fault-isolated history: never repair a torn/corrupt snapshot. */ }
  }
  return { tasks, internalIds };
}
