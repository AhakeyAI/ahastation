import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { NativeExecutionGuard, RunBasis } from './run.js';
import type { ProcessIdentity, WorkerBinding } from './ownership.js';

export interface GuardMessage { peer: object; message: Record<string, unknown> }
/** First concrete boundary: Windows AppContainer, offline broker peer only.
 * The helper launches the bundled relay, NOT an unconfined native CLI/PTY.
 * CLI launch/ConPTY/network credential compatibility remains unadmitted.
 * The private inherited handle is a tree capability, not a claimed PID/token.
 * All descendants share exactly this run's authority; individual descendant
 * attribution is deliberately not claimed. Same-user debugger/admin is trusted.
 */
export class WindowsAppContainerGuard implements NativeExecutionGuard {
  private child?: ChildProcessWithoutNullStreams;
  private identity?: ProcessIdentity;
  private sealed = false;
  private launched = false;
  private readonly credential = randomBytes(32).toString('hex');
  private readonly hostWriter = Object.freeze({});
  private readonly peers = new WeakSet<object>();
  private readonly exits = new WeakSet<object>();
  private stopResult?: Promise<{ confirmed: boolean }>;
  private finishStop?: (result: { confirmed: boolean }) => void;
  private handler?: (event: GuardMessage) => void;
  private exitHandler?: (evidence: object) => void;
  private lossHandler?: () => void;
  constructor(private readonly config: { helperPath: string; helperSha256: string; directory: string;
    binding: WorkerBinding; sessionId: string; initialBasis: RunBasis; cliVersionProbe?: { path: string; sha256: string } }) {}
  onRequest(handler: (event: GuardMessage) => void) { this.handler = handler; }
  onTreeExit(handler: (evidence: object) => void) { this.exitHandler = handler; }
  onLoss(handler: () => void) { this.lossHandler = handler; }
  writerLease(): object { return this.hostWriter; }
  private send(kind: 'input' | 'reply' | 'stop', message?: unknown): boolean {
    if (!this.child || this.child.stdin.destroyed || this.child.stdin.writableEnded || this.child.exitCode !== null) return false;
    this.child.stdin.write(JSON.stringify({ kind, message }) + '\n'); return true;
  }
  async spawn(): Promise<ProcessIdentity> {
    if (process.platform !== 'win32' || this.launched || this.sealed) throw new Error('guard-launch-rejected');
    this.launched = true;
    // Installer/build-owned pinned helper; a manifest supplied by a Worker is
    // never an authorization source. No shell or PATH executable resolution.
    if (createHash('sha256').update(readFileSync(this.config.helperPath)).digest('hex') !== this.config.helperSha256) throw new Error('guard-helper-mismatch');
    const child = this.child = spawn(this.config.helperPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: process.env.LOCALAPPDATA } });
    child.stdin.on('error', () => this.lost());
    child.stderr.resume(); // no untrusted paths/credentials in diagnostics
    child.stdin.write(JSON.stringify({ directory: this.config.directory,
      ...(this.config.cliVersionProbe ? { cliPath: this.config.cliVersionProbe.path, cliSha256: this.config.cliVersionProbe.sha256 } : {}), hello: {
      credential: this.credential, basis: this.config.initialBasis, sessionId: this.config.sessionId } }) + '\n');
    return new Promise((resolve, reject) => {
      let buffer = '', settled = false;
      const timer = setTimeout(() => { reject(new Error('guard-spawn-timeout')); this.lost(); }, 10_000);
      const fail = () => { clearTimeout(timer); if (!settled) { settled = true; reject(new Error('guard-unavailable')); } this.lost(); };
      child.on('error', fail); child.on('exit', fail);
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { fail(); return; }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const event = JSON.parse(line);
            if (event.kind === 'spawned' && !this.identity && Number.isSafeInteger(event.pid) && event.pid > 0
              && /^\d+$/.test(event.startId) && /^[0-9a-f-]{36}$/.test(event.bootId) && /^S-1-15-2-/.test(event.appContainerSid)) {
              this.identity = { pid: event.pid, startId: event.startId, bootId: event.bootId };
              clearTimeout(timer); settled = true; resolve({ ...this.identity });
            } else if (event.kind === 'request' && !this.sealed && this.matches(event)) {
              const value = event.message;
              const actual = Buffer.from(typeof value?.credential === 'string' ? value.credential : '');
              const expected = Buffer.from(this.credential);
              if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { this.lost(); continue; }
              const peer = Object.freeze({}); this.peers.add(peer);
              const { credential: _secret, ...message } = value;
              this.handler?.({ peer, message });
            } else if (event.kind === 'tree-exit' && this.matches(event) && event.confirmed === true && event.activeProcesses === 0) {
              const evidence = Object.freeze({ ...this.identity }); this.exits.add(evidence);
              // A late spawn may share a stdout chunk with exit evidence.
              // Let NativeWorkerRun attach the OS identity before confirming.
              setImmediate(() => this.exitHandler?.(evidence)); this.finishStop?.({ confirmed: true });
            } else if (event.kind === 'fatal' || event.kind === 'stream-closed') fail();
          } catch { fail(); }
        }
      });
    });
  }
  private matches(value: ProcessIdentity) { return !!this.identity && ['pid', 'startId', 'bootId'].every(k => value[k as keyof ProcessIdentity] === this.identity![k as keyof ProcessIdentity]); }
  verifyPeer(peer: unknown, identity: ProcessIdentity, binding: WorkerBinding): boolean {
    return !this.sealed && !!peer && typeof peer === 'object' && this.peers.has(peer)
      && this.matches(identity) && Object.keys(this.config.binding).every(k => binding[k as keyof WorkerBinding] === this.config.binding[k as keyof WorkerBinding]);
  }
  verifyWriter(lease: unknown, writer: 'host' | 'human', basis: RunBasis): boolean {
    return !this.sealed && writer === 'host' && lease === this.hostWriter
      && JSON.stringify(basis) === JSON.stringify(this.config.initialBasis);
  }
  async handoffToHuman(): Promise<boolean> { return false; } // no ConPTY/human lease certified
  write(data: string, writer: 'host' | 'human'): boolean {
    if (this.sealed || writer !== 'host' || Buffer.byteLength(data) > 128 * 1024) return false;
    try { return this.send('input', JSON.parse(data)); } catch { return false; }
  }
  reply(value: unknown) { if (!this.sealed) this.send('reply', value); }
  seal(): void { this.sealed = true; }
  private lost() { const first = !this.sealed; this.seal(); if (this.child && !this.child.stdin.writableEnded) this.child.stdin.end(); if (first) this.lossHandler?.(); }
  disconnectHostTransport(): void { this.lost(); }
  async interrupt(): Promise<void> { this.send('stop'); }
  terminateTree(): Promise<{ confirmed: boolean }> {
    this.seal();
    if (!this.stopResult) this.stopResult = new Promise(resolve => {
      this.finishStop = resolve;
      const timer = setTimeout(() => resolve({ confirmed: false }), 7000);
      timer.unref();
      this.send('stop'); this.child?.stdin.end();
    });
    return this.stopResult;
  }
  verifyTreeExit(evidence: unknown, identity: ProcessIdentity): boolean {
    return !!evidence && typeof evidence === 'object' && this.exits.has(evidence) && this.matches(identity);
  }
}
