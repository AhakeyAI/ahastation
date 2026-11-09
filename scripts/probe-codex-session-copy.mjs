// Opt-in native probe. Uses synthetic history and a private CODEX_HOME only;
// sends initialize + thread/fork + thread/read, never turn/start or user auth.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SessionCopyPreparer } from '../dist-electron/observe/session-copy.js';
import { ScanAccessStore, withinDirectory } from '../dist-electron/observe/scan-access.js';
import { extractCodexRuntimeVersion, isSupportedCodexAppServerVersion } from '../dist-electron/backends/codex-app-server-transport.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function probeCodexSessionCopy(binary) {
  if (!isAbsolute(binary)) throw new Error('Provide an absolute path to the verified Codex executable');
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'ahastation-s5-codex-')));
  let child, lines;
  const requests = [], pending = new Map(); let outputBytes = 0, nextId = 0;
  let closed;
  const rejectAll = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Native probe transport ended')); } pending.clear(); };
  try {
    const project = join(root, 'project'), userData = join(root, 'profile'), originalHome = join(root, 'source-home');
    await fs.mkdir(project); await fs.mkdir(userData); await fs.mkdir(join(originalHome, 'sessions'), { recursive: true });
    const sourceId = randomUUID(), now = new Date().toISOString();
    const source = join(originalHome, 'sessions', `rollout-${sourceId}.jsonl`);
    const bytes = Buffer.from([
      { timestamp: now, type: 'session_meta', payload: { id: sourceId, timestamp: now, cwd: project,
        originator: 'codex_cli_rs', cli_version: '0.156.1', source: 'cli', model_provider: 's5_offline', base_instructions: { text: 'Synthetic S5 fixture' } } },
      { timestamp: now, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'S5 synthetic history marker' }] } },
      { timestamp: now, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'S5 synthetic answer' }] } },
    ].map(JSON.stringify).join('\n') + '\n');
    await fs.writeFile(source, bytes);
    const access = new ScanAccessStore(join(userData, 'scan-access.json')); await access.set({ enabled: true, roots: [project] });
    const observedId = createHash('sha1').update(`codex:${sourceId}`).digest('hex');
    const preparer = new SessionCopyPreparer({ userData, homeDir: root, configRoots: { codex: originalHome, claude: join(root, 'unused') },
      access, snapshot: () => ({ sessions: [{ id: observedId, nativeSessionId: sourceId, clientKind: 'codex', cwd: project, origin: 'user', ownership: 'unowned' }] }) });
    const prepared = await preparer.prepare(observedId);
    const sandboxHome = join(dirname(prepared.isolatedHome), 'os-home'); await fs.mkdir(sandboxHome);
    await fs.writeFile(join(prepared.isolatedHome, 'config.toml'),
      'model_provider = "s5_offline"\nmodel = "s5-test"\n[model_providers.s5_offline]\nname = "Offline fixture"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n', { mode: 0o600 });
    // Do not inherit credentials, feature flags, config overlays or real home.
    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { CODEX_HOME: prepared.isolatedHome, HOME: sandboxHome, USERPROFILE: sandboxHome,
      APPDATA: join(sandboxHome, 'appdata'), LOCALAPPDATA: join(sandboxHome, 'localappdata'), XDG_CONFIG_HOME: join(sandboxHome, '.config') });
    child = spawn(binary, ['app-server', '--stdio'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    closed = new Promise((resolve) => { child.once('close', resolve); });
    child.on('error', rejectAll); child.on('exit', rejectAll);
    child.stderr.on('data', () => {}); // Never publish runtime paths/content.
    child.stdout.on('data', (chunk) => { outputBytes += chunk.length; if (outputBytes > 2 * 1024 * 1024) { rejectAll(); child.kill(); } });
    lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let message; try { message = JSON.parse(line); } catch { rejectAll(); return; }
      if (message.method && message.id !== undefined) {
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'No execution or approval in offline probe' } }) + '\n');
        return;
      }
      const request = pending.get(message.id); if (!request) return;
      clearTimeout(request.timer); pending.delete(message.id);
      message.error ? request.reject(new Error('Native probe RPC failed: ' + request.method)) : request.resolve(message.result);
    });
    const call = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId; requests.push(method);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native probe timeout: ' + method)); }, 20_000);
      pending.set(id, { method, resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    const ready = await call('initialize', { clientInfo: { name: 'ahastation-s5-offline-probe', version: '1.0.0' }, capabilities: { experimentalApi: false } });
    const version = extractCodexRuntimeVersion(ready.userAgent);
    assert.ok(isSupportedCodexAppServerVersion(version), 'runtime must match the project verified interval');
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const fork = await call('thread/fork', { threadId: sourceId, cwd: project, sandbox: 'read-only', approvalPolicy: 'never', excludeTurns: true });
    assert.match(fork.thread.id, /^[a-f0-9-]{36}$/i); assert.notEqual(fork.thread.id, sourceId);
    assert.equal(fork.thread.forkedFromId, sourceId); assert.equal(fork.thread.ephemeral, false);
    assert.equal(fork.sandbox.type, 'readOnly'); assert.equal(fork.sandbox.networkAccess, false); assert.equal(fork.approvalPolicy, 'never');
    assert.ok(withinDirectory(prepared.isolatedHome, await fs.realpath(fork.thread.path)));
    const copiedHistory = await fs.readFile(fork.thread.path, 'utf8');
    const metadata = JSON.parse(copiedHistory.split('\n')[0]); assert.equal(metadata.payload.id, fork.thread.id);
    assert.ok(copiedHistory.includes('S5 synthetic history marker')); assert.ok(copiedHistory.includes('S5 synthetic answer'));
    const read = await call('thread/read', { threadId: fork.thread.id, includeTurns: false });
    assert.equal(read.thread.id, fork.thread.id);
    for (const file of [source, prepared.backupPath, prepared.copyPath]) assert.equal(hash(await fs.readFile(file)), hash(bytes));
    const evidence = { schemaVersion: 1, runtimeVersion: version, sourceUnchanged: true, backupVerified: true,
      inputCopyUnchanged: true, newSessionId: true, historyCopied: true, persistedThreadReadable: true,
      sandbox: 'read-only', networkAccess: false, modelTurns: 0, authenticatedRequests: 0, requests };
    return evidence;
  } finally {
    rejectAll(); lines?.close();
    if (child) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      await closed; clearTimeout(timer);
    }
    // root was created by this probe and is never supplied by the caller.
    if (await fs.realpath(root).catch(() => null) === root) await fs.rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await probeCodexSessionCopy(process.argv[2] ?? ''), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
