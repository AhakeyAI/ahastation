// Shared process snapshot: persistent CIM on Windows, ps on macOS/Linux.
// File metadata uses lsof on macOS, /proc readlink on Linux, no subprocess on Windows.

import { promises as fs } from 'node:fs';
import { defaultExec, type ExecImpl } from '../util.js';
import { commandTokens } from './command-line.js';
import { WindowsProcessReader } from './windows-reader.js';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
  comm: string;
  cpuPct: number;
  rssKb: number;
  /** Controlling terminal exactly as ps reports it ('s003', or '??' when the
   *  process has none). Session actions treat '??' as "no tty". */
  tty: string;
}

export interface ProcessSnapshot {
  byPid: Map<number, ProcessInfo>;
  childrenOf: Map<number, number[]>;
  capturedAt: number;
}

const PS_TIMEOUT_MS = 5_000;
const LSOF_TIMEOUT_MS = 10_000;
const PS_MAX_BUFFER = 16 * 1024 * 1024;
const windowsReader = new WindowsProcessReader();

/** Release the persistent helper when scanning stops or permission is revoked. */
export function stopProcessSnapshotCapture(): void { windowsReader.dispose(); }

/** Parse `ps -axo pid,ppid,tt,%cpu,rss,comm,args` output. The comm column is
 * truncated to a fixed width by ps, so the args column is located via the
 * header's ARGS offset instead of token splitting (comm may contain
 * spaces, e.g. "Electron Helper (Renderer)"). */
export function parsePsOutput(text: string, capturedAt = Date.now()): ProcessSnapshot {
  const lines = text.split('\n');
  const byPid = new Map<number, ProcessInfo>();
  const childrenOf = new Map<number, number[]>();
  if (lines.length === 0) return { byPid, childrenOf, capturedAt };
  const header = lines[0];
  const argsStart = header.indexOf('ARGS');
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const tty = match[3];
    const cpuPct = Number(match[4]);
    const rssKb = Number(match[5]);
    const rest = match[6];
    let comm: string;
    let command: string;
    if (argsStart > 0 && line.length > argsStart) {
      command = line.slice(argsStart).trimEnd();
      comm = rest.slice(0, Math.max(0, rest.length - command.length)).trim();
    } else {
      // Fallback: line too short for column math — first token is comm.
      const spaceIdx = rest.search(/\s/);
      comm = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
      command = spaceIdx === -1 ? rest : rest.slice(spaceIdx).trim();
    }
    if (!command) command = comm;
    byPid.set(pid, { pid, ppid, command, comm, cpuPct, rssKb, tty });
    const siblings = childrenOf.get(ppid);
    if (siblings) siblings.push(pid);
    else childrenOf.set(ppid, [pid]);
  }
  return { byPid, childrenOf, capturedAt };
}

/** All consumers, including own-process-tree exclusion, use this same snapshot. */
export async function captureProcessSnapshot(
  execImpl: ExecImpl = defaultExec,
): Promise<ProcessSnapshot> {
  if (process.platform === 'win32') {
    return parseWindowsProcesses(await windowsReader.capture());
  }
  const { stdout } = await execImpl(
    'ps',
    // Linux otherwise truncates long command lines to the terminal width.
    process.platform === 'linux' ? ['-ww', '-axo', 'pid,ppid,tt,%cpu,rss,comm,args'] : ['-axo', 'pid,ppid,tt,%cpu,rss,comm,args'],
    { timeoutMs: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER },
  );
  return parsePsOutput(stdout);
}

/** Windows has no reliable per-process cwd/CPU percentage here. Never invent either. */
export function parseWindowsProcesses(text: string): ProcessSnapshot {
  const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const byPid: ProcessSnapshot['byPid'] = new Map();
  const childrenOf = new Map<number, number[]>();
  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row.ProcessId) || row.ProcessId <= 0 || !Number.isSafeInteger(row.ParentProcessId)) continue;
    const pid = row.ProcessId, ppid = row.ParentProcessId;
    const command = typeof row.CommandLine === 'string' ? row.CommandLine : String(row.Name ?? '');
    byPid.set(pid, { pid, ppid, command, comm: String(row.Name ?? ''), cpuPct: 0, rssKb: 0, tty: '??' });
    childrenOf.set(ppid, [...(childrenOf.get(ppid) ?? []), pid]);
  }
  return { byPid, childrenOf, capturedAt: Date.now() };
}

const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs'];

/** Token-level binary-name match against a full command line.
 * Handles node wrappers (`node .../codex.js`), npm shims
 * (`/usr/local/bin/codex`) and `.exe` suffixes, without matching tokens
 * where the name only appears inside a path argument
 * (`code /home/me/.claude` → basename `.claude` ≠ `claude`). */
export function cmdHasBinary(command: string, name: string): boolean {
  const tokens = commandTokens(command);
  for (const rawToken of tokens) {
    const token = rawToken.replace(/^["']|["']$/g, '');
    if (!token) continue;
    // Basename on both POSIX and Windows separators.
    const base = token.slice(Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\')) + 1);
    if (!base) continue;
    if (base === name) return true;
    if (base === `${name}.exe`) return true;
    for (const ext of SCRIPT_EXTENSIONS) {
      if (base === `${name}${ext}`) return true;
    }
  }
  return false;
}

/** Processes that may contain a client binary name but are never user CLI
 * sessions (Electron helper trees, MCP servers, plugin hosts, greps). */
const EXCLUSION_PATTERNS: RegExp[] = [
  /--type=/, // Electron renderer/utility/gpu subprocesses
  /\.app\/Contents\/(Frameworks|MacOS|Helpers)\//, // bundled app binaries (Claude Desktop etc.)
  / Helper(\.app|\s*\(|$)/, // "* Helper" / "* Helper (Renderer)"
  /mcp-server/,
  /\/plugins\//,
  /app-server-broker/,
  // `codex ... app-server` is the Codex Desktop host (ChatGPT.app code
  // mode) or AhaStation's own adapter child — never a user CLI session.
  // Desktop hosts are routed to detectCodexDesktopHostPids instead. Token
  // match: `app-server-broker` (above) must NOT match here.
  /(?:^|\s)app-server(?:\s|$)/,
  /^\s*(grep|rg)\b/, // the search that found the name
];

export function isExcludedCommand(command: string): boolean {
  return EXCLUSION_PATTERNS.some((pattern) => pattern.test(command));
}

/** Pids in the snapshot whose command runs any of `binaryNames`, after
 * applying the exclusion list. */
export function findClientPids(snapshot: ProcessSnapshot, binaryNames: string[]): number[] {
  const pids: number[] = [];
  for (const info of snapshot.byPid.values()) {
    if (isExcludedCommand(info.command)) continue;
    if (binaryNames.some((name) => cmdHasBinary(info.command, name))) {
      pids.push(info.pid);
    }
  }
  return pids;
}

/** Descendants of `pid` up to `maxDepth` levels (claude --resume double-
 * forks, so direct children alone are not enough). Cycle-protected: ps
 * output can contain a ppid loop on a racing process table. */
export function descendantsOf(
  snapshot: ProcessSnapshot,
  pid: number,
  maxDepth = 2,
): Set<number> {
  const found = new Set<number>();
  let frontier = [pid];
  const visited = new Set<number>([pid]);
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: number[] = [];
    for (const current of frontier) {
      for (const child of snapshot.childrenOf.get(current) ?? []) {
        if (visited.has(child)) continue;
        visited.add(child);
        found.add(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return found;
}

/** CPU signal: max %cpu over the two-level descendant tree. */
export function maxDescendantCpu(snapshot: ProcessSnapshot, pid: number): number {
  let max = 0;
  for (const child of descendantsOf(snapshot, pid, 2)) {
    const info = snapshot.byPid.get(child);
    if (info && info.cpuPct > max) max = info.cpuPct;
  }
  return max;
}

export interface ProcessFiles {
  cwd?: string;
  files: string[];
}

/** Parse `lsof -Fn -p <pids>` field output. Records are `p<pid>` /
 * `f<fd>` / `n<name>` lines; the cwd is the `n` line following `fcwd`.
 * Entries whose name carries a readlink permission error are dropped;
 * socket-style names (`->...`) are not files. */
export function parseLsofFieldOutput(text: string): Map<number, ProcessFiles> {
  const result = new Map<number, ProcessFiles>();
  let currentPid: number | null = null;
  let expectCwd = false;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      currentPid = Number(value);
      expectCwd = false;
      if (!result.has(currentPid)) result.set(currentPid, { files: [] });
      continue;
    }
    if (currentPid === null) continue;
    const entry = result.get(currentPid);
    if (!entry) continue;
    if (tag === 'f') {
      expectCwd = value === 'cwd';
      continue;
    }
    if (tag !== 'n') continue;
    if (value.includes('Permission denied')) {
      expectCwd = false;
      continue;
    }
    if (expectCwd) {
      entry.cwd = value;
      expectCwd = false;
      continue;
    }
    if (value.startsWith('->') || value === '(none)') continue;
    entry.files.push(value);
  }
  return result;
}

/** Platform file metadata for matched pids. Missing evidence stays unknown. */
export async function openFilesFor(
  pids: number[],
  execImpl: ExecImpl = defaultExec,
  platform: NodeJS.Platform = process.platform,
): Promise<Map<number, ProcessFiles>> {
  pids = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0).slice(0, 512);
  if (pids.length === 0 || platform === 'win32') return new Map();
  if (platform === 'linux') return readLinuxProcessFiles(pids);
  try {
    const { stdout } = await execImpl(
      'lsof',
      ['-Fn', '-p', pids.join(',')],
      { timeoutMs: LSOF_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER },
    );
    return parseLsofFieldOutput(stdout);
  } catch {
    return new Map();
  }
}

/** Bounded /proc traversal. Vanished processes, denied links and non-file fds stay unknown. */
export async function readLinuxProcessFiles(pids: number[], procRoot = '/proc'): Promise<Map<number, ProcessFiles>> {
  const result = new Map<number, ProcessFiles>();
  const queue = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0).slice(0, 512);
  const deadline = Date.now() + 2_000;
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
    while (queue.length && Date.now() < deadline) {
      const pid = queue.shift()!;
      const entry: ProcessFiles = { files: [] };
      try {
        const cwd = await fs.readlink(`${procRoot}/${pid}/cwd`);
        if (cwd.startsWith('/') && !cwd.endsWith(' (deleted)')) entry.cwd = cwd;
      } catch { /* Permission denied or process exited. */ }
      try {
        const dir = await fs.opendir(`${procRoot}/${pid}/fd`);
        let count = 0;
        for await (const fd of dir) {
          if (++count > 2_048 || Date.now() >= deadline) break;
          if (!/^\d+$/.test(fd.name)) continue;
          try {
            const file = await fs.readlink(`${procRoot}/${pid}/fd/${fd.name}`);
            if (file.startsWith('/') && !file.endsWith(' (deleted)')) entry.files.push(file);
          } catch { /* An individual fd may close while it is being inspected. */ }
        }
      } catch { /* An unreadable fd directory does not invalidate a known cwd. */ }
      result.set(pid, entry);
    }
  }));
  return result;
}
