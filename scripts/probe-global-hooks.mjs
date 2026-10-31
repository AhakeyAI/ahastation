// No model request, login, hook trust change or real HOME write. Use explicit
// binaries or --bundled (lockfile packages). All config is under one temp root.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { installGlobalHooks, uninstallGlobalHooks, probeCodexHooks } from '../dist-electron/global-hooks/installer.js';
import { GlobalHookHost } from '../dist-electron/global-hooks/host.js';
import { HOOK_EVENTS } from '../dist-electron/global-hooks/protocol.js';

const values = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (values.has(key) || !['--bundled', '--codex-binary', '--claude-binary'].includes(key)) throw new Error('invalid-probe-arguments');
  values.set(key, key === '--bundled' ? true : process.argv[++i]);
}
const platform = `${process.platform}-${process.arch}`;
const target = { 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl' }[platform];
const executable = name => `${name}${process.platform === 'win32' ? '.exe' : ''}`;
const binary = values.get('--codex-binary') ?? (values.has('--bundled') && target
  ? resolve('node_modules', '@openai', `codex-${platform}`, 'vendor', target, 'bin', executable('codex')) : null);
const claude = values.get('--claude-binary') ?? (values.has('--bundled')
  ? resolve('node_modules', '@anthropic-ai', `claude-agent-sdk-${platform}`, executable('claude')) : null);
if (!binary || !existsSync(binary) || (claude && !existsSync(claude))) throw new Error('probe-binaries-missing');
const root = mkdtempSync(join(tmpdir(), 'aha85-capability 中文 '));
// Ordinary-session fixture only; inherited AHA hints intentionally select deny.
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AHA_'))),
  CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
  HOME: root, USERPROFILE: root, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '',
  CLAUDE_CODE_OAUTH_TOKEN: '', CODEX_API_KEY: '', OTEL_SDK_DISABLED: 'true' };
// The installer's capability probe launches children from process.env too.
// Isolate this process as well as app-server and relay children.
for (const key of Object.keys(process.env)) if (key.startsWith('AHA_')) delete process.env[key];
Object.assign(process.env, env);
let child;
let host;
let lines;
const pending = new Map();
const output = { platform, evidence: 'discovery and command-shell relay; no native hook trust or model turn' };
const runCommand = (command, input, extraEnv = {}) => new Promise((yes, no) => {
  const start = performance.now(), windows = process.platform === 'win32';
  const proc = spawn(windows ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh',
    windows ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command],
    { env: { ...env, ...extraEnv }, cwd: tmpdir(), windowsHide: true, windowsVerbatimArguments: windows });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => { proc.kill(); no(new Error('relay-command-timeout')); }, 5000);
  proc.on('error', error => { clearTimeout(timer); no(error); });
  proc.stdin.on('error', () => {}); // no-host / deny may exit without reading
  proc.stdout.on('data', data => { stdout += data; });
  proc.stderr.on('data', data => { stderr += data; });
  proc.on('close', code => {
    clearTimeout(timer);
    if (code !== 0 || stderr !== '') no(new Error('relay-command-failed'));
    else yes({ stdout, ms: Math.round((performance.now() - start) * 10) / 10 });
  });
  proc.stdin.end(JSON.stringify(input));
});
const payload = event => ({ session_id: 'probe-session', hook_event_name: event,
  tool_name: 'Bash', turn_id: 'probe-turn', tool_use_id: 'probe-tool',
  cwd: 'PRIVATE_FIXTURE_PATH', tool_input: { command: 'PRIVATE_FIXTURE_COMMAND' } });
const summary = samples => ({ samples, min: Math.min(...samples), max: Math.max(...samples),
  median: [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)] });
try {
  mkdirSync(env.CODEX_HOME); mkdirSync(env.CLAUDE_CONFIG_DIR);
  output.codex = probeCodexHooks(binary, env.CODEX_HOME);
  const toml = join(env.CODEX_HOME, 'config.toml');
  const disabled = '[features]\nhooks = false\n';
  writeFileSync(toml, disabled);
  assert.throws(() => probeCodexHooks(binary, env.CODEX_HOME), /codex-hooks-disabled/);
  assert.equal(readFileSync(toml, 'utf8'), disabled);
  writeFileSync(toml, '[features]\nhooks = true\n');
  output.codexDisabledRefusedWithoutRewrite = true;
  if (claude) output.claudeVersion = execFileSync(claude, ['--version'], {
    encoding: 'utf8', env, timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (claude) assert.equal(output.claudeVersion, '2.1.150 (Claude Code)');
  const installations = [];
  for (const agent of claude ? ['codex', 'claude'] : ['codex']) {
    const options = { agent, configDir: agent === 'codex' ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR,
      stateDir: join(root, `${agent}-state`), profileId: 'probe', nodePath: process.execPath,
      relayPath: resolve('dist-electron/global-hooks/relay.js'), version: 'probe-v1', codexBinary: binary };
    const path = join(options.configDir, agent === 'codex' ? 'hooks.json' : 'settings.json');
    const original = '\uFEFF{\r\n  "hooks": {"Stop": [{"hooks": [{"type":"command","command":"echo user-hook"}]}]}\r\n}\r\n';
    writeFileSync(path, original);
    assert.equal(installGlobalHooks(options).status, 'installed');
    assert.equal(installGlobalHooks(options).status, 'unchanged');
    assert.equal(installGlobalHooks({ ...options, version: 'probe-v2' }).status, 'upgraded');
    const config = JSON.parse(readFileSync(path));
    assert.equal(config.hooks.Stop[0].hooks[0].command, 'echo user-hook');
    installations.push({ agent, options, path, original, config });
  }
  // hooks/list receives the isolated fixture explicitly. Keep the server cwd
  // at the stable temp parent so Windows helpers cannot pin the removable root.
  child = spawn(binary, ['app-server'], { cwd: tmpdir(), env, windowsHide: true });
  child.stderr.resume(); // avoid printing provider/config diagnostics
  let next = 0;
  child.on('error', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.no(new Error('app-server-start-failed')); }
    pending.clear();
  });
  lines = createInterface({ input: child.stdout });
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
  output.discovered = listed.data.flatMap(entry => entry.hooks).filter(hook =>
    hook.command?.includes('--aha-studio-global-hooks-v1')).map(hook => ({
    event: hook.eventName, enabled: hook.enabled, managed: hook.isManaged, trust: hook.trustStatus,
  }));
  output.discoveryErrors = listed.data.reduce((n, entry) => n + entry.errors.length, 0);
  // app-server uses lower camel case; hooks.json uses provider event names.
  assert.deepEqual(output.discovered.map(hook => hook.event).sort(),
    HOOK_EVENTS.map(event => event[0].toLowerCase() + event.slice(1)).sort());
  assert.equal(output.discoveryErrors, 0);
  assert.ok(output.discovered.every(hook => hook.enabled && !hook.managed && hook.trust === 'untrusted'));
  output.commandShell = {};
  for (const { agent, options, path, original, config } of installations) {
    const commands = HOOK_EVENTS.map(event => config.hooks[event].find(group =>
      group.hooks.some(hook => hook.command.includes('--aha-studio-global-hooks-v1'))).hooks[0].command);
    const rounds = [], samples = [];
    for (let round = 0; round < 5; round++) {
      const start = performance.now();
      for (let i = 0; i < HOOK_EVENTS.length; i++) {
        const result = await runCommand(commands[i], payload(HOOK_EVENTS[i]));
        assert.equal(result.stdout, ''); samples.push(result.ms);
      }
      rounds.push(Math.round((performance.now() - start) * 10) / 10);
    }
    let classification = 'user';
    host = new GlobalHookHost({ endpointPath: join(options.stateDir, 'host.json'), profileId: 'probe',
      deviceId: 'probe-device', classifyAuthorized: () => classification });
    await host.start();
    const present = [];
    for (let i = 0; i < HOOK_EVENTS.length; i++) {
      const result = await runCommand(commands[i], payload(HOOK_EVENTS[i]));
      assert.equal(result.stdout, ''); present.push(result.ms);
    }
    // Loss is allowed by the 40ms budget; record counts without pretending
    // every hook is guaranteed to arrive or widening the product budget.
    const delivered = host.getSnapshot().watermark;
    assert.ok(!JSON.stringify(host.getSnapshot()).includes('PRIVATE_FIXTURE'));
    classification = 'unresolved';
    assert.equal(host.getSnapshot().sessions.length, 0);
    for (let i = 0; i < HOOK_EVENTS.length; i++) {
      const result = await runCommand(commands[i], payload(HOOK_EVENTS[i]));
      assert.equal(result.stdout, '');
    }
    assert.ok(host.getSnapshot().sessions.every(session => session.subject.origin === 'unknown'));
    for (let i = 0; i < 2; i++) {
      const result = await runCommand(commands[i], payload(HOOK_EVENTS[i]), { AHA_RUNTIME_ID: 'unverified' });
      const deny = JSON.parse(result.stdout).hookSpecificOutput;
      assert.equal(i === 0 ? deny.permissionDecision : deny.decision.behavior, 'deny');
    }
    await host.stop(); host = undefined;
    const stopped = await runCommand(commands[0], payload('PreToolUse'));
    assert.equal(stopped.stdout, '');
    assert.equal(uninstallGlobalHooks(options).status, 'removed');
    assert.equal(readFileSync(path, 'utf8'), original);
    output.commandShell[agent] = { hostAbsentPerHookMs: summary(samples), hostAbsentFourHookCycleMs: summary(rounds),
      hostPresentPerHookMs: present, hostPresentDeliveredOfFour: delivered, stoppedHostMs: stopped.ms,
      unresolvedHasNoUserProjection: true, suspiciousInternalDenied: true, exactUninstall: true };
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
} finally {
  await host?.stop();
  for (const entry of pending.values()) clearTimeout(entry.timer);
  lines?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise(done => {
      const timer = setTimeout(() => child.kill(), 2000);
      child.once('close', () => { clearTimeout(timer); done(); });
      child.stdin.end();
    });
  }
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'aha85-capability ')) throw new Error('unexpected-probe-directory');
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
