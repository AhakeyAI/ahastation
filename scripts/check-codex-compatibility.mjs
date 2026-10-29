import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { terminateProcessTree } from '../dist-electron/backends/process-tree.js';

function parseArgs(argv) {
  const options = { prefixArgs: [], timeoutMs: 20_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[++index];
    if (!value) throw new Error(`Missing value for ${arg}`);
    if (arg === '--binary') options.binary = value;
    else if (arg === '--expected-version') options.expectedVersion = value;
    else if (arg === '--out') options.out = value;
    else if (arg === '--prefix-arg') options.prefixArgs.push(value);
    else if (arg === '--timeout-ms') options.timeoutMs = Number(value);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.binary) throw new Error('--binary is required');
  return options;
}

export async function runCodexHandshake(options) {
  const codexHome = await mkdtemp(join(tmpdir(), 'ahastation-codex-compat-'));
  const startedAt = new Date().toISOString();
  let child;
  let stderr = '';
  try {
    child = spawn(options.binary, [...(options.prefixArgs ?? []), 'app-server', '--stdio'], {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const result = await new Promise((resolveHandshake, rejectHandshake) => {
      const timer = setTimeout(() => rejectHandshake(new Error('Codex initialize handshake timed out')), options.timeoutMs ?? 20_000);
      const lines = createInterface({ input: child.stdout });
      const finish = (callback, value) => {
        clearTimeout(timer);
        lines.close();
        callback(value);
      };
      lines.on('line', (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.id !== 1) return;
        if (message.error) finish(rejectHandshake, new Error(String(message.error.message ?? JSON.stringify(message.error))));
        else finish(resolveHandshake, message.result);
      });
      child.once('error', (error) => finish(rejectHandshake, error));
      child.once('exit', (code, signal) => finish(
        rejectHandshake,
        new Error(`Codex app-server exited before initialize (${String(code ?? signal)})`),
      ));
      child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000); });
      child.stdin.write(`${JSON.stringify({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'ahastation-compat', title: 'AhaStation compatibility check', version: '1' },
          capabilities: { experimentalApi: false, requestAttestation: false },
        },
      })}\n`);
    });
    const userAgent = String(result?.userAgent ?? '');
    const version = userAgent.match(/\/(\d+\.\d+\.\d+)(?:\s|\(|$)/)?.[1] ?? null;
    if (!version) throw new Error(`Codex initialize returned no stable runtime version: ${userAgent || 'empty userAgent'}`);
    if (options.expectedVersion && version !== options.expectedVersion) {
      throw new Error(`Codex version mismatch: expected ${options.expectedVersion}, got ${version}`);
    }
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    return {
      schemaVersion: 1,
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      binary: resolve(options.binary),
      version,
      userAgent,
      methods: ['initialize', 'initialized'],
      modelTurn: false,
      accountRead: false,
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      binary: resolve(options.binary),
      error: error instanceof Error ? error.message : String(error),
      stderr: stderr.trim() || undefined,
      methods: ['initialize'],
      modelTurn: false,
      accountRead: false,
    };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((done) => child.once('exit', done));
      terminateProcessTree(child);
      await Promise.race([exited, new Promise((done) => setTimeout(done, 2_000))]);
    }
    await rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runCodexHandshake(options);
  if (options.out) {
    await mkdir(dirname(resolve(options.out)), { recursive: true });
    await writeFile(options.out, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
