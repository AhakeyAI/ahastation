import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { terminateProcessTree } from './process-tree.js';

export interface CodexAppServerNotification {
  method: string;
  params?: unknown;
}

export interface CodexAppServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface CodexAppServerReady {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
  account: Record<string, unknown>;
}

export const SUPPORTED_CODEX_APP_SERVER_VERSION = '0.156.1';

// A-14: the gate is a verified interval, not a single pinned version. Patch
// releases within the verified minor line are accepted; anything older or
// newer is rejected until the adapter contract is re-validated against it.
export const CODEX_APP_SERVER_MIN_VERSION = '0.156.1';
export const CODEX_APP_SERVER_MAX_EXCLUSIVE_VERSION = '0.157.0';

function compareCodexVersions(left: string, right: string): number {
  const a = left.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

export function isSupportedCodexAppServerVersion(version: string | null): boolean {
  if (!version) return false;
  return compareCodexVersions(version, CODEX_APP_SERVER_MIN_VERSION) >= 0
    && compareCodexVersions(version, CODEX_APP_SERVER_MAX_EXCLUSIVE_VERSION) < 0;
}

/** True when the subprocess env carries an explicit OpenAI-compatible API key. */
export function hasCodexApiKeyCredentials(env: NodeJS.ProcessEnv | undefined): boolean {
  return Boolean(String(env?.OPENAI_API_KEY ?? '').trim());
}

interface AppServerProcess {
  readonly pid?: number;
  stdin: { write(data: string): unknown; end?(): unknown };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface CodexAppServerTransportOptions {
  binaryPath: string;
  env: NodeJS.ProcessEnv;
  onNotification?: (notification: CodexAppServerNotification) => void;
  onRequest?: (request: CodexAppServerRequest) => Promise<unknown> | unknown;
  onStderr?: (line: string) => void;
  onExit?: (error: Error) => void;
  spawnProcess?: () => AppServerProcess;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Stable stdio JSON-RPC core for the locked Codex app-server runtime. */
export class CodexAppServerTransport {
  private process: AppServerProcess | null = null;
  private nextId = 0;
  private pending = new Map<number | string, PendingRequest>();
  private closing = false;
  private terminated = false;

  constructor(private readonly options: CodexAppServerTransportOptions) {}

  async start(): Promise<CodexAppServerReady> {
    if (this.process) throw new Error('Codex app-server already started');
    this.closing = false;
    this.terminated = false;
    this.process = this.options.spawnProcess?.() ?? spawn(
      this.options.binaryPath,
      ['app-server', '--stdio'],
      { env: this.options.env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const lines = createInterface({ input: this.process.stdout });
    lines.on('line', (line) => this.handleLine(line));
    this.process.stderr.on('data', (chunk: unknown) => this.options.onStderr?.(String(chunk)));
    this.process.on('error', (error: unknown) => this.handleExit(toError(error)));
    this.process.on('exit', (code: unknown, signal: unknown) => {
      if (this.closing) return;
      this.handleExit(new Error(`Codex app-server exited (${String(code ?? signal ?? 'unknown')})`));
    });

    const initialized = await this.request<Record<string, unknown>>('initialize', {
      clientInfo: { name: 'ahastation', title: 'AhaStation', version: '0.17.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    const userAgent = String(initialized.userAgent ?? '');
    const runtimeVersion = extractCodexRuntimeVersion(userAgent);
    if (!isSupportedCodexAppServerVersion(runtimeVersion)) {
      throw new Error(
        `Unsupported Codex app-server runtime ${runtimeVersion ?? 'unknown'}; `
        + `AhaStation supports >=${CODEX_APP_SERVER_MIN_VERSION} <${CODEX_APP_SERVER_MAX_EXCLUSIVE_VERSION}`,
      );
    }
    this.notify('initialized');
    const accountResult = await this.request<{ account: Record<string, unknown> | null; requiresOpenaiAuth: boolean }>(
      'account/read',
      { refreshToken: false },
    );
    const apiKeyConfigured = hasCodexApiKeyCredentials(this.options.env);
    if (accountResult.requiresOpenaiAuth && !accountResult.account && !apiKeyConfigured) {
      throw new Error('Codex authentication required');
    }
    if (!accountResult.account && !apiKeyConfigured) {
      throw new Error('Codex account is unavailable');
    }
    return {
      userAgent,
      codexHome: String(initialized.codexHome ?? ''),
      platformFamily: String(initialized.platformFamily ?? ''),
      platformOs: String(initialized.platformOs ?? ''),
      account: accountResult.account ?? { type: 'api_key' },
    };
  }

  async openThread(options: Record<string, unknown>): Promise<string> {
    const result = await this.request<{ thread: { id: string } }>('thread/start', options);
    if (!result.thread?.id) throw new Error('Codex app-server returned no thread id');
    return result.thread.id;
  }

  async resumeThread(threadId: string, options: Record<string, unknown>): Promise<string> {
    const result = await this.request<{ thread: { id: string } }>('thread/resume', { threadId, ...options });
    if (!result.thread?.id) throw new Error('Codex app-server returned no resumed thread id');
    return result.thread.id;
  }

  async startTurn(threadId: string, input: unknown[]): Promise<string> {
    const result = await this.request<{ turn: { id: string } }>('turn/start', { threadId, input });
    if (!result.turn?.id) throw new Error('Codex app-server returned no turn id');
    return result.turn.id;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId });
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.terminated = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Codex app-server closed'));
    }
    this.pending.clear();
    this.process?.stdin.end?.();
    if (this.process) terminateProcessTree(this.process);
    this.process = null;
  }

  private request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.process) return Promise.reject(new Error('Codex app-server is not running'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.options.requestTimeoutMs ?? 15_000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.process!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private notify(method: string, params?: unknown): void {
    this.process?.stdin.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.options.onStderr?.(`Invalid app-server JSON: ${line}`);
      return;
    }
    if (
      (typeof message.id === 'number' || typeof message.id === 'string')
      && typeof message.method !== 'string'
    ) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(appServerErrorMessage(message.error)));
      else request.resolve(message.result);
      return;
    }
    if (
      (typeof message.id === 'number' || typeof message.id === 'string')
      && typeof message.method === 'string'
    ) {
      const id = message.id;
      void Promise.resolve(this.options.onRequest?.({
        id,
        method: message.method,
        params: message.params,
      }))
        .then((result) => this.writeResponse(id, { result: result ?? {} }))
        .catch((error) => this.writeResponse(id, {
          error: { code: -32001, message: appServerErrorMessage(error) },
        }));
      return;
    }
    if (typeof message.method === 'string') {
      this.options.onNotification?.({ method: message.method, params: message.params });
    }
  }

  private writeResponse(
    id: number | string,
    response: { result?: unknown; error?: { code: number; message: string } },
  ): void {
    this.process?.stdin.write(`${JSON.stringify({ id, ...response })}\n`);
  }

  private handleExit(error: Error): void {
    if (this.terminated) return;
    this.terminated = true;
    this.process = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.options.onExit?.(error);
  }
}

export function extractCodexRuntimeVersion(userAgent: string): string | null {
  return userAgent.match(/\/(\d+\.\d+\.\d+)(?:\s|\(|$)/)?.[1] ?? null;
}

function appServerErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
