// Run after build:electron. Optional --runtime <win-unpacked/AhaStation.exe>
// uses that actual packaged runtime, launcher, daemon and native dependencies.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { TerminalClient } from '../dist-electron/terminal-daemon/client.js';

assert.equal(process.platform, 'win32');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(process.argv.includes('--runtime') ? process.argv[process.argv.indexOf('--runtime') + 1] : join(repo, 'node_modules/electron/dist/electron.exe'));
const packaged = process.argv.includes('--runtime');
const code = packaged ? join(dirname(runtime), 'resources/app.asar/dist-electron') : join(repo, 'dist-electron');
const artifact = await mkdtemp(join(tmpdir(), packaged ? 'aha D1 packaged 中文 ' : 'aha D1 dev 中文 '));
const execute = promisify(execFile);
const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const evidence = { runtime, code, packaged, artifact, rounds: [] };
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(action, description, ms = 15_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const value = await action(); if (value) return value; } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`Timeout: ${description}; ${last ?? ''}`);
}
async function identities(pids, dataDir, pipeName) {
  const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-File',
    join(repo, 'scripts/terminal-daemon-inspect.ps1'), '-RootIds', pids.join(','), ...(dataDir ? ['-DataDir', dataDir] : []),
    ...(pipeName ? ['-PipeName', pipeName] : [])], { windowsHide: true });
  return JSON.parse(stdout);
}
for (const mode of ['normal', 'forced']) {
  const dataDir = join(artifact, mode);
  const readyFile = join(dataDir, 'ready.json');
  const quitFile = join(dataDir, 'quit');
  const mainData = join(dataDir, 'main-data');
  await mkdir(mainData, { recursive: true });
  const env = { ...process.env, AHA_D1_MAIN_DATA: mainData, AHA_D1_DATA: dataDir, AHA_D1_RUNTIME: runtime,
    AHA_D1_LAUNCHER: pathToFileURL(join(code, 'terminal-daemon/launcher.js')).href,
    AHA_D1_ENTRY: join(code, 'terminal-daemon/entry.js'), AHA_D1_PROBE: join(repo, 'tests/fixtures/terminal-daemon-probe.ps1'), AHA_D1_SHELL: powershell,
    AHA_D1_READY: readyFile, AHA_D1_QUIT: quitFile,
    // Prove daemon/runtime/probe launch never depends on system Node resolution.
    PATH: join(process.env.SystemRoot, 'System32'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const main = spawn(runtime, packaged ? [] : [join(repo, 'tests/fixtures/terminal-daemon-main')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  main.stdout.on('data', d => { output += d; }); main.stderr.on('data', d => { output += d; });
  main.on('error', error => { output += error.stack; });
  let client;
  let ready;
  const ownedPids = new Set([main.pid]);
  const round = { mode, mainPid: main.pid };
  evidence.rounds.push(round);
  try {
    ready = await until(async () => {
      if (main.exitCode !== null) throw new Error(`Test main exited ${main.exitCode}: ${output}`);
      return JSON.parse(await readFile(readyFile, 'utf8'));
    }, 'test main ready');
    ownedPids.add(ready.descriptor.pid);
    assert.equal(ready.isPackaged, packaged);
    round.isPackaged = ready.isPackaged;
    round.versions = ready.versions;
    for (const s of ready.sessions) { assert(s.pid > 0); ownedPids.add(s.pid); }
    client = await TerminalClient.connect(dataDir);
    for (const s of ready.sessions) {
      const attached = await client.attach(s.terminalId);
      await writeFile(join(dataDir, `${s.terminalId}-initial.txt`), Buffer.from(attached.replay, 'base64'));
    }
    const probes = [];
    for (const i of [0,1]) for (const suffix of ['', '-child', '-child-grandchild']) {
      const probe = await until(async () => JSON.parse((await readFile(join(dataDir, `probe-${i}${suffix}.json`), 'utf8')).replace(/^\uFEFF/, '')), `probe ${i}${suffix}`);
      probes.push(probe); ownedPids.add(probe.pid);
    }
    const pids = [...ownedPids];
    const inspected = await identities(pids, dataDir, ready.descriptor.endpoint);
    round.before = inspected.processes;
    round.beforeDaemon = (await identities([ready.descriptor.pid])).processes;
    round.dataDirSddl = inspected.dataDirSddl;
    round.pipeSddl = inspected.pipeSddl;
    assert.match(round.pipeSddl, /^D:P\(A;;FA;;;S-1-/);
    assert(!round.pipeSddl.includes(';;;WD)') && !round.pipeSddl.includes(';;;AN)'));
    for (const p of round.before) ownedPids.add(p.ProcessId);
    round.descriptor = ready.descriptor;
    round.sessions = ready.sessions.map(({ terminalId, pid, startedAt, requestId }) => ({ terminalId, pid, startedAt, requestId }));
    round.probes = probes;
    if (mode === 'normal') await writeFile(quitFile, 'quit');
    else main.kill('SIGKILL'); // root only, deliberately no /T
    await until(() => !alive(main.pid), 'main exit');
    // The OS can report the process gone before Node delivers its exit event.
    // Wait for that receipt before asserting the normal-exit status.
    await until(() => main.exitCode !== null || main.signalCode !== null, 'main exit status');
    if (mode === 'normal') assert.equal(main.exitCode, 0);
    round.mainExitCode = main.exitCode;
    round.mainExited = true;
    await delay(600);
    client.disconnect();
    client = await TerminalClient.connect(dataDir);
    assert.equal(client.descriptor.instanceId, ready.descriptor.instanceId);
    assert.equal(client.descriptor.pid, ready.descriptor.pid);
    const inventory = await client.inventory();
    assert.equal(inventory.length, 2);
    assert.deepEqual(inventory.map(s => [s.terminalId, s.pid, s.startedAt]), ready.sessions.map(s => [s.terminalId,s.pid,s.startedAt]));
    round.after = (await identities([ready.descriptor.pid])).processes;
    assert.deepEqual(round.after, round.beforeDaemon);
    const received = new Map();
    client.onEvent(e => { if (e.event === 'output') received.set(e.terminalId, (received.get(e.terminalId) ?? '') + Buffer.from(e.data, 'base64').toString()); });
    for (const s of ready.sessions) {
      const attached = await client.attach(s.terminalId);
      assert.equal(attached.pid, s.pid);
      await client.resize(s.terminalId, 117, 37);
      await client.input(s.terminalId, 'ping');
      await until(() => /ACK:.*ping:SIZE:117x37/.test(received.get(s.terminalId) ?? ''), 'input and actual PTY dimensions');
      const duplicate = await client.spawn(s.requestId, s.launch);
      assert.equal(duplicate.pid, s.pid);
      await assert.rejects(client.spawn(s.requestId, { ...s.launch, label: 'changed' }), /different launch/);
    }
    assert.equal((await client.inventory()).length, 2);
    round.reconnected = true; round.inputResize = true; round.spawnCount = 2;
    const first = ready.sessions[0], second = ready.sessions[1];
    const firstPids = [first.pid, ...probes.filter(p => p.role.startsWith('0')).map(p => p.pid)];
    const firstStop = await client.terminate(first.terminalId);
    assert.equal(firstStop.exited, true);
    assert.equal((await client.terminate(first.terminalId)).exited, true);
    await until(() => firstPids.every(p => !alive(p)), 'first owned tree exit');
    assert(alive(second.pid));
    await client.input(second.terminalId, 'still-alive');
    await until(() => (received.get(second.terminalId) ?? '').includes('still-alive:SIZE'), 'second unaffected');
    round.isolatedStop = true;
    await client.terminate(second.terminalId);
    round.stoppedInventory = await client.inventory();
    round.stoppingTree = (await identities([ready.descriptor.pid])).processes;
    for (const p of round.stoppingTree) ownedPids.add(p.ProcessId);
    client.disconnect(); client = undefined;
    await until(() => [...ownedPids].every(p => !alive(p)), 'all owned processes including daemon exit');
    round.remaining = (await identities([...ownedPids])).processes;
    assert.deepEqual(round.remaining, []);
    round.allExited = true;
  } catch (error) { round.error = `${error.stack}\n${output}`; throw error; }
  finally {
    client?.disconnect();
    // On a failed assertion, terminate only the known, isolated test daemon's
    // terminal roots, then the known test main/daemon (no user processes).
    if (!round.allExited) {
      const cleanup = await TerminalClient.connect(dataDir).catch(() => null);
      if (cleanup) {
        for (const s of await cleanup.inventory()) { await cleanup.attach(s.terminalId); await cleanup.terminate(s.terminalId).catch(() => {}); }
        cleanup.disconnect(); await delay(2000);
      }
    }
    if (alive(main.pid)) main.kill('SIGKILL');
    if (ready && alive(ready.descriptor.pid)) process.kill(ready.descriptor.pid, 'SIGKILL');
    await writeFile(join(artifact, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ artifact, mode, allExited: round.allExited, error: round.error }));
  }
}
