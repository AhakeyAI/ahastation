import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, mkdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureTerminalDaemon } from '../dist-electron/terminal-daemon/launcher.js';
import { MAX_FRAME_BYTES, receive, send } from '../dist-electron/terminal-daemon/protocol.js';

const runtimePath = resolve(process.env.AHA_D1_TEST_RUNTIME ?? 'node_modules/electron/dist/electron.exe');
const entryPath = process.env.AHA_D1_TEST_RUNTIME
  ? join(dirname(runtimePath), 'resources/app.asar/dist-electron/terminal-daemon/entry.js') : undefined;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
test('Windows daemon authenticates, arbitrates concurrent starts/spawns and rejects stale controllers', {
  skip: process.platform !== 'win32', timeout: 25_000,
}, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aha-d1-protocol-'));
  const clients = [];
  let daemonPid;
  t.after(async () => {
    const first = clients.find(c => c);
    if (first) for (const s of await first.inventory().catch(() => [])) {
      await first.attach(s.terminalId); await first.terminate(s.terminalId);
    }
    clients.forEach(c => c.disconnect());
    for (let i = 0; i < 50 && alive(daemonPid); i++) await delay(100);
    assert.equal(alive(daemonPid), false, 'empty daemon exits with no native/thread residue');
  });
  const [a,b] = await Promise.all([ensureTerminalDaemon({ dataDir, runtimePath, entryPath }), ensureTerminalDaemon({ dataDir, runtimePath, entryPath })]);
  clients.push(a,b); daemonPid = a.descriptor.pid;
  assert.equal(a.descriptor.instanceId, b.descriptor.instanceId);
  const launch = { terminalId: randomUUID(), file: process.env.ComSpec, args: ['/d','/q'],
    cwd: dataDir, env: { ...process.env }, cols: 80, rows: 24, label: 'protocol' };
  const requestId = randomUUID();
  const [one,two] = await Promise.all([a.spawn(requestId, launch), b.spawn(requestId, launch)]);
  assert(one.pid > 0); assert.equal(two.pid, one.pid);
  assert.equal((await a.inventory()).length, 1);
  await assert.rejects(b.spawn(requestId, { ...launch, rows: 25 }), /different launch/);
  await assert.rejects(b.spawn(randomUUID(), launch), /already exists/);
  await a.attach(launch.terminalId);
  await b.attach(launch.terminalId, false);
  await assert.rejects(b.input(launch.terminalId, 'echo wrong\r'), /no controller lease/);
  await b.attach(launch.terminalId);
  await assert.rejects(a.input(launch.terminalId, 'echo stale\r'), /Stale/);
  await assert.rejects(a.resize(launch.terminalId, 90, 25), /Stale/);
  await assert.rejects(a.terminate(launch.terminalId), /Stale/);
  await b.input(launch.terminalId, 'echo valid\r');
  // Wrong token, wrong instance and operations before hello cannot read inventory.
  const token = await readFile(join(dataDir, 'credential'), 'utf8');
  for (const body of [
    { op: 'hello', version: 1, token: '0'.repeat(64), instanceId: a.descriptor.instanceId },
    { op: 'hello', version: 1, token, instanceId: randomUUID() },
    { op: 'inventory' },
  ]) {
    const socket = createConnection(a.descriptor.endpoint);
    const response = await new Promise(resolve => {
      socket.on('error', () => {}); receive(socket, resolve);
      socket.once('connect', () => send(socket, { id: randomUUID(), ...body }));
    });
    socket.destroy(); assert.equal(response.ok, false); assert.match(response.error, /authentication/);
  }
  const oversized = createConnection(a.descriptor.endpoint);
  await new Promise(resolve => {
    oversized.on('error', () => {}); oversized.on('close', resolve);
    oversized.on('connect', () => oversized.write(Buffer.alloc(MAX_FRAME_BYTES + 1, 65)));
  });
  assert.equal((await b.inventory()).length, 1);
  await b.detach(launch.terminalId);
  await assert.rejects(b.input(launch.terminalId, 'nope'), /no controller lease/);
  await a.attach(launch.terminalId);
  assert.equal((await a.terminate(launch.terminalId)).exited, true);
  const disk = await readFile(join(dataDir, 'sessions.json'), 'utf8');
  assert(!disk.includes(token)); assert(!disk.includes('"env"'));
});

test('Windows startup failure is session-local and persistence recovers after a failed write', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aha-d1-failure-'));
  const client = await ensureTerminalDaemon({ dataDir, runtimePath, entryPath });
  t.after(async () => {
    for (const s of await client.inventory()) {
      await client.attach(s.terminalId);
      await client.terminate(s.terminalId);
    }
    client.disconnect();
    for (let i = 0; i < 50 && alive(client.descriptor.pid); i++) await delay(100);
    assert.equal(alive(client.descriptor.pid), false);
  });
  const launch = { terminalId: randomUUID(), file: process.env.ComSpec, args: ['/d','/q'],
    cwd: dataDir, env: { ...process.env }, cols: 80, rows: 24, label: 'survivor' };
  const good = await client.spawn(randomUUID(), launch);
  await client.attach(good.terminalId);
  let output = '';
  client.onEvent(e => { if (e.event === 'output' && e.terminalId === good.terminalId) output += Buffer.from(e.data, 'base64').toString(); });
  const invalid = join(dataDir, 'invalid.exe');
  await writeFile(invalid, 'not a Windows executable');
  for (const change of [{ file: invalid }, { cwd: join(dataDir, 'missing-directory') }]) {
    const failedId = randomUUID();
    await assert.rejects(client.spawn(randomUUID(), { ...launch, ...change, terminalId: failedId }), /Cannot create process|directory/i);
    assert(alive(client.descriptor.pid)); assert(alive(good.pid));
    assert.equal((await client.inventory()).find(s => s.terminalId === failedId)?.exited, true);
  }
  await client.input(good.terminalId, 'echo AFTER_FAILURE\r');
  for (let i = 0; i < 50 && !output.includes('AFTER_FAILURE'); i++) await delay(50);
  assert.match(output, /AFTER_FAILURE/);

  const target = join(dataDir, 'sessions.json');
  const backup = join(dataDir, 'sessions.saved.json');
  await rename(target, backup);
  await mkdir(target);
  try { await assert.rejects(client.resize(good.terminalId, 81, 24), /EPERM|EISDIR|EACCES/); }
  finally { await rmdir(target); await rename(backup, target); }
  await client.resize(good.terminalId, 82, 25);
  const records = JSON.parse(await readFile(target, 'utf8')).records;
  assert.equal(records.find(s => s.terminalId === good.terminalId).cols, 82);
  assert.equal((await client.terminate(good.terminalId)).exited, true);
});
