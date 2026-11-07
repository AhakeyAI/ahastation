// mapping.ts — PID ↔ session association with three fallbacks, MCP
// suppression and self-exclusion.
//
// Fallback chain (abtop/codedash/purplemux consensus, plan §4.1.4):
//   1. command-line args (--session-id / --resume <id> / codex resume <id>
//      / --resume-session-id=<id>, both `=` and space forms)
//   2. Claude PID files ~/.claude/sessions/{pid}.json — the directory does
//      NOT exist on every version (this machine: absent), so it must
//      degrade silently; stale files are never deleted (TD-7)
//   3. Codex open rollout fd; then an unambiguous cwd/-C ↔ transcript cwd pair.
//
// MCP suppression: `codex mcp-server` holds fds on many historical
// rollouts; its pids and every rollout path it holds open are excluded,
// otherwise they surface as PID-less ghost sessions.
//
// Self-exclusion: the injected { pids, sessionIds } sets hide the app's
// own spawned workers — either a pid match or a session-id match excludes.

import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { commandTokens } from './process/command-line.js';
import type { ClientKind, ObservedFileSignal, SelfExclusion } from './types.js';
import {
  cmdHasBinary,
  type ProcessFiles,
  type ProcessSnapshot,
} from './process/snapshot.js';
import { asRecord, asString, lstatSafe, parseJsonLine } from './util.js';

// ---------------------------------------------------------------------------
// Fallback 1: command-line args
// ---------------------------------------------------------------------------

const SESSION_ID_CLASS = '[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4,12}){0,4}';
const SESSION_ID = new RegExp(`^${SESSION_ID_CLASS}$`);

/** Extract a session id from a client command line, or null. Both `--flag
 * <id>` and `--flag=<id>` forms are recognized. */
export function extractSessionIdFromCommand(command: string): string | null {
  const tokens = commandTokens(command);
  const ids = new Set<string>();
  for (let i = 1; i < tokens.length; i++) {
    const match = /^(--resume-session-id|--session-id|--resume)(?:=(.*))?$/.exec(tokens[i]);
    const value = match ? match[2] ?? tokens[++i] : tokens[i] === 'resume' ? tokens[++i] : undefined;
    if (value && SESSION_ID.test(value)) ids.add(value);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

/** Only an explicit absolute CLI directory is usable when the OS cannot report cwd. */
export function extractCwdFromCommand(command: string): string | null {
  const tokens = commandTokens(command);
  const dirs = new Set<string>();
  for (let i = 1; i < tokens.length; i++) {
    const match = /^(-C|--cd)(?:=(.*))?$/.exec(tokens[i]);
    if (!match) continue;
    const value = match[2] ?? tokens[++i];
    if (!value || !isAbsolute(value)) return null;
    // A Windows drive-relative/root-relative path needs cwd information we do not have.
    if (process.platform === 'win32' && !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value)) return null;
    dirs.add(value);
  }
  return dirs.size === 1 ? [...dirs][0] : null;
}

// ---------------------------------------------------------------------------
// Fallback 2: Claude PID files (may not exist — degrade, never delete)
// ---------------------------------------------------------------------------

export interface ClaudePidFileEntry {
  sessionId: string;
  cwd?: string;
}

export async function loadClaudePidFiles(homeDir: string, configDir = join(homeDir, '.claude')): Promise<Map<number, ClaudePidFileEntry>> {
  const result = new Map<number, ClaudePidFileEntry>();
  const dir = join(configDir, 'sessions');
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return result; // directory absent on this machine — expected, degrade
  }
  for (const file of files.slice(0, 2000)) {
    const match = /^(\d+)\.json$/.exec(file);
    if (!match) continue;
    const filePath = join(dir, file);
    const stat = await lstatSafe(filePath);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) continue;
    try {
      const parsed = asRecord(parseJsonLine(await fs.readFile(filePath, 'utf8')));
      const sessionId = asString(parsed?.sessionId);
      if (!sessionId) continue;
      result.set(Number(match[1]), { sessionId, cwd: asString(parsed?.cwd) });
    } catch {
      // Corrupt PID file: ignore it. Never delete — it is not ours (TD-7).
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// MCP suppression
// ---------------------------------------------------------------------------

/** Pids running `codex mcp-server` (binary match + subcommand). */
export function detectMcpServerPids(snapshot: ProcessSnapshot): number[] {
  const pids: number[] = [];
  for (const info of snapshot.byPid.values()) {
    if (/\bmcp-server\b/.test(info.command) && cmdHasBinary(info.command, 'codex')) {
      pids.push(info.pid);
    }
  }
  return pids;
}

/** Pids running the Codex Desktop host: a `codex` binary whose args carry
 * the exact token `app-server` (e.g. ChatGPT.app's
 * `Contents/Resources/codex -c features… app-server --analytics…`).
 * `app-server-broker` is a different process and must not match. AhaStation's
 * own adapter children (`codex app-server --stdio`) match too — callers must
 * subtract the self-exclusion pid set. */
export function detectCodexDesktopHostPids(snapshot: ProcessSnapshot): number[] {
  const pids: number[] = [];
  for (const info of snapshot.byPid.values()) {
    if (!cmdHasBinary(info.command, 'codex')) continue;
    const tokens = commandTokens(info.command);
    if (tokens.includes('app-server')) pids.push(info.pid);
  }
  return pids.sort((a, b) => a - b);
}

const ROLLOUT_PATH_PATTERN = /[\\/]\.codex[\\/]sessions[\\/].+\.jsonl$/;

/** Rollout file paths held open by the given (mcp-server) processes. */
export function mcpHeldRolloutPaths(
  lsofByPid: Map<number, ProcessFiles>,
  mcpPids: number[],
): Set<string> {
  const paths = new Set<string>();
  for (const pid of mcpPids) {
    const entry = lsofByPid.get(pid);
    if (!entry) continue;
    for (const file of entry.files) {
      if (ROLLOUT_PATH_PATTERN.test(file)) paths.add(file);
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Association
// ---------------------------------------------------------------------------

export interface Association {
  pid: number;
  via: 'cmd-args' | 'pid-file' | 'cwd' | 'fd';
}

export interface AssociateInput {
  clientKind: ClientKind;
  /** Candidate client process pids (already exclusion-filtered). */
  pids: number[];
  signals: ObservedFileSignal[];
  snapshot: ProcessSnapshot;
  lsofByPid: Map<number, ProcessFiles>;
  pidFileMap?: Map<number, ClaudePidFileEntry>;
  /** Pre-resolved realpath cache (macOS /var → /private/var). */
  realpathOf: (path: string) => string;
  selfExclusion: SelfExclusion;
}

/** Associate process pids to file signals, three fallbacks in order.
 * Returns nativeSessionId → association. A pid in the self-exclusion set
 * never associates; a session id in the self-exclusion set is dropped. */
export function associate(input: AssociateInput): Map<string, Association> {
  const associations = new Map<string, Association>();
  const byId = new Map(input.signals.map((signal) => [signal.nativeSessionId, signal]));
  const claimedPids = new Set<number>();
  const ambiguousPids = new Set<number>();

  const candidates = input.pids
    .filter((pid) => !input.selfExclusion.pids.has(pid))
    .sort((a, b) => a - b);

  const tryAssign = (pid: number, sessionId: string | undefined, via: Association['via']): boolean => {
    if (!sessionId || claimedPids.has(pid)) return false;
    if (input.selfExclusion.sessionIds.has(sessionId)) return false;
    if (associations.has(sessionId)) return false;
    if (!byId.has(sessionId)) return false;
    associations.set(sessionId, { pid, via });
    claimedPids.add(pid);
    return true;
  };

  // Fallback 1: command-line args (strongest evidence, checked first).
  for (const pid of candidates) {
    const command = input.snapshot.byPid.get(pid)?.command ?? '';
    const sessionId = extractSessionIdFromCommand(command);
    if (sessionId && !tryAssign(pid, sessionId, 'cmd-args')) ambiguousPids.add(pid);
  }

  // Fallback 2: Claude PID files.
  if (input.clientKind === 'claude-code' && input.pidFileMap) {
    for (const pid of candidates) {
      if (ambiguousPids.has(pid)) continue;
      tryAssign(pid, input.pidFileMap.get(pid)?.sessionId, 'pid-file');
    }
  }

  // Open rollout fds identify a session more precisely than its project directory.
  if (input.clientKind === 'codex') {
    const byPath = new Map(input.signals.map((signal) => [signal.filePath, signal]));
    for (const pid of candidates) {
      if (claimedPids.has(pid) || ambiguousPids.has(pid)) continue;
      const matches = new Set((input.lsofByPid.get(pid)?.files ?? []).map((file) => byPath.get(file)?.nativeSessionId).filter(Boolean));
      if (matches.size === 1) tryAssign(pid, [...matches][0], 'fd');
      if (matches.size > 1) ambiguousPids.add(pid);
    }
  }

  // Directory evidence is usable only for an unambiguous process/session pair.
  const byRealCwd = new Map<string, ObservedFileSignal[]>();
  for (const signal of input.signals) {
    const real = input.realpathOf(signal.cwd);
    const list = byRealCwd.get(real);
    if (list) list.push(signal);
    else byRealCwd.set(real, [signal]);
  }
  const pidsByCwd = new Map<string, number[]>();
  for (const pid of candidates) {
    if (claimedPids.has(pid) || ambiguousPids.has(pid)) continue;
    const command = input.snapshot.byPid.get(pid)?.command ?? '';
    // ps does not preserve argv quoting; a real OS cwd takes priority over parsed flags.
    const cwd = input.lsofByPid.get(pid)?.cwd ?? extractCwdFromCommand(command);
    if (!cwd) continue;
    const real = input.realpathOf(cwd);
    pidsByCwd.set(real, [...(pidsByCwd.get(real) ?? []), pid]);
  }
  for (const [cwd, pids] of pidsByCwd) {
    const matches = byRealCwd.get(cwd) ?? [];
    if (pids.length === 1 && matches.length === 1) tryAssign(pids[0], matches[0].nativeSessionId, 'cwd');
  }

  return associations;
}

/** Map key shared by mapping and correlate. */
export function associationKey(clientKind: ClientKind, nativeSessionId: string): string {
  return `${clientKind}:${nativeSessionId}`;
}
