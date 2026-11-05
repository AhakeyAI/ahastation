import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
  return value;
}

function positionalArgs(args: string[], flagsWithValues: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (flagsWithValues.includes(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) continue;
    out.push(arg);
  }
  return out;
}

/** The bridge binds to a random OS port on IPv4 loopback. Browser-style fetch
 * refuses some of those ports even when the server is ours. */
export async function requestWorkerBridge(
  url: string,
  options: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
    || !endpoint.port || endpoint.username || endpoint.password) {
    throw new Error('Worker bridge requires an explicit IPv4 loopback HTTP port');
  }
  const response = await new Promise<IncomingMessage>((resolveResponse, reject) => {
    const request = httpRequest(endpoint, {
      method: options.method ?? 'GET',
      headers: options.headers,
      agent: false,
    }, resolveResponse);
    request.once('error', reject);
    request.end(options.body);
  });
  response.setEncoding('utf8');
  let text = '';
  for await (const chunk of response) text += chunk;
  return new Response(text, { status: response.statusCode ?? 502 });
}

async function request(
  env: NodeJS.ProcessEnv,
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
): Promise<unknown> {
  const baseUrl = env.AHASTATION_WORKER_URL?.trim();
  const token = env.AHASTATION_WORKER_TOKEN?.trim();
  if (!baseUrl || !token) {
    throw new Error('AHASTATION_WORKER_URL and AHASTATION_WORKER_TOKEN are required');
  }
  const response = await requestWorkerBridge(`${baseUrl}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: { error?: unknown } | null = null;
  try {
    parsed = JSON.parse(text) as { error?: unknown };
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const message = typeof parsed?.error === 'string' && parsed.error
      ? parsed.error
      : (text.trim() || `worker request failed (${response.status})`);
    throw new Error(message);
  }
  return parsed ?? text;
}

export async function runWorkerCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  writeOut: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<void> {
  const [command, ...rest] = argv;
  if (command === 'report') {
    const file = readFlag(rest, '--file') ?? env.AHASTATION_WORKER_REPORT;
    if (!file) throw new Error('aha-worker report requires --file <path> or AHASTATION_WORKER_REPORT');
    const raw = await readFile(resolve(file), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`report file is not valid JSON: ${file}`);
    }
    const taskId = readFlag(rest, '--task');
    const attemptFlag = readFlag(rest, '--attempt');
    const payload = (taskId || attemptFlag) && parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? {
          report: parsed,
          ...(taskId ? { taskId } : {}),
          ...(attemptFlag ? { attempt: Number(attemptFlag) } : {}),
        }
      : parsed;
    const receipt = await request(env, 'POST', '/worker/report', payload);
    writeOut(JSON.stringify(receipt));
    return;
  }

  if (command === 'ask') {
    const file = readFlag(rest, '--file');
    let question = '';
    if (file) {
      question = (await readFile(resolve(file), 'utf8')).trim();
    } else {
      question = positionalArgs(rest, ['--file']).join(' ').trim();
    }
    if (!question) {
      throw new Error('aha-worker ask requires a question string or --file <path>');
    }
    const receipt = await request(env, 'POST', '/worker/ask', { question });
    writeOut(JSON.stringify(receipt));
    return;
  }

  if (command === 'inbox') {
    const after = readFlag(rest, '--after') ?? '0';
    if (rest.includes('--saved')) {
      const directory = inboxDirectory(env);
      const batches = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const messages = new Map<string, { id: string; seq: number }>();
      for (const file of batches.filter((name) => /^[\w-]+\.json$/.test(name))) {
        const batch = JSON.parse(await readFile(resolve(directory, file), 'utf8')) as { messages: Array<{ id: string; seq: number }> };
        for (const message of batch.messages) if (message.seq > Number(after)) messages.set(message.id, message);
      }
      writeOut(JSON.stringify({ protocolVersion: 2, handled: 'unknown', messages: [...messages.values()].sort((a, b) => a.seq - b.seq) }));
      return;
    }
    const inbox = await request(env, 'GET', `/worker/inbox?after=${encodeURIComponent(after)}`);
    if (rest.includes('--receive')) {
      const batch = inbox as { protocolVersion?: number; batchId?: string; messages?: Array<{ id: string }> };
      if (batch?.protocolVersion !== 2 || !Array.isArray(batch.messages)
        || typeof batch.batchId !== 'string' || !/^[a-f0-9]{64}$/.test(batch.batchId)) {
        throw new Error('Worker inbox protocol 2 is required');
      }
      if (batch.messages.length) {
        const directory = inboxDirectory(env);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = resolve(directory, randomUUID());
        const file = await open(`${path}.tmp`, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify(batch), 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(`${path}.tmp`, resolve(directory, `${batch.batchId}.json`));
        await request(env, 'POST', '/worker/inbox/received', {
          batchId: batch.batchId, messageIds: batch.messages.map((message) => message.id),
        });
      }
    }
    writeOut(JSON.stringify(inbox));
    return;
  }

  throw new Error('usage: aha-worker <report [--file path] | ask [--file path | question] | inbox [--after seq] [--receive | --saved]>');
}

function inboxDirectory(env: NodeJS.ProcessEnv): string {
  if (env.AHASTATION_WORKER_INBOX_DIR) return resolve(env.AHASTATION_WORKER_INBOX_DIR);
  if (!env.AHASTATION_WORKER_RUNTIME_DIR) throw new Error('Worker inbox requires a bound runtime directory');
  return resolve(env.AHASTATION_WORKER_RUNTIME_DIR, 'inbox-received');
}

const isDirectEntry = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href,
);
if (isDirectEntry) {
  runWorkerCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
