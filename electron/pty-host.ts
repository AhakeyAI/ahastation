// pty-host.ts - generic PTY host shared by terminal-mode workers and the
// main-window shell terminal.
//
// Owns real interactive CLI/shell processes. Each PTY is keyed by a string id
// (a workerId for terminal workers, a generated id for shell terminals). Output
// is mirrored into a ~200KB ring buffer so the renderer can re-attach at any
// time and replay the recent screen history before streaming live data. The
// renderer never talks to the pty directly - ipc/worker-pty.ts (adapter-owned
// lifecycle) and ipc/shell-pty.ts (renderer-owned lifecycle) are the only
// bridges; the adapter is the only writer besides the user's keyboard.
//
// @lydell/node-pty ships prebuilt binaries (ConPTY on Windows), so no
// electron-rebuild step is needed. It is loaded lazily so unit tests can
// inject a fake spawn and never touch the native module.

import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { guardWindowsPtyStartup } from './windows-pty-startup.js';

const require_ = createRequire(import.meta.url);

/** Minimal surface of an IPty we rely on - matches @lydell/node-pty. */
export interface PtyProcess {
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  /** Release native handles after an externally confirmed owned-tree stop. */
  releaseAfterTreeExit?(): void;
  readonly pid: number;
  readonly startupError?: Error;
}

export type PtySpawn = (
  file: string,
  args: string[] | string,
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  },
) => PtyProcess;

export interface PtySpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

export const PTY_RING_BUFFER_MAX_BYTES = 200 * 1024;

/** Byte-bounded ring buffer of pty output chunks. Chunks are dropped whole
 *  from the front once the total exceeds the cap - a torn escape sequence at
 *  the replay start is harmless (xterm resynchronizes on the next frame). */
export class PtyRingBuffer {
  private chunks: Buffer[] = [];
  private totalBytes = 0;

  constructor(private readonly maxBytes: number = PTY_RING_BUFFER_MAX_BYTES) {}

  push(data: string | Buffer): void {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (buf.length === 0) return;
    this.chunks.push(buf);
    this.totalBytes += buf.length;
    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.totalBytes -= dropped.length;
    }
    // A single oversized chunk: keep only its tail.
    if (this.totalBytes > this.maxBytes && this.chunks.length === 1) {
      const only = this.chunks[0];
      this.chunks[0] = only.subarray(only.length - this.maxBytes);
      this.totalBytes = this.chunks[0].length;
    }
  }

  /** Full buffered history as one Buffer (for attach replay). */
  snapshot(): Buffer {
    return Buffer.concat(this.chunks);
  }

  get byteLength(): number {
    return this.totalBytes;
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}

interface LivePty {
  pty: PtyProcess;
  buffer: PtyRingBuffer;
  dataListeners: Set<(data: string) => void>;
  exitListeners: Set<(exitCode: number | null) => void>;
  disposables: Array<{ dispose(): void }>;
  exited: boolean;
  stopping: boolean;
}

function defaultPtySpawn(): PtySpawn {
  // Lazy so tests with an injected spawn never load the native module.
  const nodePty = require_('@lydell/node-pty') as {
    spawn: PtySpawn;
  };
  return process.platform === 'win32'
    ? (file, args, options) => guardWindowsPtyStartup(nodePty.spawn(file, args, options))
    : nodePty.spawn;
}

const CMD_META = /([()\[\]%!^"`<>&|;, *?])/g;

/** Quote for the native argv parser, then for both cmd.exe and the batch
 *  launcher's argument forwarding. The raw string bypasses node-pty's
 *  executable-style quoting, which is incompatible with cmd /s /c. */
function quoteBatchArgument(value: string): string {
  const quoted = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

/** Best-effort default interactive shell for the main-window shell terminal.
 *  Windows: PowerShell 7 (pwsh) -> Windows PowerShell -> cmd.exe; Unix:
 *  $SHELL -> /bin/bash. Probed once per create; any failure falls back to the
 *  platform default. Returns a full path on Windows so ConPTY need not search
 *  PATH (and .cmd/.bat shims never apply - shells are .exe). */
export function resolveDefaultShell(): string {
  if (process.platform === 'win32') {
    for (const candidate of ['pwsh', 'powershell']) {
      try {
        const out = execFileSync('where', [candidate], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 1_500,
          windowsHide: true,
        });
        const line = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        if (line) return line;
      } catch { /* not installed - try next */ }
    }
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

/** One pty per id. The caller (adapter or shell-pty IPC) owns the lifecycle
 *  (spawn/kill); the IPC layers only attach for data mirroring and forward
 *  keyboard input. */
export class PtyHost {
  private readonly sessions = new Map<string, LivePty>();
  private readonly spawnImpl: PtySpawn | null;

  constructor(opts: { spawn?: PtySpawn } = {}) {
    this.spawnImpl = opts.spawn ?? null;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  spawn(id: string, options: PtySpawnOptions): number {
    if (this.sessions.has(id)) {
      throw new Error(`pty '${id}' already has a live PTY`);
    }
    const spawnFn = this.spawnImpl ?? defaultPtySpawn();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.env)) {
      if (typeof v === 'string') env[k] = v;
    }
    let file = options.file;
    let args: string[] | string = options.args;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
      const command = [file.replace(CMD_META, '^$1'), ...options.args.map(quoteBatchArgument)].join(' ');
      file = env.ComSpec ?? env.COMSPEC ?? process.env.ComSpec ?? 'cmd.exe';
      args = `/d /s /v:off /c "${command}"`;
    }
    const pty = spawnFn(file, args, {
      name: 'xterm-256color',
      cols: options.cols ?? 100,
      rows: options.rows ?? 30,
      cwd: options.cwd,
      env,
    });
    const live: LivePty = {
      pty,
      buffer: new PtyRingBuffer(),
      dataListeners: new Set(),
      exitListeners: new Set(),
      disposables: [],
      exited: false,
      stopping: false,
    };
    live.disposables.push(pty.onData((data) => {
      live.buffer.push(data);
      for (const cb of live.dataListeners) {
        try { cb(data); } catch { /* listener must not break the stream */ }
      }
    }));
    live.disposables.push(pty.onExit(({ exitCode }) => {
      live.exited = true;
      for (const cb of live.exitListeners) {
        try { cb(exitCode); } catch { /* ignore */ }
      }
      this.dispose(id);
    }));
    this.sessions.set(id, live);
    return pty.pid;
  }

  write(id: string, data: string): boolean {
    const live = this.sessions.get(id);
    if (!live || live.exited || live.stopping) return false;
    live.pty.write(data);
    return true;
  }

  resize(id: string, rows: number, cols: number): boolean {
    const live = this.sessions.get(id);
    if (!live || live.exited || live.stopping) return false;
    const clamp = (n: number) => Math.min(500, Math.max(1, Math.floor(n) || 1));
    try {
      live.pty.resize(clamp(cols), clamp(rows));
      return true;
    } catch {
      return false;
    }
  }

  /** Buffered output snapshot for renderer re-attach replay. */
  replayBuffer(id: string): Buffer | null {
    const live = this.sessions.get(id);
    return live ? live.buffer.snapshot() : null;
  }

  /** Subscribe to live output. Returns an unsubscribe function. */
  onData(id: string, cb: (data: string) => void): () => void {
    const live = this.sessions.get(id);
    if (!live) return () => undefined;
    live.dataListeners.add(cb);
    return () => { live.dataListeners.delete(cb); };
  }

  /** Subscribe to pty exit. Returns an unsubscribe function. */
  onExit(id: string, cb: (exitCode: number | null) => void): () => void {
    const live = this.sessions.get(id);
    if (!live) return () => undefined;
    live.exitListeners.add(cb);
    return () => { live.exitListeners.delete(cb); };
  }

  kill(id: string, options?: { strict: boolean }): void {
    const live = this.sessions.get(id);
    if (!live) return;
    if (!live.exited) {
      try { live.pty.kill(); } catch (error) {
        if (options?.strict) throw error;
      }
    }
    this.dispose(id);
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  /** Daemon and terminal Workers opt into confirmed, owned-tree termination.
   * taskkill /T targets this still-owned live root, never a command name.
   * Keep subscriptions until ConPTY reports exit; kill() alone is no receipt. */
  async terminateTree(id: string): Promise<void> {
    const live = this.sessions.get(id);
    if (!live || live.exited) return;
    // Renderer keyboard IPC also writes through this owner, bypassing the
    // adapter's input queue. Revoke it before awaiting native teardown.
    live.stopping = true;
    let finish!: () => void;
    const exited = new Promise<void>(resolve => { finish = resolve; });
    const unsubscribe = this.onExit(id, finish);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.readyPid(id);
      if (process.platform === 'win32') {
        await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/pid', String(live.pty.pid), '/t', '/f'], { windowsHide: true, timeout: 10_000 });
        // taskkill confirms the owned OS tree; also release node-pty's ConPTY
        // handles and conout worker rather than retain them until daemon exit.
        if (live.pty.releaseAfterTreeExit) live.pty.releaseAfterTreeExit();
        else live.pty.kill();
      } else {
        live.pty.kill();
      }
      await Promise.race([exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for PTY exit')), 10_000);
      })]);
    } finally { clearTimeout(timer); unsubscribe(); }
  }

  /** Recent node-pty ConPTY connects asynchronously; spawn() may return pid=0.
   * Do not publish that placeholder as a stable process identity. */
  async readyPid(id: string): Promise<number> {
    const starting = this.sessions.get(id);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (starting?.pty.startupError) throw starting.pty.startupError;
      const live = this.sessions.get(id);
      if (!live || live.exited) throw new Error('PTY exited before startup completed');
      if (live.pty.pid > 0) return live.pty.pid;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('PTY process startup timed out');
  }

  private dispose(id: string): void {
    const live = this.sessions.get(id);
    if (!live) return;
    for (const d of live.disposables) {
      try { d.dispose(); } catch { /* ignore */ }
    }
    live.dataListeners.clear();
    live.exitListeners.clear();
    this.sessions.delete(id);
  }
}

let singleton: PtyHost | null = null;

export function getPtyHost(): PtyHost {
  if (!singleton) singleton = new PtyHost();
  return singleton;
}
