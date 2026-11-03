import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskMessage } from './task-collaboration.js';

export interface WorkerCliTaskIdentity {
  meetingId: string;
  taskId: string;
  workerId: string;
  attempt: number;
  workspaceCwd: string;
  terminalId: string;
}

export interface WorkerCliReportReceipt {
  reportId: string;
  candidateId: string | null;
  deliveryStatus?: string;
  taskId: string;
  attempt: number;
  status: 'received';
  duplicate: boolean;
}

export interface WorkerCliReportOutcome {
  receipt: WorkerCliReportReceipt;
  afterResponse?: () => void | Promise<void>;
}

export interface WorkerCliBridgeHandlers {
  report(identity: WorkerCliTaskIdentity, body: unknown): Promise<WorkerCliReportOutcome>;
  ask(identity: WorkerCliTaskIdentity, question: string): Promise<{ messageId: string; status: string }>;
  inbox(identity: WorkerCliTaskIdentity, afterSeq: number): Promise<TaskMessage[]>;
}

export interface WorkerCliBinding extends WorkerCliTaskIdentity {
  url: string;
  token: string;
  runtimeDir: string;
  binDir: string;
  entryPath: string;
  reportPath: string;
}

interface RegisteredEntry {
  tokenBuffer: Buffer;
  identity: WorkerCliTaskIdentity;
  runtimeDir: string;
  state: 'active' | 'reported' | 'stale';
  supersededByAttempt?: number;
}

const MAX_BODY_BYTES = 1024 * 1024;
const FORBIDDEN_TOOL_APPROVAL_KEYS = new Set([
  'permit',
  'permitid',
  'toolname',
  'toolinput',
  'approvalscope',
  'allow',
  'deny',
  'hookeventname',
  'pretooluse',
]);

function hasForbiddenToolApprovalField(value: Record<string, unknown>): string | null {
  for (const key of Object.keys(value)) {
    const normalized = key.replace(/[-_\s]/g, '').toLowerCase();
    if (FORBIDDEN_TOOL_APPROVAL_KEYS.has(normalized)) return key;
  }
  return null;
}

export class WorkerCliHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class WorkerCliBridge {
  private server: Server | null = null;
  private baseUrl: string | null = null;
  private startPromise: Promise<string> | null = null;
  private readonly entriesByToken = new Map<string, RegisteredEntry>();
  private readonly tokensByWorker = new Map<string, Set<string>>();

  constructor(private readonly handlers: WorkerCliBridgeHandlers) {}

  async register(identity: WorkerCliTaskIdentity): Promise<WorkerCliBinding> {
    const url = await this.ensureServer();
    // Mark any prior attempt token for this worker as stale (do NOT silently
    // reuse old credentials across attempts, and return an explicit stale-attempt
    // rejection if a lingering subprocess from attempt N calls back during attempt N+1).
    const existingTokens = this.tokensByWorker.get(identity.workerId) ?? new Set<string>();
    for (const oldToken of existingTokens) {
      const oldEntry = this.entriesByToken.get(oldToken);
      if (oldEntry && oldEntry.identity.attempt !== identity.attempt) {
        oldEntry.state = 'stale';
        oldEntry.supersededByAttempt = identity.attempt;
      } else if (oldEntry) {
        this.entriesByToken.delete(oldToken);
        existingTokens.delete(oldToken);
      }
    }

    const runtimeDir = await fs.mkdtemp(join(tmpdir(), 'ahastation-worker-cli-'));
    await fs.chmod(runtimeDir, 0o700).catch(() => undefined);
    const binDir = join(runtimeDir, 'bin');
    await fs.mkdir(binDir, { recursive: true, mode: 0o700 });
    const entryPath = fileURLToPath(new URL('./worker-cli.js', import.meta.url));
    await writeCliShims(binDir);

    const token = randomBytes(32).toString('hex');
    const normalizedIdentity: WorkerCliTaskIdentity = {
      meetingId: identity.meetingId,
      taskId: identity.taskId,
      workerId: identity.workerId,
      attempt: identity.attempt,
      workspaceCwd: resolve(identity.workspaceCwd),
      terminalId: identity.terminalId,
    };
    this.entriesByToken.set(token, {
      tokenBuffer: Buffer.from(token, 'utf8'),
      identity: normalizedIdentity,
      runtimeDir,
      state: 'active',
    });
    existingTokens.add(token);
    this.tokensByWorker.set(identity.workerId, existingTokens);

    return {
      ...normalizedIdentity,
      url,
      token,
      runtimeDir,
      binDir,
      entryPath,
      reportPath: join(runtimeDir, 'work-report.json'),
    };
  }

  markReported(workerId: string, attempt: number): void {
    const tokens = this.tokensByWorker.get(workerId);
    if (!tokens) return;
    for (const token of tokens) {
      const entry = this.entriesByToken.get(token);
      if (entry && entry.identity.attempt === attempt && entry.state === 'active') {
        entry.state = 'reported';
      }
    }
  }

  markStale(workerId: string, supersededByAttempt: number): void {
    const tokens = this.tokensByWorker.get(workerId);
    if (!tokens) return;
    for (const token of tokens) {
      const entry = this.entriesByToken.get(token);
      if (entry && entry.identity.attempt < supersededByAttempt) {
        entry.state = 'stale';
        entry.supersededByAttempt = supersededByAttempt;
      }
    }
  }

  async revokeWorker(workerId: string): Promise<void> {
    const tokens = this.tokensByWorker.get(workerId);
    if (!tokens) return;
    this.tokensByWorker.delete(workerId);
    const dirs: string[] = [];
    for (const token of tokens) {
      const entry = this.entriesByToken.get(token);
      this.entriesByToken.delete(token);
      if (entry) dirs.push(entry.runtimeDir);
    }
    await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)));
  }

  async close(): Promise<void> {
    const workers = [...this.tokensByWorker.keys()];
    await Promise.all(workers.map((workerId) => this.revokeWorker(workerId)));
    const server = this.server;
    this.server = null;
    this.baseUrl = null;
    this.startPromise = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }

  private ensureServer(): Promise<string> {
    if (this.baseUrl) return Promise.resolve(this.baseUrl);
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<string>((resolveStart, rejectStart) => {
      const server = createServer((req, res) => {
        void this.handle(req, res);
      });
      server.once('error', (err) => {
        this.startPromise = null;
        rejectStart(err);
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          rejectStart(new Error('worker CLI bridge failed to bind loopback port'));
          return;
        }
        this.server = server;
        server.unref();
        this.baseUrl = `http://127.0.0.1:${address.port}`;
        resolveStart(this.baseUrl);
      });
    });
    return this.startPromise;
  }

  private authenticate(req: IncomingMessage): RegisteredEntry | null {
    const header = req.headers.authorization ?? '';
    const candidate = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!candidate) return null;
    const candidateBuf = Buffer.from(candidate, 'utf8');
    for (const entry of this.entriesByToken.values()) {
      if (
        entry.tokenBuffer.length === candidateBuf.length
        && timingSafeEqual(entry.tokenBuffer, candidateBuf)
      ) {
        return entry;
      }
    }
    return null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const entry = this.authenticate(req);
    if (!entry) {
      sendJson(res, 401, { ok: false, code: 'unauthorized', error: 'invalid or revoked worker credential' });
      return;
    }
    if (entry.state === 'stale') {
      sendJson(res, 409, {
        ok: false,
        code: 'stale-attempt',
        error: `stale worker attempt ${entry.identity.attempt}; superseded by attempt ${entry.supersededByAttempt ?? 'next'}`,
      });
      return;
    }

    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/worker/report') {
        const body = await readJsonBody(req);
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          const record = body as Record<string, unknown>;
          if (typeof record.taskId === 'string' && record.taskId !== entry.identity.taskId) {
            throw new WorkerCliHttpError(
              400,
              'wrong-task',
              `report taskId '${record.taskId}' does not match bound task '${entry.identity.taskId}'`,
            );
          }
          if (typeof record.attempt === 'number' && record.attempt !== entry.identity.attempt) {
            throw new WorkerCliHttpError(
              409,
              'stale-attempt',
              `report attempt ${record.attempt} does not match bound attempt ${entry.identity.attempt}`,
            );
          }
        }
        const payload = unwrapReportBody(body);
        const outcome = await this.handlers.report(entry.identity, payload);
        if (entry.state === 'active') entry.state = 'reported';
        if (outcome.afterResponse) {
          res.once('finish', () => {
            const timer = setTimeout(() => {
              void Promise.resolve(outcome.afterResponse?.()).catch(() => undefined);
            }, 50);
            timer.unref?.();
          });
        }
        sendJson(res, 200, { ok: true, ...outcome.receipt, receipt: outcome.receipt });
        return;
      }

      if (entry.state !== 'active') {
        throw new WorkerCliHttpError(
          409,
          'attempt-closed',
          `worker attempt ${entry.identity.attempt} has already submitted its report`,
        );
      }

      if (req.method === 'POST' && url.pathname === '/worker/ask') {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new WorkerCliHttpError(400, 'invalid-question', 'ask payload must be a JSON object');
        }
        const forbidden = hasForbiddenToolApprovalField(body as Record<string, unknown>);
        if (forbidden) {
          throw new WorkerCliHttpError(
            400,
            'tool-approval-unsupported',
            `aha-worker ask is for task questions/blockers only; tool approval field '${forbidden}' is not accepted`,
          );
        }
        const question = typeof (body as { question?: unknown }).question === 'string'
          ? (body as { question: string }).question.trim()
          : '';
        if (!question) {
          throw new WorkerCliHttpError(400, 'invalid-question', 'question is required');
        }
        const result = await this.handlers.ask(entry.identity, question);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/worker/inbox') {
        const rawAfter = url.searchParams.get('after') ?? '0';
        const afterSeq = Number(rawAfter);
        if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
          throw new WorkerCliHttpError(400, 'invalid-cursor', 'after must be a non-negative integer');
        }
        const messages = await this.handlers.inbox(entry.identity, afterSeq);
        sendJson(res, 200, {
          ok: true,
          taskId: entry.identity.taskId,
          attempt: entry.identity.attempt,
          messages,
        });
        return;
      }

      sendJson(res, 404, { ok: false, code: 'not-found', error: 'unknown worker CLI route' });
    } catch (error) {
      if (error instanceof WorkerCliHttpError) {
        sendJson(res, error.statusCode, { ok: false, code: error.code, error: error.message });
        return;
      }
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'report-conflict') {
        sendJson(res, 409, {
          ok: false,
          code: 'report-conflict',
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (code === 'stale-attempt') {
        sendJson(res, 409, {
          ok: false,
          code: 'stale-attempt',
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      sendJson(res, 400, {
        ok: false,
        code: 'bad-request',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function unwrapReportBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if ('report' in record && record.report && typeof record.report === 'object') {
    return record.report;
  }
  const { taskId: _taskId, attempt: _attempt, ...rest } = record;
  return rest;
}

async function writeCliShims(binDir: string): Promise<void> {
  const posixPath = join(binDir, 'aha-worker');
  const winPath = join(binDir, 'aha-worker.cmd');
  await fs.writeFile(
    posixPath,
    '#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "$AHASTATION_WORKER_NODE" "$AHASTATION_WORKER_ENTRY" "$@"\n',
    { mode: 0o700 },
  );
  await fs.chmod(posixPath, 0o700).catch(() => undefined);
  await fs.writeFile(
    winPath,
    '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%AHASTATION_WORKER_NODE%" "%AHASTATION_WORKER_ENTRY%" %*\r\n',
  );
}

export function buildWorkerCliEnv(
  binding: WorkerCliBinding,
  baseEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {
    ...baseEnv,
    AHASTATION_WORKER_URL: binding.url,
    AHASTATION_WORKER_TOKEN: binding.token,
    AHASTATION_WORKER_NODE: process.execPath,
    AHASTATION_WORKER_ENTRY: binding.entryPath,
    AHASTATION_WORKER_REPORT: binding.reportPath,
    AHASTATION_WORKER_BIN: binding.binDir,
    AHASTATION_WORKER_MEETING_ID: binding.meetingId,
    AHASTATION_WORKER_TASK_ID: binding.taskId,
    AHASTATION_WORKER_ATTEMPT: String(binding.attempt),
    AHASTATION_MEETING_ID: binding.meetingId,
    AHASTATION_TASK_ID: binding.taskId,
    AHASTATION_ATTEMPT: String(binding.attempt),
  };
  const hasBasePath = Object.keys(baseEnv).some((key) => key.toLowerCase() === 'path');
  return hasBasePath ? workerCliEnvironment(merged) : merged;
}

export function workerCliEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const bin = env.AHASTATION_WORKER_BIN;
  if (!bin) return env;
  const next: NodeJS.ProcessEnv = { ...env };
  const pathKeys = Object.keys(next).filter((key) => key.toLowerCase() === 'path');
  const primaryKey = pathKeys[0] ?? 'PATH';
  const combinedParts: string[] = [bin];
  for (const key of pathKeys) {
    for (const seg of (next[key] ?? '').split(delimiter)) {
      if (seg && !combinedParts.includes(seg)) combinedParts.push(seg);
    }
  }
  const joined = combinedParts.join(delimiter);
  for (const key of pathKeys) {
    next[key] = joined;
  }
  next[primaryKey] = joined;
  next.PATH = joined;
  return next;
}

export function buildTerminalWorkerReportInstruction(
  taskId: string,
  attempt: number,
): string {
  return [
    '',
    `[AhaStation 原生任务通道 · task=${taskId} · attempt=${attempt}]`,
    '- 工具执行沿用当前 CLI 自身的权限与沙箱配置；无需向 Host 请求逐工具审批。',
    '- 有任务需求疑问或阻塞时，运行：`aha-worker ask "<问题或阻塞说明>"`（或 `--file <txt>`）；查看 Host 补充消息运行：`aha-worker inbox`。',
    '- 完成代码修改与测试后，保持工作树改动未提交（不要 git commit），将符合 WorkReport 结构的 JSON 写入 `$AHASTATION_WORKER_REPORT`（Windows 可用 `%AHASTATION_WORKER_REPORT%` 或 `--file <json路径>`），然后运行：`aha-worker report --file <json路径>`。',
    '- WorkReport JSON 结构：`{"status":"completed"|"partial"|"blocked","summary":"...","files":[{"path":"相对路径","action":"created"|"modified"|"deleted"}],"tests":[{"command":"...","status":"passed"|"failed"|"not-run","summary":"..."}],"unresolved":[{"code":"...","message":"...","blocking":false}]}`。',
    '- 只有 `aha-worker report` 返回 `received` 回执后，报告才算持久化提交；单纯进程退出或打印文本不会生成成功交付。',
  ].join('\n');
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new WorkerCliHttpError(413, 'payload-too-large', 'request body too large');
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new WorkerCliHttpError(400, 'invalid-json', 'request body must be valid JSON');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
