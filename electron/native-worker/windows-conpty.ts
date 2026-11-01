import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import type { PtyProcess } from '../pty-host.js';
import { ensurePrivateHookDirectory } from '../global-hooks/file-security.js';
import type { ProcessIdentity } from './ownership.js';
import { Utf8Frames } from './utf8-frames.js';

/** Concrete OFFLINE startup seam. Not NativeExecutionGuard: it does not yet
 * authenticate hooks, separate model/tool egress or bind a Station owner.
 * Therefore neither admission nor the scheduler factory can activate it.
 * No personal config, login probe, general env or existing workspace input.
 */
export class WindowsConPtyProcess implements PtyProcess {
  readonly temporaryRoot = join(realpathSync.native(tmpdir()), `aha-conpty-${randomUUID()}`);
  readonly workspace = join(this.temporaryRoot, 'workspace');
  readonly home = join(this.temporaryRoot, 'home');
  private child!: ChildProcessWithoutNullStreams;
  private identity?: ProcessIdentity;
  private sealed = false;
  private resumed = false;
  private confirmed = false;
  private error?: Error;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number }) => void>();
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private finishStop!: (confirmed: boolean) => void;
  private readonly stopped = new Promise<boolean>(resolve => { this.finishStop = resolve; });
  private constructor() {}
  get pid(): number { return this.identity?.pid ?? 0; }
  get startupError(): Error | undefined { return this.error; }
  processIdentity(): ProcessIdentity {
    if (!this.identity) throw new Error('terminal-not-spawned');
    return { ...this.identity };
  }
  static async spawnOffline(config: { helperPath: string; helperSha256: string;
    imagePath: string; imageSha256: string; argv: string[] }): Promise<WindowsConPtyProcess> {
    if (process.platform !== 'win32') throw new Error('unsupported-conpty-platform');
    for (const [path, hash] of [[config.helperPath, config.helperSha256], [config.imagePath, config.imageSha256]]) {
      if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(hash)
        || createHash('sha256').update(readFileSync(path)).digest('hex') !== hash) throw new Error('terminal-image-mismatch');
    }
    if (!Array.isArray(config.argv) || config.argv.length > 128 || config.argv.some(arg => typeof arg !== 'string' || /\0/.test(arg))
      || config.argv.reduce((n, arg) => n + arg.length * 2 + 4, 0) > 28000) throw new Error('terminal-argv-rejected');
    const terminal = new WindowsConPtyProcess();
    ensurePrivateHookDirectory(terminal.temporaryRoot);
    const child = terminal.child = spawn(config.helperPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: process.env.LOCALAPPDATA } });
    child.stderr.resume();
    return new Promise((resolve, reject) => {
      const frames = new Utf8Frames(); let spawned = false;
      const timer = setTimeout(() => fail('terminal-spawn-timeout'), 10_000);
      const fail = (reason: string) => {
        clearTimeout(timer); terminal.error ??= new Error(reason); terminal.sealed = true;
        if (!child.stdin.writableEnded) child.stdin.end();
        if (!spawned) reject(terminal.error);
      };
      child.on('error', () => { fail('terminal-helper-unavailable'); terminal.finishStop(false); });
      child.stdin.on('error', () => fail('terminal-control-lost'));
      child.on('exit', () => { clearTimeout(timer); if (!terminal.confirmed) fail('terminal-tree-exit-unconfirmed'); terminal.finishStop(terminal.confirmed); });
      child.stdout.on('end', () => { try { frames.end(); } catch { fail('terminal-frame-invalid'); } });
      child.stdout.on('data', (bytes: Buffer) => {
        try {
          for (const line of frames.push(bytes)) {
            const event = JSON.parse(line);
            if (event.kind === 'spawned' && !spawned && event.suspended === true && event.network === 'none'
              && event.workspace === terminal.workspace && event.home === terminal.home
              && Number.isSafeInteger(event.pid) && event.pid > 0 && /^\d+$/.test(event.startId)
              && /^[a-f0-9-]{36}$/.test(event.bootId) && /^S-1-15-2-/.test(event.appContainerSid)) {
              terminal.identity = { pid: event.pid, startId: event.startId, bootId: event.bootId };
              spawned = true; clearTimeout(timer); resolve(terminal);
            } else if (event.kind === 'terminal-output' && terminal.matches(event)) {
              if (terminal.sealed) continue; // drain transport, no late display/input effects
              if (typeof event.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.data)) throw new Error();
              const text = terminal.decoder.decode(Buffer.from(event.data, 'base64'), { stream: true });
              for (const listener of terminal.dataListeners) { try { listener(text); } catch { /* display only */ } }
            } else if (event.kind === 'resumed' && terminal.matches(event) && terminal.resumed) {
              // OS acknowledgement only; never a native sessionId/trust receipt.
            } else if (event.kind === 'tree-exit' && terminal.matches(event) && event.confirmed === true && event.activeProcesses === 0) {
              if (terminal.confirmed) continue;
              terminal.sealed = true; terminal.confirmed = true; terminal.finishStop(true);
              for (const listener of terminal.exitListeners) { try { listener({ exitCode: 1 }); } catch { /* display only */ } }
            } else if (event.kind === 'fatal') {
              fail('terminal-helper-fatal');
            } else throw new Error();
          }
        } catch { fail('terminal-protocol-rejected'); }
      });
      terminal.send({ directory: terminal.temporaryRoot, terminal: { imagePath: config.imagePath,
        sha256: config.imageSha256, argv: config.argv } });
    });
  }
  private matches(event: ProcessIdentity): boolean {
    return !!this.identity && ['pid', 'startId', 'bootId'].every(key => event[key as keyof ProcessIdentity] === this.identity![key as keyof ProcessIdentity]);
  }
  private send(value: unknown): boolean {
    const frame = JSON.stringify(value) + '\n';
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded || this.child.exitCode !== null) return false;
    if (Buffer.byteLength(frame) + this.child.stdin.writableLength > 2 * 1024 * 1024) {
      this.sealed = true; this.child.stdin.end(); return false;
    }
    this.child.stdin.write(frame); return true;
  }
  /** Called only after the host attaches the suspended OS identity. This is
   * not a trust bypass or task-input admission. No implicit resume in adopt. */
  resume(): void {
    if (this.sealed || this.resumed || !this.identity || !this.send({ kind: 'resume' })) throw new Error('terminal-resume-rejected');
    this.resumed = true;
  }
  onData(listener: (data: string) => void) { this.dataListeners.add(listener); return { dispose: () => this.dataListeners.delete(listener) }; }
  onExit(listener: (event: { exitCode: number }) => void) { this.exitListeners.add(listener); return { dispose: () => this.exitListeners.delete(listener) }; }
  write(data: string): void {
    if (this.sealed || !this.resumed || Buffer.byteLength(data) > 128 * 1024
      || !this.send({ kind: 'terminal-input', data: Buffer.from(data).toString('base64') })) throw new Error('terminal-input-sealed');
  }
  resize(): void { /* fixed 100x30 offline primitive; no resize capability */ }
  kill(): void { this.sealed = true; this.send({ kind: 'stop' }); this.child.stdin.end(); }
  async terminateTree(): Promise<{ confirmed: boolean }> {
    if (this.confirmed) return { confirmed: true };
    this.kill();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return { confirmed: await Promise.race([this.stopped, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 7000); })]) }; }
    finally { clearTimeout(timer); }
  }
  /** Simulates host transport loss for an owned hidden fault test. */
  disconnectHostTransport(): void { this.sealed = true; this.child.stdin.end(); }
}
