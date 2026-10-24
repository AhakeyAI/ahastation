import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function runWorkerCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const [command, ...options] = args;
  if (!['report', 'ask', 'inbox'].includes(command)) {
    throw new Error('Usage: aha-worker report [--file report.json] | ask --file question.json | inbox [--after seq]');
  }
  if (options.length !== 0 && (options.length !== 2 || !options[1])) throw new Error('Expected one option and its value');
  let body: unknown;
  if (command === 'inbox') {
    if (options.length && options[0] !== '--after') throw new Error('inbox accepts --after');
    const after = Number(options[1] ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('--after must be a nonnegative integer');
    body = { command, after };
  } else {
    if (options.length && options[0] !== '--file') throw new Error(`${command} accepts --file`);
    const file = options[1] ?? (command === 'report' ? env.AHASTATION_WORKER_REPORT : undefined);
    if (!file) throw new Error('Missing JSON file');
    const payload = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    body = command === 'report' ? { command, report: payload } : { command, question: payload.question };
  }
  if (!env.AHASTATION_WORKER_URL || !env.AHASTATION_WORKER_TOKEN) throw new Error('No active AhaStation Worker context');
  const response = await fetch(env.AHASTATION_WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AHASTATION_WORKER_TOKEN}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json() as { ok: boolean; result?: unknown; error?: string };
  if (!response.ok || !result.ok) throw new Error(result.error ?? `Worker bridge returned ${response.status}`);
  return result.result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorkerCli(process.argv.slice(2)).then(
    (result) => { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); },
    (error) => { process.stderr.write(`aha-worker: ${error.message}\n`); process.exitCode = 1; },
  );
}
