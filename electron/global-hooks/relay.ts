import { readFileSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { denyHook, hasControlledHints, sanitizeHook, type HookAgent } from './protocol.js';

export const OBSERVE_BUDGET_MS = 40;
const MAX_INPUT = 1024 * 1024;

/** End-to-end relay budget includes stdin and connect, excludes Node startup.
 * No retries, DNS, child processes, transcript reads or stdout diagnostics. */
export async function runRelay(args: string[], env = process.env): Promise<void> {
  const deadline = performance.now() + OBSERVE_BUDGET_MS;
  const [agent, endpointPath, mode = 'observe', stage = 'PreToolUse'] = args;
  const controlled = mode !== 'observe' || hasControlledHints(env);
  if (controlled) {
    // No host response, owned.json record, env token or stale allow can turn
    // this into an executing Worker while the independent guard is absent.
    process.stdout.write(JSON.stringify(denyHook(stage)) + '\n');
    return;
  }
  if ((agent !== 'claude' && agent !== 'codex') || !endpointPath) return;
  let endpoint: { protocol: string; port: number; token: string; profileId: string };
  try {
    const stat = lstatSync(endpointPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) return;
    endpoint = JSON.parse(readFileSync(endpointPath, 'utf8'));
    if (endpoint.protocol !== 'aha.hooks.local.v1' || !Number.isInteger(endpoint.port)
      || endpoint.port < 1 || endpoint.port > 65535 || !/^[a-f0-9]{64}$/.test(endpoint.token)) return;
  } catch { return; } // Studio closed: do not even wait for stdin.
  const { request } = await import('node:http');
  await new Promise<void>(done => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    let req: ReturnType<typeof request> | undefined;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', finish);
      process.stdin.pause();
      req?.destroy();
      done();
    };
    const timer = setTimeout(finish, Math.max(0, deadline - performance.now()));
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_INPUT) finish(); else chunks.push(chunk);
    };
    const onEnd = () => {
      let input;
      try { input = sanitizeHook(agent as HookAgent, JSON.parse(Buffer.concat(chunks).toString('utf8')), crypto.randomUUID()); }
      catch { finish(); return; }
      if (!input) { finish(); return; }
      const body = JSON.stringify(input);
      req = request({ host: '127.0.0.1', port: endpoint.port, path: '/observe', method: 'POST',
        headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json',
          'content-length': Buffer.byteLength(body) },
      }, response => { response.resume(); finish(); });
      req.on('error', finish);
      req.end(body);
    };
    process.stdin.on('data', onData).once('end', onEnd).once('error', finish);
    process.stdin.resume();
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRelay(process.argv.slice(2)).then(() => process.exit(0), () => {
    if (process.argv[4] !== 'observe' || hasControlledHints(process.env)) {
      process.stderr.write('unsupported-contract\n'); process.exit(2);
    }
    process.exit(0);
  });
}
