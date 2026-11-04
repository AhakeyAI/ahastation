import { readFile } from 'node:fs/promises';
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
    const inbox = await request(env, 'GET', `/worker/inbox?after=${encodeURIComponent(after)}`);
    writeOut(JSON.stringify(inbox));
    return;
  }

  throw new Error('usage: aha-worker <report [--file path] | ask [--file path | question] | inbox [--after seq]>');
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
