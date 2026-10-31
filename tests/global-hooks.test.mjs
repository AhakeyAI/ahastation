import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { performance } from 'node:perf_hooks';
import { createCipheriv, randomBytes } from 'node:crypto';
import { installGlobalHooks, uninstallGlobalHooks, parseConfig, probeCodexHooks } from '../dist-electron/global-hooks/installer.js';
import { GlobalHookHost } from '../dist-electron/global-hooks/host.js';
import { denyHook, requireNativeHookWorkerAdmission, sanitizeHook } from '../dist-electron/global-hooks/protocol.js';
import { ensurePrivateHookDirectory } from '../dist-electron/global-hooks/file-security.js';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const relay = resolve('dist-electron/global-hooks/relay.js');
const fixture = t => {
  const scratch = mkdtempSync(join(tmpdir(), 'aha85 中文 space '));
  const root = join(scratch, 'private');
  ensurePrivateHookDirectory(root);
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const configDir = join(root, '.claude');
  mkdirSync(configDir);
  const options = { agent: 'claude', configDir, stateDir: join(root, 'private hooks'),
    profileId: 'test-profile', nodePath: process.execPath, relayPath: relay, version: 'v1' };
  return { root, options, path: join(configDir, 'settings.json') };
};
const native = (event = 'PreToolUse') => ({ session_id: 'native-session', hook_event_name: event,
  tool_name: 'Bash', turn_id: 'turn-1', tool_use_id: 'call-1', cwd: 'SECRET_PATH',
  tool_input: { command: 'SECRET_COMMAND' }, tool_response: 'SECRET_RESULT',
  last_assistant_message: 'SECRET_MESSAGE', agent_id: 'NOT_A_WORKER', origin: 'worker' });
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AHA_')));
function runRelay(endpoint, { mode = 'observe', event = 'PreToolUse', input = native(event), env = {} } = {}) {
  return new Promise((yes, no) => {
    const start = performance.now();
    const p = spawn(process.execPath, [relay, 'codex', endpoint, mode, event], { env: { ...cleanEnv(), ...env }, windowsHide: true });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => stdout += d); p.stderr.on('data', d => stderr += d);
    p.on('error', no); p.stdin.on('error', () => {});
    p.on('exit', code => yes({ code, stdout, stderr, ms: performance.now() - start }));
    p.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
function post(endpointPath, input, headers = {}) {
  const endpoint = JSON.parse(readFileSync(endpointPath));
  return new Promise((yes, no) => {
    const req = request({ host: '127.0.0.1', port: endpoint.port, path: '/observe', method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json', ...headers } },
    res => { res.resume(); res.on('end', () => yes(res.statusCode)); });
    req.on('error', no); req.end(JSON.stringify(input));
  });
}
const tick = () => new Promise(yes => setImmediate(yes));

test('install is idempotent and uninstall restores exact bytes, BOM, CRLF and secrets', t => {
  const { options, path } = fixture(t);
  const original = '\uFEFF{\r\n "env": {"TOKEN":"do-not-copy-plaintext"}, "hooks":{"Stop":[{"hooks":[{"type":"command","command":"my hook"}]}]}\r\n}\r\n';
  writeFileSync(path, original);
  assert.equal(installGlobalHooks(options).status, 'installed');
  const installed = readFileSync(path, 'utf8');
  assert.equal(installGlobalHooks(options).status, 'unchanged');
  assert.equal(readFileSync(path, 'utf8'), installed);
  const manifest = readFileSync(join(options.stateDir, 'claude.json'), 'utf8');
  assert.ok(!manifest.includes('do-not-copy-plaintext'));
  assert.equal(JSON.parse(installed).hooks.Stop.length, 2);
  assert.deepEqual(uninstallGlobalHooks(options), { status: 'removed', retainedEdits: [] });
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(uninstallGlobalHooks(options).status, 'absent');
});

test('missing original file is removed; other settings/hooks added later survive uninstall', t => {
  const { options, path } = fixture(t);
  assert.equal(uninstallGlobalHooks(options).status, 'absent');
  assert.equal(existsSync(options.stateDir), false);
  installGlobalHooks(options); uninstallGlobalHooks(options);
  assert.equal(existsSync(path), false);
  installGlobalHooks(options);
  const edited = JSON.parse(readFileSync(path));
  edited.userSetting = 'later';
  edited.hooks.PreToolUse.push({ hooks: [{ type: 'command', command: 'new user hook' }] });
  writeFileSync(path, JSON.stringify(edited));
  uninstallGlobalHooks(options);
  assert.deepEqual(JSON.parse(readFileSync(path)), { userSetting: 'later', hooks: {
    PreToolUse: [{ hooks: [{ type: 'command', command: 'new user hook' }] }],
  } });
});

test('upgrade preserves post-install edits and uninstall does not roll them back', t => {
  const { options, path } = fixture(t);
  writeFileSync(path, '{"userSetting":"before"}'); installGlobalHooks(options);
  const edited = JSON.parse(readFileSync(path)); edited.userSetting = 'after';
  writeFileSync(path, JSON.stringify(edited));
  assert.equal(installGlobalHooks({ ...options, version: 'v2' }).status, 'upgraded');
  uninstallGlobalHooks({ ...options, version: 'v2' });
  assert.deepEqual(JSON.parse(readFileSync(path)), { userSetting: 'after' });
});

test('edited owned commands are retained; appended foreign hooks are preserved', t => {
  const { options, path } = fixture(t);
  installGlobalHooks(options);
  const edited = JSON.parse(readFileSync(path));
  edited.hooks.Stop[0].hooks[0].command += ' user-change';
  edited.hooks.PreToolUse[0].hooks.push({ type: 'command', command: 'mine' });
  writeFileSync(path, JSON.stringify(edited));
  assert.throws(() => installGlobalHooks({ ...options, version: 'v2' }), /owned-hook-edited/);
  const removed = uninstallGlobalHooks(options);
  assert.deepEqual(removed.retainedEdits, ['Stop']);
  const left = JSON.parse(readFileSync(path));
  assert.match(left.hooks.Stop[0].hooks[0].command, /user-change/);
  assert.deepEqual(left.hooks.PreToolUse[0].hooks, [{ type: 'command', command: 'mine' }]);
});

test('malformed, duplicate-key, wrong-shape and disabled configurations remain byte-identical', t => {
  const { options, path } = fixture(t);
  for (const raw of ['{broken', '{"a":1,"a":2}', '[]', '{"hooks":[]}', '{"hooks":{"Stop":{}}}', '{"disableAllHooks":true}']) {
    writeFileSync(path, raw);
    assert.throws(() => installGlobalHooks(options));
    assert.equal(readFileSync(path, 'utf8'), raw);
  }
  assert.equal(parseConfig('{"text":"a \\" { } [ ]"}').text, 'a " { } [ ]');
});

test('invalid UTF-8 configuration is refused without replacing its original bytes', t => {
  const { options, path } = fixture(t);
  // Buffer.toString('utf8') silently replaces this byte with U+FFFD, which
  // would make an apparently successful uninstall restore different bytes.
  const original = Buffer.concat([Buffer.from('{"userSecret":"'), Buffer.from([0xff]), Buffer.from('"}\r\n')]);
  writeFileSync(path, original);
  assert.throws(() => installGlobalHooks(options), /invalid-utf8-hook-file/);
  assert.deepEqual(readFileSync(path), original);
  assert.equal(existsSync(join(options.stateDir, 'claude.json')), false);
});

test('advisory lock, different profile, and symlink config are refused', t => {
  const { options, path, root } = fixture(t);
  writeFileSync(`${path}.aha-studio.lock`, 'another install');
  assert.throws(() => installGlobalHooks(options), /EEXIST/);
  assert.equal(existsSync(join(options.stateDir, 'install.lock')), false);
  rmSync(`${path}.aha-studio.lock`);
  installGlobalHooks(options);
  assert.throws(() => installGlobalHooks({ ...options, profileId: 'other', stateDir: join(root, 'other') }), /another-profile/);
  uninstallGlobalHooks(options);
  writeFileSync(join(root, 'target.json'), '{}');
  try { symlinkSync(join(root, 'target.json'), path); }
  catch (e) { if (e.code === 'EPERM') { t.diagnostic('Windows symlink privilege unavailable; rest of lock/profile checks passed'); return; } throw e; }
  assert.throws(() => installGlobalHooks(options), /symlink/);
  assert.equal(readFileSync(join(root, 'target.json'), 'utf8'), '{}');
});

test('shared store serializes independent configuration installs and releases both locks', t => {
  const { options, root, path } = fixture(t);
  const second = { ...options, configDir: join(root, 'other-config'), profileId: 'other' };
  const secondPath = join(second.configDir, 'settings.json');
  const originalOpen = fs.openSync;
  let intercepted = false;
  let contender;
  fs.openSync = function(file, ...args) {
    if (!intercepted && String(file).startsWith(join(options.stateDir, 'backups') + sep) && String(file).endsWith('.tmp')) {
      intercepted = true;
      contender = spawnSync(process.execPath, ['tests/fixtures/global-hooks-install.mjs'], {
        input: JSON.stringify(second), encoding: 'utf8', timeout: 15_000, windowsHide: true,
      });
    }
    return originalOpen.call(this, file, ...args);
  };
  syncBuiltinESMExports();
  try { assert.equal(installGlobalHooks(options).status, 'installed'); }
  finally { fs.openSync = originalOpen; syncBuiltinESMExports(); }
  assert.equal(intercepted, true);
  assert.equal(contender.status, 1);
  assert.match(JSON.parse(contender.stdout).error, /EEXIST|store-busy/);
  assert.equal(existsSync(secondPath), false);
  assert.equal(JSON.parse(readFileSync(join(options.stateDir, 'claude.json'))).profileId, options.profileId);
  assert.equal(uninstallGlobalHooks(options).status, 'removed');
  assert.equal(existsSync(path), false);
  assert.equal(installGlobalHooks(second).status, 'installed');
  assert.equal(uninstallGlobalHooks(second).status, 'removed');
  assert.equal(existsSync(secondPath), false);
  assert.equal(existsSync(join(options.stateDir, 'install.lock')), false);
});

function interruptedTransaction(options, path) {
  // Recovery fixture models a crash after atomic config rename, before state
  // rename. Build the wire record independently of installer implementation.
  installGlobalHooks(options);
  const manifestPath = join(options.stateDir, 'claude.json');
  const manifest = readFileSync(manifestPath, 'utf8');
  rmSync(manifestPath);
  const tx = { configPath: path, profileId: options.profileId, before: null,
    after: readFileSync(path, 'utf8'), manifest };
  const key = readFileSync(join(options.stateDir, 'backup.key'));
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(JSON.stringify(tx))), cipher.final()]);
  writeFileSync(join(options.stateDir, 'claude.transaction'), Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64'), { mode: 0o600 });
}
test('journal recovers an interrupted config+manifest transaction without half installation', t => {
  const { options, path } = fixture(t);
  interruptedTransaction(options, path);
  assert.ok(existsSync(join(options.stateDir, 'claude.transaction')));
  assert.ok(readFileSync(path, 'utf8').includes('--aha-studio-global-hooks-v1'));
  assert.equal(installGlobalHooks(options).status, 'unchanged');
  assert.equal(existsSync(join(options.stateDir, 'claude.transaction')), false);
  uninstallGlobalHooks(options);
  assert.equal(existsSync(path), false);
});

test('recovery refuses to overwrite an editor change after interruption', t => {
  const { options, path } = fixture(t);
  interruptedTransaction(options, path);
  writeFileSync(path, '{"external":"edit"}');
  assert.throws(() => installGlobalHooks(options), /transaction-conflict/);
  assert.equal(readFileSync(path, 'utf8'), '{"external":"edit"}');
});

test('protocol sanitizes sensitive payload and never interprets observations as Worker identity', () => {
  const input = sanitizeHook('codex', native(), 'i-1');
  assert.deepEqual(input, { protocol: 'aha.if1', schemaVersion: 1, invocationId: 'i-1', agent: 'codex',
    event: 'PreToolUse', sessionId: 'native-session', toolName: 'Bash', turnId: 'turn-1', toolUseId: 'call-1' });
  assert.ok(!JSON.stringify(input).includes('SECRET'));
  assert.ok(!sanitizeHook('claude', { ...native(), session_id: '' }, 'i-1'));
  assert.equal(sanitizeHook('codex', native('PermissionRequest'), 'i-2').toolUseId, undefined);
});

test('controlled entry denies without stdin/host and can never be admitted by env or forged receipt', async t => {
  const { root } = fixture(t);
  assert.throws(requireNativeHookWorkerAdmission, /unsupported-contract/);
  for (const event of ['PreToolUse', 'PermissionRequest']) {
    for (const env of [{}, { AHA_SESSION_ORIGIN: 'worker', AHA_ATTEMPT_ID: 'old' },
      { AHA_HOOK_CREDENTIAL: 'expired', AHA_SESSION_ORIGIN: 'user' }]) {
      const result = await runRelay(join(root, 'missing.json'), { mode: 'controlled', event, env,
        input: { ...native(event), approval: { action: 'allow', attemptId: 'old', stopped: true } } });
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.stdout), denyHook(event));
    }
  }
  const suspicious = await runRelay(join(root, 'missing.json'), { env: { AHA_SESSION_ORIGIN: 'worker' } });
  assert.match(suspicious.stdout, /deny/);
});

test('ordinary CLI preserves native approval with host absent, invalid, refused, hanging and queue full', async t => {
  const { root } = fixture(t);
  const endpoint = join(root, 'host.json');
  const samples = [];
  samples.push(await runRelay(endpoint));
  writeFileSync(endpoint, 'broken'); samples.push(await runRelay(endpoint));
  writeFileSync(endpoint, JSON.stringify({ protocol: 'aha.hooks.local.v1', port: 1, token: 'a'.repeat(64) }));
  samples.push(await runRelay(endpoint));
  const server = createServer((req, res) => { req.resume(); if (req.headers['x-test']) res.writeHead(429).end(); });
  await new Promise(yes => server.listen(0, '127.0.0.1', yes));
  t.after(() => { server.closeAllConnections(); server.close(); });
  writeFileSync(endpoint, JSON.stringify({ protocol: 'aha.hooks.local.v1', port: server.address().port, token: 'a'.repeat(64) }));
  samples.push(await runRelay(endpoint));
  samples.push(await runRelay(endpoint, { input: '{bad' }));
  samples.push(await runRelay(endpoint, { input: 'x'.repeat(1024 * 1024 + 1) }));
  for (const result of samples) { assert.equal(result.code, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, ''); }
  t.diagnostic(`relay wall times including Node startup (ms): ${samples.map(s => Math.round(s.ms)).join(', ')}`);
});

test('host enforces scan/ownership checks, sanitization, auth, origin rejection and bounded queue', async t => {
  const { root } = fixture(t);
  const endpoint = join(root, 'host.json');
  let classification = null;
  const host = new GlobalHookHost({ endpointPath: endpoint, profileId: 'p1', deviceId: 'device',
    classifyAuthorized: () => classification, queueCapacity: 0 });
  await host.start(); t.after(() => host.stop());
  const input = sanitizeHook('claude', native(), 'i-1');
  assert.equal(await post(endpoint, input), 429);
  assert.equal(await post(endpoint, input, { origin: 'https://evil.example' }), 403);
  assert.equal(await post(endpoint, input, { authorization: 'Bearer forged' }), 403);
  assert.equal(await post(endpoint, { ...input, subject: { origin: 'worker' } }), 400);
  assert.equal(host.getSnapshot().watermark, 0);
  await host.stop();
  const active = new GlobalHookHost({ endpointPath: endpoint, profileId: 'p1', deviceId: 'device',
    classifyAuthorized: () => classification, retention: 2 });
  await active.start(); t.after(() => active.stop());
  assert.equal(await post(endpoint, input), 202); await tick();
  assert.equal(active.getSnapshot().watermark, 0); // not authorized
  classification = 'unresolved';
  await post(endpoint, { ...input, invocationId: 'i-2' }); await tick();
  let snapshot = active.getSnapshot();
  assert.equal(snapshot.sessions[0].subject.origin, 'unknown');
  assert.equal(snapshot.sessions[0].subject.ownership, 'unresolved');
  classification = 'user';
  snapshot = active.getSnapshot(); // ownership changes invalidate the old stream
  const cursor = { deviceId: 'device', publisherEpoch: snapshot.publisherEpoch, seq: snapshot.watermark };
  const result = await runRelay(endpoint);
  assert.equal(result.stdout, ''); await tick();
  // Observation is intentionally lossy under the 40ms budget. Assert host
  // state with deterministic direct ingress, not a timed relay delivery.
  assert.equal(await post(endpoint, { ...input, invocationId: 'deterministic-user' }), 202); await tick();
  const subscribed = active.subscribe(cursor);
  assert.equal(subscribed.status, 'ok');
  assert.equal(subscribed.events[0].subject.origin, 'user');
  const count = active.getSnapshot().watermark;
  await post(endpoint, { ...input, invocationId: 'dedupe' }); await tick();
  await post(endpoint, { ...input, invocationId: 'dedupe' }); await tick();
  assert.equal(active.getSnapshot().watermark, count + 1);
  await post(endpoint, { ...input, invocationId: 'stop-1', event: 'Stop', toolName: undefined }); await tick();
  snapshot = active.getSnapshot();
  const claudeSession = snapshot.sessions.find(session => session.subject.agent === 'claude');
  assert.equal(claudeSession.state.phase, 'unknown');
  assert.equal(claudeSession.state.process, 'unknown');
  assert.equal(active.subscribe(cursor).status, 'resnapshot-required');
  assert.equal(active.subscribe({ ...cursor, publisherEpoch: 'old' }).status, 'resnapshot-required');
  assert.ok(!JSON.stringify(snapshot).includes('SECRET'));
  await assert.rejects(new GlobalHookHost({ endpointPath: endpoint, profileId: 'other', deviceId: 'd',
    classifyAuthorized: () => 'user' }).start(), /EEXIST/);
});

test('CLI wrapper stages immutable runtime and supports real isolated install/uninstall', t => {
  const { options, path } = fixture(t);
  const args = ['scripts/global-hooks.mjs', 'install', '--agent', 'claude', '--config-dir', options.configDir,
    '--state-dir', options.stateDir, '--profile', 'smoke'];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(readFileSync(path));
  assert.match(config.hooks.PreToolUse[0].hooks[0].command, /runtimes/);
  args[1] = 'uninstall';
  assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 0);
  assert.equal(existsSync(path), false);
});

test('uninstall still restores configuration when the current build has no relay', t => {
  const { options, path, root } = fixture(t);
  const original = '{"user":"keep exact bytes"}\r\n';
  writeFileSync(path, original);
  installGlobalHooks(options);
  const copyRoot = join(root, 'incomplete-build');
  mkdirSync(join(copyRoot, 'scripts'), { recursive: true });
  mkdirSync(join(copyRoot, 'dist-electron/global-hooks'), { recursive: true });
  writeFileSync(join(copyRoot, 'package.json'), '{"type":"module"}');
  copyFileSync('scripts/global-hooks.mjs', join(copyRoot, 'scripts/global-hooks.mjs'));
  for (const name of ['installer.js', 'protocol.js', 'file-security.js']) {
    copyFileSync(join('dist-electron/global-hooks', name), join(copyRoot, 'dist-electron/global-hooks', name));
  }
  const result = spawnSync(process.execPath, [join(copyRoot, 'scripts/global-hooks.mjs'), 'uninstall',
    '--agent', 'claude', '--config-dir', options.configDir, '--state-dir', options.stateDir, '--profile', options.profileId],
  { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('revoked scan authorization or changed ownership cannot survive in snapshots or replay', async t => {
  const { root } = fixture(t);
  const endpoint = join(root, 'revocation-host.json');
  const classifications = new Map([['session-a', 'user'], ['session-b', 'user']]);
  const host = new GlobalHookHost({ endpointPath: endpoint, profileId: 'p', deviceId: 'd',
    classifyAuthorized: input => classifications.get(input.sessionId) ?? null });
  await host.start(); t.after(() => host.stop());
  const input = sanitizeHook('claude', native(), 'a');
  await post(endpoint, { ...input, sessionId: 'session-a' }); await tick();
  await post(endpoint, { ...input, sessionId: 'session-b', invocationId: 'b' }); await tick();
  const before = host.getSnapshot();
  assert.equal(before.sessions.length, 2);
  const cursor = { deviceId: 'd', publisherEpoch: before.publisherEpoch, seq: 0 };
  classifications.delete('session-b');
  const revoked = host.getSnapshot();
  assert.equal(revoked.sessions.length, 1);
  assert.notEqual(revoked.publisherEpoch, before.publisherEpoch);
  assert.equal(host.subscribe(cursor).status, 'resnapshot-required');
  const current = { ...cursor, seq: before.watermark };
  assert.equal(host.subscribe(current).status, 'resnapshot-required'); // already-consumed entries must also disappear
  classifications.set('session-a', 'unresolved');
  assert.deepEqual(host.getSnapshot().sessions, []);
  assert.equal(host.subscribe(cursor).status, 'resnapshot-required');
  await post(endpoint, { ...input, sessionId: 'session-a', invocationId: 'a-new' }); await tick();
  assert.equal(host.getSnapshot().sessions[0].subject.origin, 'unknown');
  classifications.delete('session-a');
  assert.deepEqual(host.getSnapshot().sessions, []);
  await host.stop();
  let authorized = true;
  const replayOnly = new GlobalHookHost({ endpointPath: endpoint, profileId: 'p', deviceId: 'd', maxSessions: 0,
    classifyAuthorized: () => authorized ? 'user' : null });
  await replayOnly.start(); t.after(() => replayOnly.stop());
  const initial = replayOnly.getSnapshot();
  await post(endpoint, input); await tick();
  const replayCursor = { deviceId: 'd', publisherEpoch: initial.publisherEpoch, seq: 0 };
  assert.equal(replayOnly.subscribe(replayCursor).events.length, 1);
  authorized = false;
  assert.equal(replayOnly.subscribe(replayCursor).status, 'resnapshot-required');
});

test('pinned real Codex verifies canonical enabled flag and refuses disabled settings without rewriting TOML', t => {
  const binary = resolve('node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
  if (!existsSync(binary)) { t.skip('exact Windows Codex binary unavailable'); return; }
  const { root } = fixture(t);
  const dir = join(root, 'codex'); mkdirSync(dir);
  assert.equal(probeCodexHooks(binary, dir).feature, 'hooks');
  const path = join(dir, 'config.toml'); const original = '# keep comment\n[features]\nhooks = false\n';
  writeFileSync(path, original);
  assert.throws(() => probeCodexHooks(binary, dir), /codex-hooks-disabled/);
  assert.equal(readFileSync(path, 'utf8'), original);
});
