import { createServer, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { workReportSchema, type WorkReport } from './worker-protocol.js';

const requestSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('report'), report: workReportSchema }).strict(),
  z.object({ command: z.literal('ask'), question: z.string().trim().min(1).max(20_000) }).strict(),
  z.object({ command: z.literal('inbox'), after: z.number().int().nonnegative().default(0) }).strict(),
]);

export interface WorkerCliTarget {
  report(report: WorkReport): Promise<unknown>;
  ask(question: string): Promise<unknown>;
  inbox(after: number): Promise<unknown>;
}

export interface WorkerCliBinding {
  env: NodeJS.ProcessEnv;
  runtimeDir: string;
  prompt: string;
  dispose(): void;
}

/** One loopback service per scheduler; each credential addresses only its current Worker. */
export class WorkerCliBridge {
  private readonly targets = new Map<string, WorkerCliTarget>();
  private readonly server = createServer((req, res) => { void this.handle(req, res); });
  private listening: Promise<number> | undefined;

  private listen(): Promise<number> {
    return this.listening ??= new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        this.server.unref();
        const address = this.server.address();
        if (!address || typeof address === 'string') return reject(new Error('Worker bridge has no port'));
        resolve(address.port);
      });
    });
  }

  async bind(target: WorkerCliTarget): Promise<WorkerCliBinding> {
    const port = await this.listen();
    const token = randomBytes(32).toString('hex');
    const runtimeDir = await mkdtemp(join(tmpdir(), 'ahastation-worker-'));
    const reportFile = join(runtimeDir, 'report.json');
    try {
      await writeFile(join(runtimeDir, 'aha-worker.cmd'), '@echo off\r\n"%AHASTATION_WORKER_NODE%" "%AHASTATION_WORKER_ENTRY%" %*\r\n', { mode: 0o700 });
      await writeFile(join(runtimeDir, 'aha-worker'), '#!/bin/sh\nexec "$AHASTATION_WORKER_NODE" "$AHASTATION_WORKER_ENTRY" "$@"\n', { mode: 0o700 });
      await writeFile(reportFile, JSON.stringify({
        status: 'completed', summary: '', files: [], tests: [], unresolved: [],
      }, null, 2), { mode: 0o600 });
    } catch (error) {
      await rm(runtimeDir, { recursive: true, force: true });
      throw error;
    }
    this.targets.set(token, target);
    return {
      runtimeDir,
      env: {
        AHASTATION_WORKER_URL: `http://127.0.0.1:${port}/worker`,
        AHASTATION_WORKER_TOKEN: token,
        AHASTATION_WORKER_NODE: process.execPath,
        AHASTATION_WORKER_ENTRY: join(dirname(fileURLToPath(import.meta.url)), 'worker-cli.js'),
        AHASTATION_WORKER_REPORT: reportFile,
        AHASTATION_WORKER_BIN: runtimeDir,
      },
      prompt: [
        '\nYou are an AhaStation terminal Worker. Use aha-worker to communicate with your coordinator.',
        'Run `aha-worker inbox` at checkpoints and before reporting; replies and instructions appear there.',
        'For questions write {"question":"..."} to a JSON file in the runtime directory below, then run `aha-worker ask --file <file>`.',
        'Continue checking inbox for the reply. Do not paste questions only into this terminal.',
        `Runtime directory: ${runtimeDir}`,
        `Write your final WorkReport to: ${reportFile}, then run aha-worker report.`,
        'WorkReport JSON: {"status":"completed|partial|blocked","summary":"what changed and what remains","files":[{"path":"relative/path","action":"created|modified|deleted"}],"tests":[{"command":"actual command","status":"passed|failed|not-run"}],"unresolved":[{"code":"reason","message":"details","blocking":true}]}',
        'List every changed file, including deleted files. Do not commit changes; the coordinator freezes and reviews the worktree.',
        'Keep report/question files in the runtime directory, outside the project. Report actual test results only.',
        'After the report is accepted, stop editing and wait for user review. If the command fails, read its error and correct the report; do not claim it was delivered.',
      ].join('\n'),
      dispose: () => {
        this.targets.delete(token);
        void rm(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch((error) => {
          console.warn('[worker-cli] runtime cleanup failed:', error.message);
        });
      },
    };
  }

  close(): void {
    this.targets.clear();
    this.server.close();
    this.server.closeAllConnections();
  }

  private async handle(req: import('node:http').IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/worker') return reply(404, { ok: false, error: 'Unknown worker command' });
    const target = this.targets.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!target) return reply(401, { ok: false, error: 'Worker credential is unavailable or expired' });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) return reply(413, { ok: false, error: 'Worker request exceeds 1 MiB' });
        chunks.push(chunk);
      }
      const input = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const result = input.command === 'report' ? await target.report(input.report)
        : input.command === 'ask' ? await target.ask(input.question)
          : await target.inbox(input.after);
      reply(200, { ok: true, result });
    } catch (error) {
      reply(400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export function workerCliEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env.AHASTATION_WORKER_BIN) return env;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  const result = { ...env };
  if (pathKey && pathKey !== 'PATH') delete result[pathKey];
  result.PATH = `${env.AHASTATION_WORKER_BIN}${delimiter}${pathKey ? env[pathKey] ?? '' : ''}`;
  return result;
}
