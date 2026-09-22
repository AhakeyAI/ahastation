// qoder-terminal-adapter.ts — interactive `qodercli` TUI as a Worker backend.
//
// Runs the user's own Qoder CLI inside a PtyHost pty (see the generic
// skeleton in terminal-cli-adapter.ts). Qoder has no hooks mechanism and
// `qodercli jobs` only tracks --worktree jobs (verified against
// qodercli 0.1.50-qw: interactive TUI sessions never appear there), so this
// backend registers NO Stop hook — the renderer confirm bar is the turn-end
// signal, which is the designed human fallback for every terminal backend.

import { accessSync, constants as fsConstants, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BackendCapabilities, BackendSessionConfig } from './cli-backend.js';
import { resolveBinaryFromPath } from './subprocess-backend.js';
import {
  TerminalCliBackend,
  type TerminalCliBackendDeps,
  type TerminalCliProfile,
  type TerminalTranscriptCandidate,
  type TerminalTranscriptEntry,
} from './terminal-cli-adapter.js';

const QODER_BUNDLED_BINARY =
  '/Applications/QoderWork.app/Contents/Resources/bin/qodercli';

const QODER_TERMINAL_CAPABILITIES: BackendCapabilities = {
  coordinate: false,
  executeTasks: true,
  displayName: 'Qoder (终端)',
  iconId: 'qoder',
  mcp: false,
  permissions: false,
  systemPrompt: false,
  skills: false,
  interrupt: true,
  defaultModel: 'auto',
  models: ['auto', 'efficient', 'lite', 'performance', 'ultimate'],
  installHint: '安装 QoderWork 桌面端（自带 qodercli），或将 qodercli 加入 PATH。',
};

/** Read-only tool allowlist for the 'read' approval tier. Tool names follow
 *  the Claude-compatible convention Qoder advertises; an unrecognized name
 *  simply means the TUI keeps asking, which is the safe direction. */
const QODER_READ_ONLY_TOOLS = 'Read,Grep,Glob,LS,WebFetch,WebSearch,TodoWrite';

export function resolveQoderBinary(): string | null {
  const fromPath = resolveBinaryFromPath('qodercli');
  if (fromPath) return fromPath;
  try {
    accessSync(QODER_BUNDLED_BINARY, fsConstants.X_OK);
    return realpathSync(QODER_BUNDLED_BINARY);
  } catch {
    return null;
  }
}

/** qodercli persists every interactive session as jsonl. Current layout:
 *  `~/.qoder/projects/<slug>/transcript/<sessionId>.jsonl`. Legacy layout:
 *  `~/.qoder/projects/<slug>/<sessionId>.jsonl` (pre-transcript-subdir). The
 *  slug replaces EVERY non-[a-zA-Z0-9-] character of the cwd with '-'
 *  (verified against the live directory: /Users/jiakun/cc_skills/x →
 *  -Users-jiakun-cc-skills-x, /Users/jiakun/.qoderwork-workspace →
 *  -Users-jiakun--qoderwork-workspace — separators are replaced per-char,
 *  never collapsed). */
export function qoderProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, '-');
}

function qoderHome(config: BackendSessionConfig): string {
  return typeof config.env?.HOME === 'string' && config.env.HOME
    ? config.env.HOME
    : homedir();
}

/** Resolve the path to a session's project transcript. Newer qodercli writes
 *  to `projects/<slug>/transcript/<id>.jsonl`; older versions used the slug
 *  root directly. Return the first that actually exists on disk; when neither
 *  does yet (early in startup) prefer the new layout. */
function resolveProjectTranscript(projectDir: string, sessionId: string): string {
  const newPath = join(projectDir, 'transcript', `${sessionId}.jsonl`);
  const legacyPath = join(projectDir, `${sessionId}.jsonl`);
  try { statSync(newPath); return newPath; } catch { /* */ }
  try { statSync(legacyPath); return legacyPath; } catch { /* */ }
  return newPath; // prefer new layout for not-yet-created files
}

/** Collect every *.jsonl inside the project dir (legacy) and its transcript/
 *  subdirectory (current layout). */
function listProjectTranscripts(projectDir: string): string[] {
  const results: string[] = [];
  const transcriptDir = join(projectDir, 'transcript');
  try {
    for (const name of readdirSync(transcriptDir)) {
      if (name.endsWith('.jsonl')) results.push(join(transcriptDir, name));
    }
  } catch { /* dir may not exist */ }
  try {
    for (const name of readdirSync(projectDir)) {
      if (name.endsWith('.jsonl')) results.push(join(projectDir, name));
    }
  } catch { /* */ }
  return results;
}

/** Resolve the transcript owned by this exact qodercli process. Qoder writes
 *  live diagnostics under logs/sessions/<slug>/<sessionId>/segments; each
 *  segment filename embeds the qodercli PID. The assistant content lives in
 *  projects/<slug>/transcript/<sessionId>.jsonl (current) or directly in
 *  projects/<slug>/<sessionId>.jsonl (legacy). The PID-bearing live path
 *  gives us a deterministic bridge to the content transcript. When no
 *  PID match exists, fall back to all project transcripts (prompt-verified
 *  before the generic tailer may claim them). */
export function resolveQoderTranscriptCandidates(
  config: BackendSessionConfig,
  processId: number,
): TerminalTranscriptCandidate[] {
  const home = qoderHome(config);
  const slug = qoderProjectSlug(config.cwd);
  const projectDir = join(home, '.qoder', 'projects', slug);
  const sessionsDir = join(home, '.qoder', 'logs', 'sessions', slug);
  const exact = new Set<string>();
  try {
    for (const session of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const segmentsDir = join(sessionsDir, session.name, 'segments');
      let segmentNames: string[];
      try {
        segmentNames = readdirSync(segmentsDir);
      } catch {
        continue;
      }
      if (segmentNames.some((name) => name.endsWith(`-p${processId}.jsonl`))) {
        exact.add(resolveProjectTranscript(projectDir, session.name));
      }
    }
  } catch {
    // The live diagnostic tree is created lazily after qodercli starts.
  }
  if (exact.size > 0) {
    return Array.from(exact, (path) => ({ path, trusted: true }));
  }

  return listProjectTranscripts(projectDir).map((path) => ({ path }));
}

/** Match an untrusted project transcript to a prompt injected by this
 *  BackendSession. The explicit bracketed-paste detach sequence is currently
 *  persisted by qodercli as a trailing control code, so strip only that known
 *  suffix before comparison. */
export function qoderTranscriptMatchesPrompt(
  line: string,
  sentPrompts: readonly string[],
): boolean {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return false;
  }
  const row = obj as { type?: unknown; message?: { content?: unknown } };
  if (row?.type !== 'user' || typeof row.message?.content !== 'string') return false;
  const content = row.message.content.replace(/\x1b\[\?2004[lh]$/u, '');
  return sentPrompts.some((prompt) => content === prompt);
}

/** Parse one qoder transcript row into a surfacable entry. Observed row
 *  shapes (qodercli 1.0.47): metadata rows (workspace-directories,
 *  runtime-config, ai-title, last-prompt) have no message body; user rows
 *  echo our own paste; assistant rows carry message.content blocks plus a
 *  stop_reason — 'end_turn' marks a finished turn, anything else
 *  (tool_use, pause, null) means the turn is still in flight. Thinking
 *  blocks are skipped: only text blocks reach the meeting chat. */
export function parseQoderTranscriptLine(line: string): TerminalTranscriptEntry | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null; // torn append — retried once the rest of the row lands
  }
  const row = obj as {
    type?: unknown;
    uuid?: unknown;
    message?: { content?: unknown; stop_reason?: unknown };
  };
  if (row?.type !== 'assistant') return null;
  if (typeof row.uuid !== 'string' || !row.uuid) return null;
  const content = row.message?.content;
  const text = Array.isArray(content)
    ? content
        .filter(
          (b): b is { type: string; text: string } =>
            !!b && typeof b === 'object'
            && (b as { type?: unknown }).type === 'text'
            && typeof (b as { text?: unknown }).text === 'string',
        )
        .map((b) => b.text)
        .join('\n')
        .trim()
    : '';
  return {
    id: row.uuid,
    text,
    turnEnded: row.message?.stop_reason === 'end_turn',
  };
}

export const QODER_TERMINAL_PROFILE: TerminalCliProfile = {
  id: 'qoder-terminal',
  capabilities: QODER_TERMINAL_CAPABILITIES,
  displayLabel: 'Qoder',
  resolveBinary: resolveQoderBinary,
  buildCliArgs: (config) => {
    const args: string[] = ['-w', config.cwd];
    if (config.model) args.push('--model', config.model);
    // Approval tiers (docs/research/qoder-cli-protocol.md): default = ask in
    // TUI; 'read' = read-only tool allowlist; 'all' = --yolo (skip all
    // permission checks).
    if (config.autoApproveScope === 'read') {
      args.push('--allowed-tools', QODER_READ_ONLY_TOOLS);
    } else if (config.autoApproveScope === 'all') {
      args.push('--yolo');
    }
    return args;
  },
  // No registerTurnHook: Qoder has no hooks — but it DOES write a per-
  // session jsonl transcript. Tailing it is what makes a qoder terminal
  // host audible: assistant text flows into the meeting chat (otherwise
  // answers exist only inside the TUI) and turn-status completed clears
  // the renderer's optimistic thinking bubble.
  sessionTranscript: {
    resolveCandidates: resolveQoderTranscriptCandidates,
    matchesPrompt: qoderTranscriptMatchesPrompt,
    parseLine: parseQoderTranscriptLine,
  },
  startupMessage: '终端 Qoder 已启动，任务提示词将自动注入 TUI。每轮结束后请在上方确认条人工确认。',
  missingBinaryMessage: '未找到 qodercli，可执行文件不在 PATH 上，也没有 QoderWork.app 内置版本。',
  // qodercli (observed on 1.0.47) draws a full-screen login gate when the
  // stored credential is gone: logo line "Not Login Please Auth" plus body
  // "Sign in to get started" / "1. Sign in to continue". The task prompt
  // paste lands on that menu and is silently swallowed — the worker then
  // idles forever with zero network activity. Fail fast instead.
  authWall: {
    // The TUI paints text in word-granularity runs wrapped in ANSI styling, so
    // the stripAnsi'd buffer arrives GLUED: "Signintogetstarted", "NoLogin
    // PlaseAuth" (the CLI even misspells "Please" as "Plase"). Whitespace-
    // tolerant \s* is required; "Please Auth" alone would false-positive on
    // task text, so the no-login anchor keeps the pl\w*auth tail.
    pattern: /no\s*login\s*pl\w*\s*auth|sign\s*in\s*to\s*get\s*started/i,
    message:
      'qodercli 未登录：终端停在 Sign in 登录页，任务提示词无法送达。请先在系统终端运行 qodercli 并完成登录，然后重试该任务。',
  },
  // Input-box placeholder — the only proof the TUI accepts typing. Even with
  // valid credentials, boot passes through an "Authenticating / Waiting for
  // authentication" phase for several seconds first; first-frame gating
  // pastes into that page and the prompt is swallowed (the worker then
  // idles on kevent forever with ESTABLISHED but inactive connections).
  // Painted glued: "Typeyourmessageor@path/to/file".
  readyPattern: /type\s*your\s*message/i,
  // qodercli 1.0.47 keeps pasted input isolated while bracketed paste mode is
  // active. Enter/CSI-u inside that mode only edits the input; detach first,
  // then send the default bare CR as a separate pty write to start the turn.
  beforeSubmitSequence: '\x1b[?2004l',
};

export class QoderTerminalBackend extends TerminalCliBackend {
  constructor(deps: TerminalCliBackendDeps = {}) {
    super(QODER_TERMINAL_PROFILE, deps);
  }
}
