// Hidden owned ConPTY fixture, not a native provider/tool turn or B04.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { WindowsConPtyProcess } from '../dist-electron/native-worker/windows-conpty.js';
import { PtyHost } from '../dist-electron/pty-host.js';
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const windows = { skip: process.platform !== 'win32' ? 'Windows ConPTY/AppContainer only; provider evidence unknown' : false };
function removeOwnedTemp(path, prefix) {
  const parent = realpathSync.native(tmpdir());
  assert.equal(lstatSync(path).isSymbolicLink(), false);
  const absolute = realpathSync.native(path);
  assert.equal(dirname(absolute), parent); assert.ok(basename(absolute).startsWith(prefix));
  rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function fixture(t, argv) {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'aha-owned-console-'));
  const imagePath = join(root, 'console.exe');
  const build = spawnSync(join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    ['/nologo', '/target:exe', `/out:${imagePath}`, resolve('tests/fixtures/native-conpty.cs')], { windowsHide: true, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve, reject) => {
    const probe = createConnection({ host: '127.0.0.1', port: server.address().port });
    probe.once('error', reject); probe.once('close', resolve);
  });
  assert.equal(connections, 1, 'host positive control reaches the same target'); connections = 0;
  const sentinel = join(root, 'outside.txt'); writeFileSync(sentinel, 'original');
  const config = { helperPath: resolve('build/worker-guard/WindowsGuard.exe'), imagePath,
    imageSha256: hash(imagePath), helperSha256: hash('build/worker-guard/WindowsGuard.exe'),
    argv: argv ?? [sentinel, String(server.address().port)] };
  const pty = await WindowsConPtyProcess.spawnOffline(config);
  let output = '';
  pty.onData(data => { output = (output + data).slice(-64000); });
  t.after(async () => {
    const result = await pty.terminateTree();
    assert.equal(result.confirmed, true, 'cleanup needs Job evidence');
    await new Promise(resolve => server.close(resolve));
    removeOwnedTemp(root, 'aha-owned-console-');
    // Only the exact temporary root created by this fixture's object.
    removeOwnedTemp(pty.temporaryRoot, 'aha-conpty-');
  });
  return { pty, config, connections: () => connections, sentinel, output: () => output,
    wait: async text => { const end = Date.now() + 7000;
      while (!output.includes(text)) { assert.equal(pty.startupError, undefined, `${pty.startupError?.message}: ${output}`); assert.ok(Date.now() < end, `missing ${text}: ${output}`); await delay(10); }
    } };
}

test('guarded ConPTY attaches suspended identity before code; native file/console and descendants stay isolated', windows, async t => {
  const f = await fixture(t), { pty } = f;
  const exits = []; pty.onExit(event => exits.push(event));
  const identity = pty.processIdentity(); assert.ok(identity.pid > 0); assert.match(identity.startId, /^\d+$/);
  assert.throws(() => pty.write('must not enter before resume'), /sealed/);
  const host = new PtyHost({ spawn: () => { throw new Error('must not launch a second process'); } });
  assert.equal(host.adopt('owned-fixture', pty), identity.pid);
  await delay(100); assert.equal(existsSync(join(pty.workspace, 'started.txt')), false);
  pty.resume(); await f.wait('fixture-ready'); await f.wait('中文 🧪');
  assert.equal(host.has('owned-fixture'), true, 'terminal text cannot forge guardian exit evidence');
  assert.ok(f.output().includes('"activeProcesses":0'), 'forged text remains terminal output only');
  assert.equal(readFileSync(join(pty.workspace, 'started.txt'), 'utf8'), '中文 🧪');
  assert.ok(f.output().includes('direct-write=False network=False descendant=0'), f.output());
  assert.equal(readFileSync(f.sentinel, 'utf8'), 'original'); assert.equal(existsSync(f.sentinel + '.child'), false); assert.equal(f.connections(), 0);
  assert.equal(host.write('owned-fixture', '输入 🧪\r'), true); await f.wait('fixture-input=输入 🧪');
  const start = Date.now(); await host.terminateTree('owned-fixture');
  assert.equal(host.has('owned-fixture'), false); assert.equal(host.write('owned-fixture', 'late'), false);
  assert.equal(exits.length, 1); assert.equal(exits[0].stopReason, 'host-stop');
  assert.equal(exits[0].rootExitedBeforeStop, false); assert.equal(exits[0].treeExit.forcedTermination, true);
  assert.equal(exits[0].treeExit.activeProcesses, 0); assert.equal(exits[0].exitCode, 1, 'actual TerminateJobObject exit value');
  t.diagnostic(JSON.stringify({ boundary: 'windows-offline-conpty-v1', identity, stopMs: Date.now() - start,
    nativeFileWrite: true, deniedDirectAndDescendantWrite: true, deniedLoopbackConnections: f.connections(),
    treeExit: 'Job ActiveProcesses=0', cliEngine: 'unknown; owned fixture only', defaultNativeAdmission: false }));
});

test('host EOF reaps a suspended ConPTY without running target instructions', windows, async t => {
  const { pty } = await fixture(t), exits = []; pty.onExit(event => exits.push(event)); pty.disconnectHostTransport();
  assert.equal((await pty.terminateTree()).confirmed, true);
  assert.equal(exits[0].stopReason, 'host-eof'); assert.equal(exits[0].rootExitedBeforeStop, false);
  assert.equal(exits[0].treeExit.confirmed, true); assert.equal(exits[0].treeExit.activeProcesses, 0);
  assert.equal(existsSync(join(pty.workspace, 'started.txt')), false);
  assert.throws(() => pty.resume(), /rejected/);
});

for (const [value, expected] of [['0', 0], ['37', 37], ['259', 259], ['-1', 0xffffffff]]) {
  test(`normal ConPTY root exit ${value} retains its OS code independently of Job confirmation`, windows, async t => {
    const { pty } = await fixture(t, ['--exit', value]);
    const host = new PtyHost(); host.adopt('normal-exit', pty);
    let timer;
    const exited = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('normal root exit was not confirmed')), 7000);
      host.onExit('normal-exit', (exitCode, event) => resolve({ exitCode, event }));
    });
    try {
      pty.resume(); const { exitCode, event } = await exited;
      assert.equal(exitCode, expected); assert.equal(event.exitCode, expected);
      assert.equal(event.stopReason, 'process-exit'); assert.equal(event.rootExitedBeforeStop, true);
      const identity = pty.processIdentity();
      assert.deepEqual({ pid: event.treeExit.pid, startId: event.treeExit.startId, bootId: event.treeExit.bootId }, identity);
      assert.equal(event.treeExit.confirmed, true); assert.equal(event.treeExit.activeProcesses, 0);
      assert.equal(typeof event.treeExit.forcedTermination, 'boolean');
      assert.equal(host.has('normal-exit'), false); assert.equal(pty.startupError, undefined);
      t.diagnostic(JSON.stringify({ exitCode, stopReason: event.stopReason, rootExitedBeforeStop: event.rootExitedBeforeStop,
        activeProcesses: event.treeExit.activeProcesses, forcedTermination: event.treeExit.forcedTermination }));
    } finally { clearTimeout(timer); }
  });
}

test('closing the console before normal teardown does not turn exit 0 into forced failure', windows, async t => {
  const { pty } = await fixture(t, ['--exit-after-console-close']); let timer;
  const exited = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('normal console teardown was not confirmed')), 7000); pty.onExit(resolve);
  });
  try {
    pty.resume(); const event = await exited;
    assert.equal(event.exitCode, 0); assert.equal(event.stopReason, 'process-exit');
    assert.equal(event.rootExitedBeforeStop, true); assert.equal(event.treeExit.activeProcesses, 0);
  } finally { clearTimeout(timer); }
});

test('root success and forced descendant cleanup are separate facts', windows, async t => {
  const { pty } = await fixture(t, ['--exit-with-child']);
  let timer;
  const exited = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('remaining descendant was not reaped')), 7000);
    pty.onExit(resolve);
  });
  try {
    pty.resume(); const event = await exited;
    assert.equal(event.exitCode, 0); assert.equal(event.stopReason, 'process-exit');
    assert.ok(Number(readFileSync(join(pty.workspace, 'remaining-child.txt'), 'utf8')) > 0);
    assert.equal(event.rootExitedBeforeStop, true); assert.equal(event.treeExit.forcedTermination, true);
    assert.equal(event.treeExit.confirmed, true); assert.equal(event.treeExit.activeProcesses, 0);
  } finally { clearTimeout(timer); }
});

test('staged console image mismatch is rejected before target startup', windows, async () => {
  const helperPath = resolve('build/worker-guard/WindowsGuard.exe');
  await assert.rejects(WindowsConPtyProcess.spawnOffline({ helperPath, helperSha256: hash(helperPath),
    imagePath: helperPath, imageSha256: '0'.repeat(64), argv: [] }), /mismatch/);
});
