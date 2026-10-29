// No model request, login, hook trust change or real HOME write. The optional
// binaries must be supplied explicitly. All config is under one temp root.
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { installGlobalHooks, uninstallGlobalHooks, probeCodexHooks } from '../dist-electron/global-hooks/installer.js';

const values = new Map();
for (let i = 2; i < process.argv.length; i += 2) values.set(process.argv[i], process.argv[i + 1]);
const binary = values.get('--codex-binary');
if (!binary) throw new Error('--codex-binary is required');
const root = mkdtempSync(join(tmpdir(), 'aha85-capability 中文 '));
const env = { ...process.env, CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
  HOME: root, USERPROFILE: root, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '',
  CLAUDE_CODE_OAUTH_TOKEN: '', CODEX_API_KEY: '', OTEL_SDK_DISABLED: 'true' };
let child;
const output = {};
try {
  mkdirSync(env.CODEX_HOME); mkdirSync(env.CLAUDE_CONFIG_DIR);
  output.codex = probeCodexHooks(binary, env.CODEX_HOME);
  if (values.has('--claude-binary')) output.claudeVersion = execFileSync(values.get('--claude-binary'), ['--version'], {
    encoding: 'utf8', env, timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const options = { agent: 'codex', configDir: env.CODEX_HOME, stateDir: join(root, 'state'), profileId: 'probe',
    nodePath: process.execPath, relayPath: resolve('dist-electron/global-hooks/relay.js'), version: 'probe-v1', codexBinary: binary };
  installGlobalHooks(options);
  child = spawn(binary, ['app-server'], { cwd: root, env, windowsHide: true });
  child.stderr.resume(); // avoid printing provider/config diagnostics
  let next = 0; const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (pending.has(message.id)) {
      const { yes, no, timer } = pending.get(message.id); pending.delete(message.id); clearTimeout(timer);
      if (message.error) no(new Error(`app-server-error:${message.error.code}`)); else yes(message.result);
    }
  });
  const rpc = (method, params) => new Promise((yes, no) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); no(new Error(`rpc-timeout:${method}`)); }, 5000);
    pending.set(id, { yes, no, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  await rpc('initialize', { clientInfo: { name: 'aha-hooks-isolated-probe', version: '1' },
    capabilities: { experimentalApi: true } });
  child.stdin.write('{"method":"initialized"}\n');
  const listed = await rpc('hooks/list', { cwds: [root] });
  output.discovered = listed.data.flatMap(entry => entry.hooks.map(hook => ({
    event: hook.eventName, enabled: hook.enabled, managed: hook.isManaged, trust: hook.trustStatus,
  })));
  output.discoveryErrors = listed.data.reduce((n, entry) => n + entry.errors.length, 0);
  if (output.discovered.length !== 4 || output.discoveryErrors !== 0) throw new Error('hook-discovery-failed');
  // Run the exact configured command through the target Windows default
  // command shell (and Node directly elsewhere), with the host absent.
  const config = JSON.parse(readFileSync(join(env.CODEX_HOME, 'hooks.json')));
  const command = config.hooks.PreToolUse[0].hooks[0].command;
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    const stdout = process.platform === 'win32'
      ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
        env, encoding: 'utf8', timeout: 2000, windowsHide: true,
        windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'], input: '{}',
      })
      : execFileSync(process.execPath, [options.relayPath, 'codex', join(options.stateDir, 'host.json'), 'observe'], {
        env, encoding: 'utf8', timeout: 2000, input: '{}',
      });
    if (stdout !== '') throw new Error('ordinary-hook-produced-output');
    samples.push(Math.round((performance.now() - start) * 10) / 10);
  }
  output.hostAbsentCommandWallMs = samples;
  output.hostAbsentMaxMs = Math.max(...samples);
  uninstallGlobalHooks(options);
  output.uninstalled = true;
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
} finally {
  if (child) {
    child.stdin.end();
    await new Promise(done => { child.once('close', done); setTimeout(() => { child.kill(); done(); }, 2000).unref(); });
  }
  if (!resolve(root).startsWith(resolve(tmpdir()) + '\\aha85-capability ')
    && !resolve(root).startsWith(resolve(tmpdir()) + '/aha85-capability ')) throw new Error('unexpected-probe-directory');
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
