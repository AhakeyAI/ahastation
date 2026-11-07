import { closeSync, fsyncSync, openSync, writeFileSync, lstatSync, realpathSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { NativeWorkerRun, type NativeRunOptions, type NativeToolCall } from './run.js';
import { WindowsAppContainerGuard, type GuardMessage } from './windows-guard.js';
import { ensurePrivateHookDirectory } from '../global-hooks/file-security.js';
import { workReportSchema } from '../worker-protocol.js';

const callSchema = z.object({ invocationId: z.string().uuid(), stage: z.literal('PreToolUse'),
  sessionId: z.string().min(1).max(500), toolName: z.literal('Write'),
  input: z.object({ file_path: z.string().min(1).max(200), content: z.string().max(64 * 1024), cwd: z.string().min(1).max(4096) }).strict(),
}).strict();

/** Broker executes the approved bytes itself. It NEVER returns a native allow
 * to a CLI that could execute a different shell. First boundary supports only
 * creation of a single top-level UTF-8 file. Shell/network/edit/delete remain
 * unsupported, even if the authority layer would allow them.
 */
export class NativeWorkerBrokerChannel {
  readonly run: NativeWorkerRun;
  private started!: Promise<void>;
  private ready = false;
  private inflight = 0;
  private readonly calls = new Map<string, { call: NativeToolCall; expiresAt: number }>();
  private readonly created = new Map<string, string>();
  sessionId?: string;
  onDiagnostic?: (message: Record<string, unknown>) => void;
  constructor(readonly guard: WindowsAppContainerGuard, options: Omit<NativeRunOptions, 'guard'>) {
    const cwd = realpathSync.native(options.workspaceRoot);
    ensurePrivateHookDirectory(cwd);
    const binding = options.binding;
    this.run = new NativeWorkerRun({ ...options, guard });
    guard.onRequest(event => {
      // Bound concurrent work; do not serialize stop behind an unanswered ask.
      if (this.inflight >= 32) { void this.run.stop(); return; }
      this.inflight++;
      void this.started.then(() => this.receive(event, cwd, binding.attemptId)).catch(() => this.run.stop()).finally(() => this.inflight--);
    });
    guard.onLoss(() => { void this.run.stop(); });
    guard.onTreeExit(evidence => this.run.confirmTreeExit(evidence));
  }
  start(): Promise<void> { return this.started = this.run.start(); }
  input(value: unknown): boolean {
    return this.ready && this.run.input(this.run.basis(), 'host', JSON.stringify(value), this.guard.writerLease());
  }
  evidence() { return Object.fromEntries(this.created); }
  private async receive({ peer, message }: GuardMessage, cwd: string, attemptId: string): Promise<void> {
    const basis = message.basis as ReturnType<NativeWorkerRun['basis']>;
    if (message.op === 'bind') {
      this.run.bind(peer, String(message.sessionId), basis); this.ready = true; this.sessionId = String(message.sessionId);
      this.guard.reply({ bound: true, attemptId }); return;
    }
    if (message.op === 'probe-result' || message.op === 'response' || message.op === 'idle-child' || message.op === 'cli-version') {
      // Diagnostics cannot bind, approve, report completion or confirm exit.
      this.onDiagnostic?.(message); return;
    }
    const id = z.string().uuid().parse(message.id);
    if (message.op === 'ask') {
      for (const [key, pending] of this.calls) if (pending.expiresAt <= Date.now()) this.calls.delete(key);
      if (this.calls.size >= 32) { this.guard.reply({ id, permit: null }); return; }
      const call = callSchema.parse(message.call);
      if (call.input.cwd !== cwd || basename(call.input.file_path) !== call.input.file_path
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(call.input.file_path)
        || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,150}\.txt$/.test(call.input.file_path)) throw new Error('broker-target-rejected');
      const permit = await this.run.requestTool(peer, basis, call);
      if (permit) this.calls.set(permit.id, { call: structuredClone(call), expiresAt: permit.expiresAt });
      this.guard.reply({ id, permit }); return;
    }
    if (message.op === 'execute') {
      // No async point between consume and the sole side effect. stop runs on
      // this same event loop, sealing/revoking before any later callback.
      const call = callSchema.parse(message.call), permitId = z.string().uuid().parse(message.permitId);
      const approved = this.calls.get(permitId); this.calls.delete(permitId);
      if (!approved || JSON.stringify(call) !== JSON.stringify(approved.call) || !this.run.consume(peer, permitId, call)) {
        this.guard.reply({ id, executed: false }); return;
      }
      let executed = false;
      try {
        const currentRoot = realpathSync.native(cwd);
        if (currentRoot !== cwd || lstatSync(cwd).isSymbolicLink() || call.input.cwd !== cwd) throw new Error('workspace-replaced');
        // AppContainer cannot mutate this private broker-owned directory.
        // wx refuses existing files, links, junction targets and hardlinks.
        const fd = openSync(resolve(join(cwd, call.input.file_path)), 'wx', 0o600);
        try { writeFileSync(fd, call.input.content, 'utf8'); fsyncSync(fd); executed = true;
          this.created.set(call.input.file_path, createHash('sha256').update(call.input.content).digest('hex'));
        } finally { closeSync(fd); }
      } catch { /* ambiguous IO is never reported as completed */ }
      this.guard.reply({ id, executed }); return;
    }
    if (message.op === 'report') {
      const report = workReportSchema.parse(message.report);
      if (report.tests.some(t => t.status !== 'not-run')) throw new Error('no-test-execution-evidence');
      for (const file of report.files) {
        if (file.action !== 'created' || !this.created.has(file.path)
          || createHash('sha256').update(readFileSync(join(cwd, file.path))).digest('hex') !== this.created.get(file.path)) throw new Error('report-evidence-mismatch');
      }
      const receipt = await this.run.report(peer, basis, report);
      this.guard.reply({ id, receipt }); return;
    }
    throw new Error('unsupported-broker-operation');
  }
}
