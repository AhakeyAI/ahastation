import { type PtyHost, type PtySpawnOptions } from './pty-host.js';
import { PtyInputLimiter } from './pty-input-limiter.js';

export interface TerminalRecord {
  terminalId: string;
  pid: number;
  startedAt: string;
  cwd: string;
  label: string;
  cols: number;
  rows: number;
  sequence: number;
  exited: boolean;
  exitCode?: number | null;
  terminationError?: string;
}
export interface TerminalData { ptyId: string; data: string; sequence: number }
export interface TerminalExit { ptyId: string; exitCode: number | null }
interface Session {
  record: TerminalRecord;
  replay?: string;
  limiter: PtyInputLimiter;
  unsubscribeData: () => void;
  unsubscribeExit: () => void;
}

/** Pure process owner shared by the existing main path and the isolated daemon.
 * Launch configuration (CLI discovery, app settings) belongs to the caller. */
export class TerminalSessions {
  private sessions = new Map<string, Session>();

  constructor(private host: PtyHost, private events: {
    data: (event: TerminalData) => void; exit: (event: TerminalExit) => void;
  }) {}

  create(ptyId: string, options: PtySpawnOptions, label = '', retainExit = true) {
    const existing = this.sessions.get(ptyId);
    if (existing) return this.snapshot(ptyId, existing);
    const pid = this.host.spawn(ptyId, options);
    const session: Session = {
      record: { terminalId: ptyId, pid, startedAt: new Date().toISOString(),
        cwd: options.cwd, label, cols: options.cols ?? 100, rows: options.rows ?? 30,
        sequence: 0, exited: false },
      limiter: new PtyInputLimiter(), unsubscribeData: () => {}, unsubscribeExit: () => {},
    };
    this.sessions.set(ptyId, session);
    session.unsubscribeData = this.host.onData(ptyId, (data) => {
      this.events.data({ ptyId, data: Buffer.from(data, 'utf8').toString('base64'), sequence: ++session.record.sequence });
    });
    session.unsubscribeExit = this.host.onExit(ptyId, (exitCode) => {
      session.replay = this.host.replayBuffer(ptyId)?.toString('base64') ?? '';
      session.record.exited = true;
      session.record.exitCode = exitCode;
      session.unsubscribeData();
      session.unsubscribeExit();
      if (!retainExit) this.sessions.delete(ptyId);
      this.events.exit({ ptyId, exitCode });
    });
    return this.snapshot(ptyId, session);
  }

  get(id: string) { const session = this.sessions.get(id); return session && this.snapshot(id, session); }
  async ready(ptyId: string) {
    const session = this.sessions.get(ptyId);
    if (!session) throw new Error('Unknown terminal');
    session.record.pid = await this.host.readyPid(ptyId);
    return this.snapshot(ptyId, session);
  }
  list(): TerminalRecord[] { return [...this.sessions.values()].map(s => ({ ...s.record })); }

  private snapshot(ptyId: string, session: Session) {
    return { ok: true as const, ptyId, ...session.record,
      replay: session.replay ?? this.host.replayBuffer(ptyId)?.toString('base64') ?? '' };
  }

  input(ptyId: string, data: string) {
    const session = this.sessions.get(ptyId);
    if (!session || session.record.exited) return { ok: false, error: '终端进程已结束' };
    if (!session.limiter.allow(Buffer.byteLength(data, 'utf8'))) {
      return { ok: false, error: 'PTY input rate/size limit exceeded', dropped: true };
    }
    return { ok: this.host.write(ptyId, data) };
  }

  resize(ptyId: string, rows: number, cols: number) {
    const session = this.sessions.get(ptyId);
    const ok = !!session && this.host.resize(ptyId, rows, cols);
    if (ok) { session.record.rows = Math.min(500, Math.max(1, Math.floor(rows) || 1));
      session.record.cols = Math.min(500, Math.max(1, Math.floor(cols) || 1)); }
    return { ok };
  }

  close(ptyId: string) {
    const session = this.sessions.get(ptyId);
    if (!session) return { ok: true };
    this.host.kill(ptyId, { strict: true });
    session.unsubscribeData(); session.unsubscribeExit(); this.sessions.delete(ptyId);
    return { ok: true };
  }

  /** Daemon stop keeps its exit record and waits for the native exit event. */
  async terminate(ptyId: string) {
    const session = this.sessions.get(ptyId);
    if (!session) throw new Error('Unknown terminal');
    if (session.record.terminationError) throw new Error(`Tree cleanup not confirmed: ${session.record.terminationError}`);
    if (!session.record.exited) {
      try { await this.host.terminateTree(ptyId); }
      catch (error) {
        // Root exit alone cannot certify a partially failed taskkill /T.
        session.record.terminationError = error instanceof Error ? error.message : 'Tree termination failed';
        throw error;
      }
    }
    if (!session.record.exited) throw new Error('PTY exit not confirmed');
    return this.snapshot(ptyId, session);
  }

  closeAll() { for (const id of this.sessions.keys()) this.close(id); }
}
