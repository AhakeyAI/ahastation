// terminal-cli-adapter.ts — generic interactive-CLI-TUI Worker backend.
//
// One skeleton, many CLIs: Claude Code, Kimi Code, Codex, Qoder all ship an
// interactive TUI that can run inside a PtyHost pty as a human-supervised
// Worker. The scheduler's first sendUserText() — the compiled task prompt —
// is "typed" into the TUI as a bracketed paste, and the user can take over
// the keyboard at any time through the stage terminal (ipc/worker-pty.ts).
//
// A TUI has no machine-readable output channel, so every terminal backend
// deliberately emits only a thin signal stream:
//   - a Stop hook (registered per-session by the profile) appends one JSON
//     line per finished turn; the session tails that file and emits a
//     `progress` signal carrying TERMINAL_TURN_ENDED_MARKER. It must NEVER
//     emit `ended(completed)` — that would trip the scheduler's missing-report
//     recovery and paste the recovery prompt into the TUI.
//   - task completion/failure is decided by the USER in the renderer confirm
//     bar; the scheduler synthesizes the WorkReport (delivery/failed signal)
//     outside this adapter.
//
// Per-CLI differences (binary resolution, hook registration, model/approval
// flags, managed config homes) live in a `TerminalCliProfile`. Hookless CLIs
// (qoder) omit `registerTurnHook` — the confirm bar is then the only
// turn-ended signal, which is the designed fallback anyway.

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireNativeHookWorkerAdmission } from '../global-hooks/protocol.js';
import { getPtyHost, type PtyHost } from '../pty-host.js';
import { mergedSubprocessEnv } from '../settings-loader.js';
import { compileBackendTaskProfile, type BackendRuntime } from './task-profile.js';
import {
  normalizeBackendPermissionRequest,
  type NativePermissionRequest,
  type PermissionNormalizationResult,
} from './canonical-execution.js';
import type {
  BackendSession,
  BackendSessionConfig,
  BackendSessionEvent,
  BackendAuthConfig,
  BackendCapabilities,
  CliBackend,
  UserContentBlock,
} from './cli-backend.js';
import type {
  BackendEffectiveProfile,
  TaskExecutionProfile,
} from '../task-collaboration.js';

// ── Protocol constants (renderer mirrors these; keep stable) ────────────────

/** Prefix of the progress message emitted when the TUI finishes a turn
 *  (Stop hook). The renderer confirm bar keys on this marker. */
export const TERMINAL_TURN_ENDED_MARKER = '[terminal-turn-ended]';

export const TERMINAL_TURN_ENDED_MESSAGE =
  `${TERMINAL_TURN_ENDED_MARKER} 本轮对话已结束，等待人工确认：标记完成 / 继续指挥 / 标记失败。`;

/** Marker the terminal worker prints on its final reply when the task is
 *  fully done. The Stop hook scans the turn payload for this string and, on
 *  a hit, the adapter emits a completion progress (not a delivery) so the
 *  confirm bar lights up with a "task complete" prompt - the human reviews
 *  the TUI output and manually submits to the host. Must be distinct from
 *  TERMINAL_TURN_ENDED_MARKER, which fires every turn. */
export const TERMINAL_TASK_COMPLETE_MARKER = '[terminal-task-complete]';

export const TERMINAL_TASK_COMPLETE_MESSAGE =
  `${TERMINAL_TASK_COMPLETE_MARKER} 任务已完成，请查看上方输出并确认提交给 host。`;

/** Instruction appended to a terminal worker's first message telling it to
 *  emit the completion marker. Must live in the user prompt (firstMessage),
 *  not the system prompt - the TUI ignores systemPrompt. */
export const TERMINAL_WORKER_COMPLETION_INSTRUCTION =
  `\n\n任务全部完成时，在你最后一条回复里独占一行输出 ${TERMINAL_TASK_COMPLETE_MARKER}（只输出这个标记，不要加别的内容）。没完成绝不输出此标记。`;

/** Backend ids that run a human-supervised interactive TUI worker. The
 *  scheduler disables stall escalations for them and appends the completion
 *  instruction to their first message. */
export const TERMINAL_WORKER_BACKEND_IDS: ReadonlySet<string> = new Set([
  'claude-code-terminal',
  'kimi-code-terminal',
  'codex-terminal',
  'qoder-terminal',
]);

export function isTerminalWorkerBackend(backendId: string): boolean {
  return TERMINAL_WORKER_BACKEND_IDS.has(backendId);
}

/** Deterministic pty id for a terminal-mode HOST session (invited as a
 *  meeting participant, the TUI *is* the host). The orchestrator injects this
 *  as the session's workerId and the renderer mirrors it in
 *  src/lib/terminal-backends.ts to attach its RealTerminal — without a
 *  shared, predictable id the pty spawns under a random `terminal-<uuid>`
 *  that no one can ever attach to. Keep the two copies in sync. */
export function hostTerminalWorkerId(meetingId: string, hostId: string): string {
  return `host-terminal-${meetingId}-${hostId}`;
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** Bracketed-paste frame: the TUI treats the payload as one pasted block
 *  instead of interpreting newlines as submissions. The trailing \r that
 *  actually submits is written separately after a short settle delay. */
export function buildPasteFrame(text: string): string {
  return `${PASTE_START}${text}${PASTE_END}`;
}

// ── Auth-wall detection ─────────────────────────────────────────────────────

/** How long after spawn the session keeps scanning pty output for the CLI's
 *  login-gate screen. The gate only appears at startup, so a bounded window
 *  keeps false positives (task text mentioning 'sign in') effectively at
 *  zero while still covering slow cold starts. */
export const AUTH_WALL_WINDOW_MS = 60_000;

/** Rolling text buffer cap for auth-wall matching. A login gate is a single
 *  static frame of a few KB; 16KB of recent stripped output is plenty. */
const AUTH_WALL_BUFFER_MAX = 16 * 1024;

/** Strip ANSI escape sequences (CSI/OSC/charset/keypad) so login-gate text
 *  interrupted by styling or cursor moves still matches the profile pattern.
 *  \r becomes \n — TUIs repaint with carriage returns, and the profile
 *  patterns use \s+ which bridges the splits either way. */
/** TUIs often draw spaces as cursor-forward moves (CSI n C); turn those back
 *  into spaces before stripping so phrase patterns still match. */
export function toMatchableText(data: string): string {
  return stripAnsi(data.replace(/\x1b\[(\d*)C/g, (_m, n: string) => ' '.repeat(Math.min(Number(n || 1), 8))));
}

/** "Do you trust this folder?" style first-run dialogs (Claude Code, Codex…).
 *  Pasting the prompt there answers the dialog — Claude's default is "No,
 *  exit" — so the prompt waits until the user has answered (#125). */
export const TRUST_PROMPT_PATTERN = /trust\s*this\s*(folder|directory|workspace)|do\s*you\s*trust\s*the\s*(files|contents)|is\s*this\s*a\s*project\s*you\s*created/i;
const TRUST_SETTLE_MS = 800;

export function stripAnsi(data: string): string {
  return data
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI (incl. bracketed-paste marks)
    .replace(/\x1b[()][0-2]/g, '') // charset select
    .replace(/\x1b[=>]/g, '') // keypad modes
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/** Parse newly-appended turn-event lines. Fail-open per line: the hook file
 *  is append-only JSON-lines written by our own hook script, but a torn read
 *  mid-append must not break the tail loop. */
export function parseTurnEventLines(
  chunk: string,
): Array<{ kind: string; marker?: boolean; summary?: string }> {
  const events: Array<{ kind: string; marker?: boolean; summary?: string }> = [];
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { kind?: unknown; marker?: unknown; summary?: unknown };
      if (typeof parsed.kind === 'string') {
        const event: { kind: string; marker?: boolean; summary?: string } = { kind: parsed.kind };
        if (typeof parsed.marker === 'boolean') event.marker = parsed.marker;
        if (typeof parsed.summary === 'string') event.summary = parsed.summary;
        events.push(event);
      }
    } catch { /* torn line — wait for the next change event */ }
  }
  return events;
}

/** Shared Stop-hook script (CJS, run via `ELECTRON_RUN_AS_NODE=1
 *  process.execPath`). Reads the hook payload on stdin, looks for the
 *  completion marker in the last assistant message, and appends one JSON
 *  line to the per-session events file. Field extraction is deliberately
 *  tolerant: Claude Code, Kimi Code and Codex all pass a JSON context whose
 *  exact key for the last assistant text differs (`last_assistant_message`,
 *  `lastMessage`, …); anything unrecognized degrades to "no marker", which
 *  just means the generic turn-ended prompt shows instead of the
 *  task-complete one. */
export function buildStopHookScript(eventsPath: string): string {
  return [
    '// AhaStation terminal-worker Stop hook (auto-generated, safe to delete)',
    '// Reads stdin (Stop hook payload), checks the last assistant message for',
    '// the completion marker, and records marker+summary so the host app can',
    '// light up the confirm bar.',
    "const fs = require('fs');",
    `const MARKER = ${JSON.stringify(TERMINAL_TASK_COMPLETE_MARKER)};`,
    "let last = '';",
    'try {',
    '  const obj = JSON.parse(fs.readFileSync(0, "utf8") || "{}");',
    '  const m = obj.last_assistant_message ?? obj.lastMessage ?? obj.last_message ?? "";',
    '  last = typeof m === "string" ? m : (m ? JSON.stringify(m) : "");',
    '} catch (e) { /* malformed stdin - treat as no marker */ }',
    'const hit = last.includes(MARKER);',
    `fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ kind: 'stop', at: Date.now(), marker: hit, summary: hit ? last.slice(0, 20000) : '' }) + '\\n');`,
    '',
  ].join('\n');
}

// ── Session transcript tailing ─────────────────────────────────────────────

/** One parsed entry from the CLI's own session transcript file. */
export interface TerminalTranscriptEntry {
  /** Stable dedupe key (e.g. the transcript row uuid). */
  id: string;
  /** Visible assistant text ('' = nothing to surface for this entry). */
  text: string;
  /** True when this entry terminates a model turn. */
  turnEnded: boolean;
}

/** Hookless CLIs (qoder) have no Stop hook, but they DO persist a per-session
 *  transcript (jsonl) as turns complete. Tailing it lets the session speak:
 *  assistant text flows into the meeting chat and turn-status events clear
 *  the renderer's optimistic "thinking" indicator. Without this a terminal
 *  host is a black box whose answers exist only inside the TUI — the chat
 *  never syncs and the thinking bubble never clears. */
export interface TerminalTranscriptCandidate {
  /** Absolute path to a CLI transcript file. */
  path: string;
  /** True when the candidate is tied to this exact spawned process (for
   *  example via a PID-bearing diagnostic path). Untrusted fallback files
   *  must pass matchesPrompt before this session may claim them. */
  trusted?: boolean;
}

export interface TerminalSessionTranscriptSource {
  /** Re-resolve candidate files on every poll. This supports CLIs that create
   *  their session directory only after the TUI receives its first prompt. */
  resolveCandidates(
    config: BackendSessionConfig,
    processId: number,
  ): TerminalTranscriptCandidate[];
  /** Verify ownership of an untrusted fallback file using prompts that this
   *  session actually injected. Omit only when every candidate is trusted. */
  matchesPrompt?(line: string, sentPrompts: readonly string[]): boolean;
  /** Parse one transcript line; null = not an assistant entry worth
   *  surfacing (metadata rows, user echoes, tool plumbing). */
  parseLine(line: string): TerminalTranscriptEntry | null;
}

// ── Profile ──────────────────────────────────────────────────────────────────

export interface TerminalCliHookRegistration {
  /** Extra CLI args that register the hook (e.g. ['--settings', file]). */
  cliArgs: string[];
  /** Extra env entries for the spawned pty (e.g. a managed config home). */
  env?: NodeJS.ProcessEnv;
  /** Files the profile created; removed on end(). */
  cleanupPaths: string[];
}

export interface TerminalCliProfile {
  /** Backend id, e.g. 'claude-code-terminal', 'kimi-code-terminal'. */
  id: string;
  capabilities: BackendCapabilities;
  /** Human label for progress/error messages, e.g. 'Claude', 'Kimi'. */
  displayLabel: string;
  /** Resolve the CLI binary; null = not installed. */
  resolveBinary: () => string | null;
  /** Extra CLI args beyond hook registration (model flag, approval flags). */
  buildCliArgs?(config: BackendSessionConfig): string[];
  /** Extra env entries beyond hook registration (managed config homes). */
  buildEnv?(config: BackendSessionConfig): NodeJS.ProcessEnv;
  /** Register the per-session Stop-hook plumbing. The skeleton has already
   *  created `ahaDir`, truncated `eventsPath` and written `hookScriptPath`;
   *  the profile only wires the hook command into the CLI's own config
   *  mechanism. Omit for hookless CLIs — the renderer confirm bar is then
   *  the only turn-ended signal (the designed manual fallback). */
  registerTurnHook?(ctx: {
    config: BackendSessionConfig;
    ahaDir: string;
    suffix: string;
    eventsPath: string;
    hookScriptPath: string;
    /** Shell-quoted hook command: `"<execPath>" "<hookScriptPath>"`. */
    hookCommand: string;
  }): TerminalCliHookRegistration;
  /** Progress message emitted right after spawn. */
  startupMessage: string;
  /** Failure message when the CLI binary is missing. */
  missingBinaryMessage: string;
  /** Auth-wall detection for CLIs that draw a full-screen login gate when
   *  credentials are missing. Without this, the task prompt is pasted onto
   *  the login menu and silently swallowed — the worker hangs forever with
   *  zero events. When the (ANSI-stripped) pty output matches `pattern`
   *  within AUTH_WALL_WINDOW_MS of spawn, the session fails fast with code
   *  'auth-required' and stops injecting input. Omit for CLIs that handle
   *  auth non-modally. */
  authWall?: {
    pattern: RegExp;
    /** Failure message surfaced through the worker-failed signal. */
    message: string;
  };
  /** Gate the first paste on this pattern appearing in (ANSI-stripped) pty
   *  output. CLIs with a slow modal boot phase (token refresh, trust dialog)
   *  draw frames long before the input box exists — the first-frame
   *  heuristic then pastes into the void and the prompt is swallowed. When
   *  set, "first output" only counts once this pattern matches and the ready
   *  fallback stretches to READY_FALLBACK_PATTERN_MS. Pick the input-box
   *  placeholder or equivalent proof that typing is accepted; remember the
   *  TUI paints word-granularity runs, so allow \s* between words. */
  readyPattern?: RegExp;
  /** Optional bytes written after the bracketed-paste frame and before the
   *  actual submit key. Some TUIs keep pasted input isolated until bracketed
   *  paste mode is explicitly detached; putting Enter inside that frame (or
   *  replacing Enter with CSI-u) only edits the input instead of submitting. */
  beforeSubmitSequence?: string;
  /** Bytes that submit the prompt after the paste has settled. Default '\r'. */
  submitSequence?: string;
  /** Key written to the pty on interrupt(). Default: Esc ('\x1b'). */
  interruptKey?: string;
  /** Session transcript tailer for hookless CLIs — the only channel that
   *  lets their answers reach the meeting chat. Omit for CLIs whose hooks
   *  (or whose design) keep the confirm bar as the turn-end signal. */
  sessionTranscript?: TerminalSessionTranscriptSource;
  /** Map backend auth settings onto the subprocess env (api key, base url).
   *  Default: no auth mapping (the TUI owns login interactively). */
  applyAuth?(env: NodeJS.ProcessEnv, auth: BackendAuthConfig): void;
}

// ── Session ──────────────────────────────────────────────────────────────────

const READY_FALLBACK_MS = 5_000;
const READY_FALLBACK_PATTERN_MS = 30_000;
const READY_AFTER_FIRST_OUTPUT_MS = 1_600;
const READY_QUIESCE_MS = 2_500;
const READY_BUFFER_MAX = 8 * 1024;
const SUBMIT_DELAY_MS = 400;
/** The transcript tailer polls on a single cadence for the whole session:
 *  it both discovers newly-created or rotated transcript files and drains
 *  growth from every file it owns. We do
 *  NOT use fs.watch: macOS FSEvents can silently drop a change that lands
 *  within milliseconds of the watch being registered (verified empirically),
 *  and the dropped event may be the transcript's LAST append of the turn — a
 *  plain stat-short-circuited poll is both simpler and reliable. */
const TRANSCRIPT_POLL_MS = 1_500;
/** A transcript file is only adopted when modified at/after spawn (minus this
 *  clock-skew grace) — older files belong to previous sessions in the same
 *  cwd. */
const TRANSCRIPT_MTIME_GRACE_MS = 5_000;

export interface TerminalCliSessionDeps {
  host: PtyHost;
  resolveBinary: () => string | null;
  /** Test seam: skip the ready delays. */
  timersEnabled?: boolean;
}

export class TerminalCliSession implements BackendSession {
  private static readonly trustSessions = new Map<string, TerminalCliSession>();
  private readonly trustGeneration = randomUUID();
  static trustStatus(workerId: string) {
    const session = this.trustSessions.get(workerId);
    return session && !session.closed ? { ok: true, generation: session.trustGeneration, waiting: session.trustGated }
      : { ok: false, error: 'No current terminal session' };
  }
  static confirmTrust(workerId: string, generation: string) {
    const session = this.trustSessions.get(workerId);
    if (!session || session.closed || session.trustGeneration !== generation || !session.trustGated) {
      return { ok: false, error: 'Trust confirmation is stale' };
    }
    // Explicit local user action after answering the CLI dialog. Output text
    // disappearing, a timeout or an env hint cannot acknowledge trust.
    session.trustGated = false;
    session.trustBuffer = '';
    session.scheduleReady(TRUST_SETTLE_MS);
    return { ok: true };
  }
  private readonly profile: TerminalCliProfile;
  private readonly config: BackendSessionConfig;
  private readonly emit: (e: BackendSessionEvent) => void;
  private readonly deps: TerminalCliSessionDeps;
  readonly workerId: string;
  private readonly ahaDir: string;
  private readonly suffix: string;
  private readonly hookScriptPath: string;
  private readonly eventsPath: string;
  private profileCleanupPaths: string[] = [];
  private ready = false;
  private closed = false;
  private started = false;
  private authWallBuffer = '';
  private authWallDeadline = 0;
  private authWallEmitted = false;
  private readyBuffer = '';
  private readonly pendingTexts: string[] = [];
  private watcher: FSWatcher | null = null;
  private eventsOffset = 0;
  private transcriptPoll: ReturnType<typeof setInterval> | null = null;
  private transcriptProcessId: number | null = null;
  /** Owned transcript files -> byte offset already consumed (NOT a string
   *  offset — utf8 lengths diverge). A session tails every file its source
   *  resolves, so file rotation remains safe. */
  private readonly transcriptFiles = new Map<string, number>();
  private transcriptSpawnAt = 0;
  private readonly transcriptSeen = new Set<string>();
  private readonly transcriptPrompts = new Set<string>();
  private readonly transcriptOwnerId = randomUUID();
  /** Process-wide path ownership. The owner token is per BackendSession
   *  instance, so equal worker ids in different meetings cannot unlock or
   *  consume each other's transcript. A PID-trusted claim may supersede an
   *  earlier fallback claim before assistant output is drained. */
  private static readonly transcriptFileOwners = new Map<
    string,
    { ownerId: string; trusted: boolean }
  >();
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private firstOutputSeen = false;
  /** A trust dialog is up: never paste until it is answered. */
  private trustGated = false;
  private trustBuffer = '';
  private lastTrustSeenAt = 0;
  private unsubscribeData: (() => void) | null = null;
  private unsubscribeExit: (() => void) | null = null;

  constructor(
    profile: TerminalCliProfile,
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
    deps: TerminalCliSessionDeps,
  ) {
    this.profile = profile;
    this.config = config;
    this.emit = emit;
    this.deps = deps;
    const extraWorkerId = config.extra?.workerId;
    this.workerId = typeof extraWorkerId === 'string' && extraWorkerId.trim()
      ? extraWorkerId.trim()
      : `terminal-${randomUUID()}`;
    this.ahaDir = join(config.cwd, '.aha');
    this.suffix = this.workerId.replace(/[^a-zA-Z0-9._-]/g, '_');
    this.hookScriptPath = join(this.ahaDir, `terminal-stop-hook-${this.suffix}.cjs`);
    this.eventsPath = join(this.ahaDir, `terminal-turn-events-${this.suffix}.jsonl`);
  }

  async start(): Promise<void> {
    if (this.started || this.closed) return;
    // An installed global hook is not an execution guard. Controlled native
    // tasks stay closed until #86 proves launch binding and B04 S4-S6. Manual
    // terminal/host sessions retain the CLI's own permission flow.
    if (this.config.executionRole === 'worker' || this.config.taskProfile) {
      requireNativeHookWorkerAdmission();
    }
    this.started = true;
    const binary = this.deps.resolveBinary();
    if (!binary) {
      this.emit({
        kind: 'worker-signal',
        signal: {
          kind: 'failed',
          code: 'runtime-unavailable',
          message: this.profile.missingBinaryMessage,
          retryable: false,
        },
      });
      this.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'crashed' } });
      return;
    }

    // Stop hook plumbing: append-only events file + shared hook script.
    mkdirSync(this.ahaDir, { recursive: true });
    writeFileSync(this.eventsPath, '');
    this.eventsOffset = 0;
    writeFileSync(this.hookScriptPath, buildStopHookScript(this.eventsPath));
    this.profileCleanupPaths = [this.hookScriptPath, this.eventsPath];
    // process.execPath is Electron in the packaged app; ELECTRON_RUN_AS_NODE
    // (set on the pty env below) makes it act as plain node for the hook.
    const hookCommand = `"${process.execPath}" "${this.hookScriptPath}"`;
    const hookReg = this.profile.registerTurnHook?.({
      config: this.config,
      ahaDir: this.ahaDir,
      suffix: this.suffix,
      eventsPath: this.eventsPath,
      hookScriptPath: this.hookScriptPath,
      hookCommand,
    });
    if (hookReg) this.profileCleanupPaths.push(...hookReg.cleanupPaths);

    const env: NodeJS.ProcessEnv = {
      ...this.config.env,
      ELECTRON_RUN_AS_NODE: '1',
      ...hookReg?.env,
      ...this.profile.buildEnv?.(this.config),
    };
    const cliArgs = [
      ...(hookReg?.cliArgs ?? []),
      ...(this.profile.buildCliArgs?.(this.config) ?? []),
    ];
    // .cmd/.bat shims (npm global install on Windows) are not directly
    // spawnable by ConPTY — route them through cmd.exe.
    const isWinShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
    const file = isWinShim ? 'cmd.exe' : binary;
    const args = isWinShim ? ['/d', '/s', '/c', binary, ...cliArgs] : cliArgs;

    const processId = this.deps.host.spawn(this.workerId, {
      file,
      args,
      cwd: this.config.cwd,
      env,
    });
    TerminalCliSession.trustSessions.set(this.workerId, this);

    this.authWallDeadline = Date.now() + AUTH_WALL_WINDOW_MS;
    this.unsubscribeData = this.deps.host.onData(this.workerId, (data) => {
      this.scanForAuthWall(data);
      if (this.closed || this.ready) return;
      this.trustBuffer = (this.trustBuffer + toMatchableText(data)).slice(-8_000);
      if (TRUST_PROMPT_PATTERN.test(this.trustBuffer)) {
        if (!this.trustGated) {
          this.trustGated = true;
          if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
          this.emit({ kind: 'worker-signal', signal: { kind: 'progress', message: '等待你确认是否信任这个文件夹' } });
        }
        this.trustBuffer = '';
        this.lastTrustSeenAt = Date.now();
        return;
      }
      if (this.trustGated) {
        // Repaints and unrelated output cannot prove that the dialog was
        // accepted. Only the explicit generation-bound local action resumes.
        return;
      }
      if (this.profile.readyPattern) {
        // Pattern-gated: boot frames (token refresh, trust dialogs) are not
        // proof the input box exists — only the pattern is. But the pattern
        // appearing is not proof the TUI is DONE booting either: MCP/skills
        // loading and self-update notices keep repainting, and a paste
        // mid-repaint is swallowed (empirically ~50% at 13s post-spawn,
        // 0% once quiet). Wait for output to go quiet; every new frame
        // re-arms the quiesce timer via scheduleReady's clear-and-reset.
        this.readyBuffer = (this.readyBuffer + stripAnsi(data)).slice(-READY_BUFFER_MAX);
        if (!this.profile.readyPattern.test(this.readyBuffer)) return;
        this.scheduleReady(READY_QUIESCE_MS);
        return;
      }
      if (this.firstOutputSeen) return;
      this.firstOutputSeen = true;
      // The TUI draws its input box shortly after the first frame; give it a
      // beat before pasting so the prompt is not swallowed mid-init.
      this.scheduleReady(READY_AFTER_FIRST_OUTPUT_MS);
    });
    this.unsubscribeExit = this.deps.host.onExit(this.workerId, () => {
      if (this.closed) return;
      this.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'crashed' } });
    });
    // Fallback: paste anyway if the TUI stays quiet (e.g. output buffered).
    // Pattern-gated profiles get a longer leash: their boot phase (auth
    // token refresh) legitimately takes seconds before the input box is
    // drawn, and a 5s fallback would fire mid-boot and swallow the prompt.
    this.scheduleReady(
      this.profile.readyPattern ? READY_FALLBACK_PATTERN_MS : READY_FALLBACK_MS,
      true,
    );

    this.startTurnEventWatcher();
    this.startTranscriptTailer(processId);
    this.emit({
      kind: 'worker-signal',
      signal: { kind: 'progress', message: this.profile.startupMessage },
    });
  }

  private scheduleReady(delayMs: number, fallback = false): void {
    if (this.ready || this.closed || this.trustGated) return;
    if (this.readyTimer && !fallback) clearTimeout(this.readyTimer);
    else if (this.readyTimer && fallback) return; // first-output timer wins
    if (this.deps.timersEnabled === false) {
      this.markReady();
      return;
    }
    this.readyTimer = setTimeout(() => this.markReady(), delayMs);
    this.readyTimer.unref?.();
  }

  private markReady(): void {
    if (this.ready || this.closed || this.trustGated) return;
    this.ready = true;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    for (const text of this.pendingTexts.splice(0)) this.pasteIntoTui(text);
  }

  /** Fail fast when the pty shows the CLI's login gate. Runs before the
   *  first-output handler so detection is independent of the ready/paste
   *  path. Best-effort by design: a missed match degrades to the old silent
   *  behaviour, while a match converts an infinite hang into an actionable
   *  auth-required failure. */
  private scanForAuthWall(data: string): void {
    const wall = this.profile.authWall;
    if (!wall || this.authWallEmitted || this.closed) return;
    if (Date.now() > this.authWallDeadline) return;
    this.authWallBuffer = (this.authWallBuffer + stripAnsi(data)).slice(-AUTH_WALL_BUFFER_MAX);
    if (!wall.pattern.test(this.authWallBuffer)) return;
    this.authWallEmitted = true;
    this.emit({
      kind: 'worker-signal',
      signal: {
        kind: 'failed',
        code: 'auth-required',
        message: wall.message,
        retryable: false,
      },
    });
  }

  private pasteIntoTui(text: string): void {
    if (this.closed || this.authWallEmitted) return;
    if (this.profile.sessionTranscript) this.transcriptPrompts.add(text);
    this.deps.host.write(this.workerId, buildPasteFrame(text));
    const submitSeq = this.profile.submitSequence ?? '\r';
    const submit = () => {
      if (this.closed || this.trustGated || this.authWallEmitted || !this.ready) return;
      if (this.profile.beforeSubmitSequence) {
        this.deps.host.write(this.workerId, this.profile.beforeSubmitSequence);
      }
      this.deps.host.write(this.workerId, submitSeq);
    };
    if (this.deps.timersEnabled === false) submit();
    else setTimeout(submit, SUBMIT_DELAY_MS).unref?.();
    // Transcript-tailed sessions own a started/completed pair: the tailer's
    // turnEnded entry closes what we open here. Other profiles stay out of
    // this state machine (their confirm bar is the turn-end signal).
    if (this.profile.sessionTranscript) {
      this.emit({ kind: 'turn-status', status: 'started' });
    }
  }

  private startTurnEventWatcher(): void {
    try {
      const watcher = watch(this.eventsPath, () => this.drainTurnEvents());
      // An FSWatcher 'error' with no listener is an uncaught exception that
      // takes down the main process. Windows raises EPERM when the watched
      // file's directory is removed, so degrade exactly like a failed start.
      watcher.on('error', () => {
        try { watcher.close(); } catch { /* already closed */ }
        if (this.watcher === watcher) this.watcher = null;
      });
      this.watcher = watcher;
    } catch {
      // Watcher failure degrades to "no turn-ended signal" — the terminal
      // stays fully usable; the user just confirms without the marker.
      this.watcher = null;
    }
  }

  private drainTurnEvents(): void {
    if (this.closed) return;
    let content: string;
    try {
      content = readFileSync(this.eventsPath, 'utf8');
    } catch {
      return;
    }
    if (content.length <= this.eventsOffset) return;
    const chunk = content.slice(this.eventsOffset);
    this.eventsOffset = content.length;
    for (const event of parseTurnEventLines(chunk)) {
      if (event.kind !== 'stop') continue;
      if (event.marker) {
        // Completion marker hit: the worker declared the task done. Don't
        // auto-submit - emit a completion progress so the confirm bar lights
        // up with a "task complete" prompt. The human reviews the TUI output
        // and clicks "标记完成" to submit the WorkReport to the host (manual
        // submit). The TUI stays open until then.
        this.emit({
          kind: 'worker-signal',
          signal: { kind: 'progress', message: TERMINAL_TASK_COMPLETE_MESSAGE },
        });
      } else {
        // No marker: turn ended without a completion declaration; let the
        // human decide (confirm bar fallback).
        this.emit({
          kind: 'worker-signal',
          signal: { kind: 'progress', message: TERMINAL_TURN_ENDED_MESSAGE },
        });
      }
    }
  }

  // ── Session transcript tailer ────────────────────────────────────────────

  /** Discover and tail the CLI's own per-session transcript file. Best
   *  effort by design: any failure degrades to "answers stay inside the
   *  TUI" (the pre-tailer behaviour) — the terminal stays fully usable. */
  private startTranscriptTailer(processId: number): void {
    if (!this.profile.sessionTranscript || this.transcriptPoll) return;
    this.transcriptProcessId = processId;
    this.transcriptSpawnAt = Date.now();
    // One poll for the whole session: discover newly-rotated files AND drain
    // growth from every file we own. See TRANSCRIPT_POLL_MS for why there is
    // no fs.watch.
    this.transcriptPoll = setInterval(() => this.scanTranscripts(), TRANSCRIPT_POLL_MS);
    this.transcriptPoll.unref?.();
    this.scanTranscripts();
  }

  /** Adopt candidate files created since spawn, then drain every file already
   *  owned by this exact BackendSession. PID-linked candidates are trusted;
   *  compatibility fallbacks must contain one of this session's prompts. */
  private scanTranscripts(): void {
    const source = this.profile.sessionTranscript;
    const processId = this.transcriptProcessId;
    if (!source || processId === null || this.closed) return;
    let candidates: TerminalTranscriptCandidate[];
    try {
      candidates = source.resolveCandidates(this.config, processId);
    } catch {
      candidates = [];
    }
    const uniqueCandidates = new Map(candidates.map((candidate) => [candidate.path, candidate]));
    for (const candidate of uniqueCandidates.values()) {
      const file = candidate.path;
      if (this.transcriptFiles.has(file)) continue;
      const owner = TerminalCliSession.transcriptFileOwners.get(file);
      if (
        owner
        && owner.ownerId !== this.transcriptOwnerId
        && (!candidate.trusted || owner.trusted)
      ) continue;
      let mtimeMs: number;
      try {
        mtimeMs = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < this.transcriptSpawnAt - TRANSCRIPT_MTIME_GRACE_MS) continue;
      if (!candidate.trusted && !this.transcriptFileMatchesPrompt(source, file)) continue;
      TerminalCliSession.transcriptFileOwners.set(file, {
        ownerId: this.transcriptOwnerId,
        trusted: candidate.trusted === true,
      });
      this.transcriptFiles.set(file, 0);
    }
    for (const file of this.transcriptFiles.keys()) {
      this.drainTranscriptFile(source, file);
    }
  }

  private transcriptFileMatchesPrompt(
    source: TerminalSessionTranscriptSource,
    file: string,
  ): boolean {
    if (!source.matchesPrompt || this.transcriptPrompts.size === 0) return false;
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      return false;
    }
    const prompts = Array.from(this.transcriptPrompts);
    return content.split('\n').some((line) => {
      try {
        return source.matchesPrompt?.(line, prompts) ?? false;
      } catch {
        return false;
      }
    });
  }

  private drainTranscriptFile(
    source: TerminalSessionTranscriptSource,
    file: string,
  ): void {
    const owner = TerminalCliSession.transcriptFileOwners.get(file);
    if (
      this.closed
      || !this.transcriptFiles.has(file)
      || owner?.ownerId !== this.transcriptOwnerId
    ) return;
    let buf: Buffer;
    try {
      // Short-circuit on size first: the poll fires every TRANSCRIPT_POLL_MS
      // for the whole session and transcripts can grow large — no size
      // change, no re-read. Sizes/offsets are tracked in BYTES (utf8 makes
      // string lengths diverge). A SHRUNK file means truncate/rebuild:
      // re-read from scratch and let transcriptSeen dedupe.
      const size = statSync(file).size;
      const offset = this.transcriptFiles.get(file) ?? 0;
      if (size === offset) return;
      if (size < offset) this.transcriptFiles.set(file, 0);
      buf = readFileSync(file);
    } catch {
      return;
    }
    const startOffset = this.transcriptFiles.get(file) ?? 0;
    const chunk = buf.subarray(startOffset).toString('utf8');
    // Only consume up to the last complete line — a torn tail row is
    // re-read once its append finishes.
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline < 0) return;
    const consumed = chunk.slice(0, lastNewline);
    this.transcriptFiles.set(
      file,
      startOffset + Buffer.byteLength(chunk.slice(0, lastNewline + 1), 'utf8'),
    );
    for (const line of consumed.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: TerminalTranscriptEntry | null = null;
      try {
        entry = source.parseLine(trimmed);
      } catch {
        entry = null; // a parser crash must not break the tail loop
      }
      if (!entry || this.transcriptSeen.has(entry.id)) continue;
      this.transcriptSeen.add(entry.id);
      if (entry.text) {
        this.emit({
          kind: 'message',
          message: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: entry.text }],
            },
          },
        });
      }
      if (entry.turnEnded) this.emit({ kind: 'turn-status', status: 'completed' });
    }
  }

  sendUserText(text: string): void {
    // Once the login gate was detected, injecting more text is pointless
    // (it lands on the auth menu) and its \r submit can even arm the
    // sign-in flow. Drop input; the scheduler disposes us via the failure.
    if (this.closed || this.authWallEmitted || !text) return;
    if (!this.ready) {
      this.pendingTexts.push(text);
      return;
    }
    this.pasteIntoTui(text);
  }

  sendUserContent(content: UserContentBlock[]): void {
    const text = content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
    if (text) this.sendUserText(text);
  }

  resolvePermission(): void {
    // Permissions are answered by the human inside the TUI itself.
  }

  async interrupt(): Promise<void> {
    // Esc is the native "stop this turn" key for every supported TUI.
    this.deps.host.write(this.workerId, this.profile.interruptKey ?? '\x1b');
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingTexts.length = 0;
    if (TerminalCliSession.trustSessions.get(this.workerId) === this) TerminalCliSession.trustSessions.delete(this.workerId);
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    this.unsubscribeData?.();
    this.unsubscribeExit?.();
    try { this.watcher?.close(); } catch { /* already closed */ }
    this.watcher = null;
    if (this.transcriptPoll) {
      clearInterval(this.transcriptPoll);
      this.transcriptPoll = null;
    }
    for (const file of this.transcriptFiles.keys()) {
      if (TerminalCliSession.transcriptFileOwners.get(file)?.ownerId === this.transcriptOwnerId) {
        TerminalCliSession.transcriptFileOwners.delete(file);
      }
    }
    this.transcriptFiles.clear();
    this.deps.host.kill(this.workerId);
    // Cleanup paths may include per-session managed config homes (dirs).
    for (const path of this.profileCleanupPaths) {
      try { rmSync(path, { force: true, recursive: true }); } catch { /* best effort */ }
    }
  }

  snapshot(): { protocol: string; sessionId: string } | null {
    return null;
  }
}

// ── Backend ──────────────────────────────────────────────────────────────────

export interface TerminalCliBackendDeps {
  resolveBinary?: () => string | null;
  host?: PtyHost;
  timersEnabled?: boolean;
}

export class TerminalCliBackend implements CliBackend {
  readonly id: string;
  readonly capabilities: BackendCapabilities;
  protected readonly profile: TerminalCliProfile;
  private readonly deps: TerminalCliBackendDeps;

  constructor(profile: TerminalCliProfile, deps: TerminalCliBackendDeps = {}) {
    this.profile = profile;
    this.id = profile.id;
    this.capabilities = { ...profile.capabilities,
      executeTasks: ['claude-code-terminal', 'codex-terminal'].includes(profile.id) && profile.capabilities.executeTasks };
    this.deps = deps;
  }

  compileTaskProfile(
    requested: TaskExecutionProfile,
    runtime: BackendRuntime,
  ): BackendEffectiveProfile {
    return compileBackendTaskProfile(requested, runtime, {
      backendId: this.id,
      // Claude's terminal profile pins no default model on purpose: 'auto'
      // means no --model flag, so the CLI uses the account default.
      defaultModel: this.capabilities.defaultModel ?? 'auto',
      models: this.capabilities.models ?? [],
      // The TUI ignores mcp/systemPrompt/skills; surface that in the profile.
      unsupported: () => ['workMode'],
      downgraded: (profile) => [`workMode:${profile.workMode}->tui-interactive`],
    });
  }

  normalizePermissionRequest(
    native: NativePermissionRequest,
  ): PermissionNormalizationResult {
    // The TUI answers permissions itself (human at the terminal), so this
    // backend never emits native permission requests - but the scheduler's
    // validateExecutionBackends requires the method to exist. Delegate to the
    // shared normalizer for contract compliance.
    return normalizeBackendPermissionRequest(this.id, native);
  }

  createSession(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ): BackendSession {
    return new TerminalCliSession(this.profile, config, emit, {
      host: this.deps.host ?? getPtyHost(),
      resolveBinary: () => this.resolveBinary(),
      timersEnabled: this.deps.timersEnabled,
    });
  }

  resolveBinary(): string | null {
    // An injected resolver (tests) is authoritative — even its null.
    if (this.deps.resolveBinary) return this.deps.resolveBinary();
    return this.profile.resolveBinary();
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    // The interactive TUI must see the user's real environment (HOME with
    // the CLI's own OAuth credentials) — no shadow-home isolation here. The
    // orchestrator already restores the real HOME for non-claude-code ids.
    const env: NodeJS.ProcessEnv = { ...mergedSubprocessEnv() };
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (typeof value === 'string') env[key] = value;
    }
    this.profile.applyAuth?.(env, auth);
    return env;
  }

  async validateAuth(): Promise<{ ok: boolean; error?: string }> {
    // Login state lives in the user's own CLI; the TUI prompts for auth
    // itself when needed, with the user right there to answer.
    return { ok: true };
  }

  async checkAuthStatus(): Promise<{ loggedIn: boolean }> {
    // The interactive TUI owns authentication: when not logged in, the CLI
    // prompts for login itself while the user watches the terminal.
    // Reporting logged-in here keeps the backend selectable in the planner
    // (the backend-auth list otherwise gates it behind 'needs-login').
    return { loggedIn: true };
  }
}
