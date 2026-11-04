import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { captureProcessSnapshot, findClientPids, openFilesFor, readLinuxProcessFiles,
  stopProcessSnapshotCapture } from '../dist-electron/observe/process/snapshot.js';
import { WindowsProcessReader } from '../dist-electron/observe/process/windows-reader.js';
import { associate, loadClaudePidFiles } from '../dist-electron/observe/mapping.js';

function helper() {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    unref() {}, killed: false, kill() { this.killed = true; } });
  const requests = [];
  child.stdin.on('data', (data) => requests.push(data.toString().trim()));
  return { child, requests, reply(id, json = '[]') { child.stdout.write(`AHA_PROCESS ${id} ${json}\r\n`); } };
}

test('Windows helper reuses its process, coalesces overlapping queries and handles chunked Unicode', async (t) => {
  const h = helper(); let starts = 0;
  const reader = new WindowsProcessReader({ spawnImpl(file, args, options) {
    starts++; assert.equal(file, 'powershell.exe'); assert.equal(options.windowsHide, true);
    assert.ok(args.includes('-EncodedCommand')); return h.child;
  } });
  t.after(() => reader.dispose());
  const first = reader.capture(); assert.equal(reader.capture(), first);
  const line = Buffer.from('AHA_PROCESS 1 [{"Name":"工具"}]\r\n');
  const split = line.indexOf(Buffer.from('工具')) + 1;
  h.child.stdout.write(line.subarray(0, split)); h.child.stdout.write(line.subarray(split));
  assert.deepEqual(JSON.parse(await first), [{ Name: '工具' }]);
  const second = reader.capture(); h.reply(2); assert.equal(await second, '[]');
  assert.equal(starts, 1); assert.deepEqual(h.requests, ['1', '2']);
});

test('Windows helper timeout kills the old process, and late output cannot satisfy a new request', async (t) => {
  const helpers = [helper(), helper()]; let starts = 0;
  const reader = new WindowsProcessReader({ timeoutMs: 30, spawnImpl: () => helpers[starts++].child });
  t.after(() => reader.dispose());
  await assert.rejects(reader.capture(), /snapshot unavailable/);
  assert.equal(helpers[0].child.killed, true);
  const next = reader.capture(); helpers[0].reply(1); helpers[1].reply(2);
  assert.equal(await next, '[]'); assert.equal(starts, 2);
});

test('Windows helper rejects bad frames, oversized data, errors and exit; diagnostics are not exposed', async () => {
  for (const fault of [
    (h) => h.child.stdout.write('AHA_PROCESS 999 []\n'),
    (h) => h.child.stdout.write('AHA_PROCESS 1 invalid\n'),
    (h) => h.child.stdout.write('x'.repeat(65)),
    (h) => h.child.emit('error', new Error('private path and command')),
    (h) => h.child.emit('exit', 1),
    (h) => h.reply('ERROR 1'),
  ]) {
    const h = helper();
    const reader = new WindowsProcessReader({ maxBytes: 64, spawnImpl: () => h.child });
    const promise = reader.capture(); fault(h);
    await assert.rejects(promise, { message: 'Process snapshot unavailable' });
    assert.equal(h.child.killed, true); reader.dispose();
  }
});

test('disposing an in-flight Windows helper rejects its query and permits a fresh capture', async (t) => {
  const old = helper(), fresh = helper(); let starts = 0;
  const reader = new WindowsProcessReader({ spawnImpl: () => starts++ ? fresh.child : old.child });
  t.after(() => reader.dispose());
  const cancelled = reader.capture(); reader.dispose();
  await assert.rejects(cancelled, { message: 'Process snapshot unavailable' });
  const next = reader.capture(); old.reply(1); fresh.reply(2);
  assert.equal(await next, '[]'); assert.equal(old.child.killed, true);
});

test('Windows file metadata never invokes lsof or another executable', async () => {
  const entries = await openFilesFor([1, 2], async () => { throw new Error('must not execute'); }, 'win32');
  assert.equal(entries.size, 0);
});

test('Linux proc traversal keeps readable links when another fd disappears', { skip: process.platform !== 'linux' }, async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'aha-proc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(join(root, '42', 'fd'), { recursive: true });
  await fs.symlink('/fixture project', join(root, '42', 'cwd'));
  await fs.symlink('/fixture/file.jsonl', join(root, '42', 'fd', '3'));
  await fs.symlink('socket:[123]', join(root, '42', 'fd', '4'));
  await fs.symlink('/gone (deleted)', join(root, '42', 'fd', '5'));
  await fs.writeFile(join(root, '42', 'fd', '6'), 'not a link');
  const map = await readLinuxProcessFiles([42, 43, 42, -1], root);
  assert.deepEqual(map.get(42), { cwd: '/fixture project', files: ['/fixture/file.jsonl'] });
  assert.deepEqual(map.get(43), { files: [] }); assert.equal(map.size, 2);
});

// Runs in every existing CI matrix job; no installed Claude/Codex or personal session data needed.
test('native process snapshot finds and associates real fixture Claude processes', { timeout: 30_000 }, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'aha process 测试 ')));
  const script = join(root, 'claude.mjs');
  const transcript = join(root, 'session.jsonl');
  const sessionId = 'c1a0de00-0000-4000-8000-0000000000ab';
  await fs.writeFile(transcript, '{}\n');
  await fs.writeFile(script, `import { openSync } from 'node:fs';
    const fd = openSync(${JSON.stringify(transcript)}, 'r');
    process.stdout.write('ready\\n'); setInterval(() => void fd, 1000);`);
  t.after(async () => { stopProcessSnapshotCapture(); await fs.rm(root, { recursive: true, force: true }); });
  for (const { label, args, via } of [
    { label: 'resume ID', args: ['--resume', sessionId], via: 'cmd-args' },
    { label: 'explicit directory', args: ['-C', root], via: 'cwd' },
    { label: 'Claude PID file', args: [], via: 'pid-file' },
  ]) await t.test(label, async (t) => {
    const child = spawn(process.execPath, [script, ...args],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    });
    await once(child.stdout, 'data');
    const snapshot = await captureProcessSnapshot();
    assert.equal(snapshot.childrenOf.get(process.pid)?.includes(child.pid), true, 'own descendants use the same platform snapshot');
    assert.ok(findClientPids(snapshot, ['claude']).includes(child.pid));
    const files = await openFilesFor([child.pid], process.platform === 'linux'
      ? async () => { throw new Error('Linux must use proc without lsof'); } : undefined);
    if (process.platform === 'linux') {
      assert.equal(files.get(child.pid)?.cwd, root);
      assert.ok(files.get(child.pid)?.files.includes(transcript));
    }
    const input = { clientKind: 'claude-code', pids: [child.pid], snapshot, lsofByPid: files,
      signals: [{ clientKind: 'claude-code', nativeSessionId: sessionId, cwd: root, filePath: transcript }],
      realpathOf: (path) => path, selfExclusion: { pids: new Set(), sessionIds: new Set() } };
    if (via === 'pid-file') {
      await fs.mkdir(join(root, '.claude', 'sessions'), { recursive: true });
      await fs.writeFile(join(root, '.claude', 'sessions', `${child.pid}.json`), JSON.stringify({ sessionId, cwd: root }));
      input.pidFileMap = await loadClaudePidFiles(root);
    }
    assert.deepEqual(associate(input).get(sessionId), { pid: child.pid, via });
    assert.equal(associate({ ...input, selfExclusion: { pids: new Set([child.pid]), sessionIds: new Set() } }).size, 0);
    // A second capture also exercises the persistent Windows process in a real environment.
    assert.ok((await captureProcessSnapshot()).byPid.has(child.pid));
  });
});
