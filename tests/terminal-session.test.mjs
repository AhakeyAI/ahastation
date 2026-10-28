import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Exercise the renderer owner with deterministic create/terminate promises.
// Real xterm/ConPTY rendering is validated separately in the browser smoke.
class TestTerminal {
  options = {};
  unicode = {};
  rows = 24;
  cols = 80;
  writes = [];
  disposed = false;
  loadAddon() {}
  open() {}
  focus() {}
  blur() {}
  refresh() {}
  onData(cb) { this.send = cb; return { dispose() {} }; }
  onTitleChange() { return { dispose() {} }; }
  write(data) {
    const value = new TextDecoder().decode(data);
    this.writes.push(value);
    if (value.includes('\x1b[5n')) this.send('\x1b[0n');
  }
  dispose() { this.disposed = true; }
}
globalThis.__terminalTest = { Terminal: TestTerminal, FitAddon: class { fit() {} }, Unicode11Addon: class {} };
globalThis.document = { createElement: () => ({ remove() {} }) };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {} };

const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText).toString('base64')}`;
const sessionSource = await readFile(new URL('../src/lib/terminal-session.ts', import.meta.url), 'utf8');
const sessionUrl = moduleUrl('const {Terminal, FitAddon, Unicode11Addon} = globalThis.__terminalTest;\n'
  + sessionSource.replace(/^import .*;\r?\n/gm, ''));
const { TerminalSession } = await import(sessionUrl);
const storeSource = await readFile(new URL('../src/lib/terminal-session-store.ts', import.meta.url), 'utf8');
const appearanceUrl = moduleUrl(await readFile(new URL('../src/lib/terminal-appearance.ts', import.meta.url), 'utf8'));
const storeUrl = moduleUrl(storeSource.replace("'./terminal-session'", JSON.stringify(sessionUrl))
  .replace("'./terminal-appearance'", JSON.stringify(appearanceUrl)));
const { terminalSessionStore } = await import(storeUrl);
globalThis.__browserTest = { setVisible: async () => {} };
const stageSource = await readFile(new URL('../src/lib/stage-window-store.ts', import.meta.url), 'utf8');
const { stageWindowStore } = await import(moduleUrl(stageSource
  .replace("import { browserStore } from './browser-store';", 'const browserStore = globalThis.__browserTest;')
  .replace("'./terminal-session-store'", JSON.stringify(storeUrl))));

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { resolve, promise }; };
const encoded = (value) => Buffer.from(value).toString('base64');
const host = { appendChild() {}, isConnected: true, clientWidth: 800, clientHeight: 600 };
function fixture() {
  const create = deferred();
  const data = new Set();
  const exit = new Set();
  const calls = { attach: 0, input: [], kill: 0 };
  const transport = {
    expectedPtyId: 'local-a',
    attach: () => { calls.attach++; return create.promise; },
    input: (_id, value) => { calls.input.push(value); }, resize() {},
    dispose: async () => { calls.kill++; },
    onData: (cb) => { data.add(cb); return () => data.delete(cb); },
    onExit: (cb) => { exit.add(cb); return () => exit.delete(cb); },
  };
  const session = new TerminalSession(transport, 14, () => {});
  const emit = (value, sequence) => { for (const cb of data) cb({ ptyId: 'local-a', data: encoded(value), sequence }); };
  const ready = async (extra = {}) => { create.resolve({ ok: true, ptyId: 'local-a', replay: '', ...extra }); await session.connection; };
  return { session, create, data, exit, calls, transport, emit, ready };
}

test('closing during create never reopens input and terminates exactly once', async () => {
  const f = fixture();
  f.session.mount(host);
  f.emit('early', 1);
  const termination = deferred();
  f.transport.dispose = async () => { f.calls.kill++; await termination.promise; };
  const close = f.session.close();
  assert.equal(f.session.close(), close);
  await f.ready({ replay: encoded('\x1b[5n') });
  assert.equal(f.session.getSnapshot().phase, 'closing');
  f.session.terminal.send('must not send');
  for (const cb of f.exit) cb({ ptyId: 'local-a', exitCode: 0 });
  assert.equal(f.session.getSnapshot().phase, 'closing');
  assert.deepEqual(f.calls.input, []);
  termination.resolve();
  await close;
  assert.equal(f.calls.kill, 1);
  assert.equal(f.data.size + f.exit.size, 0);
  assert.equal(f.session.pending.length, 0);
  assert.equal(f.session.terminal.disposed, true);
});

test('failed create releases stream subscriptions and queued output', async () => {
  for (const result of [{ ok: false, error: 'offline failure' }, new Error('rejected create')]) {
    const f = fixture();
    f.session.mount(host);
    f.emit('pending', 1);
    if (result instanceof Error) f.create.resolve(Promise.reject(result)); else f.create.resolve(result);
    await f.session.connection;
    assert.equal(f.session.getSnapshot().phase, 'error');
    assert.equal(f.data.size + f.exit.size, 0);
    assert.equal(f.session.pendingSize, 0);
    await f.session.close();
    assert.equal(f.calls.kill, 0);
  }
});

test('startup device replies use input transport and sequence handoff writes only once', async () => {
  const f = fixture();
  f.session.mount(host);
  f.emit('snapshot-covered', 1);
  f.emit('live-after-snapshot', 2);
  await f.ready({ replay: encoded('\x1b[5n'), sequence: 1 });
  await Promise.resolve();
  assert.deepEqual(f.calls.input, ['\x1b[0n']);
  assert.deepEqual(f.session.terminal.writes, ['\x1b[5n', 'live-after-snapshot']);
  await f.session.close();
});

test('pending bytes and event count are bounded and overflow is visible', async () => {
  for (const flood of [f => f.emit('x'.repeat(800_000), 1), f => { for (let i = 0; i < 4097; i++) f.emit('x', i); }]) {
    const f = fixture();
    f.session.mount(host);
    flood(f);
    assert.equal(f.session.pendingSize, 0);
    assert.equal(f.session.pending.length, 0);
    assert.match(f.session.getSnapshot().error, /缓冲上限/);
    await f.ready();
    assert.equal(f.session.getSnapshot().phase, 'error');
    assert.equal(f.data.size + f.exit.size, 0);
    await f.session.close();
    assert.equal(f.calls.kill, 1);
  }
});

test('mounting again retains the same terminal and exited tabs never create again', async () => {
  const f = fixture();
  const terminal = f.session.terminal;
  f.session.mount(host);
  await f.ready({ exited: true, exitCode: 7 });
  f.session.unmount(host);
  f.session.mount(host);
  assert.equal(f.session.terminal, terminal);
  assert.equal(f.calls.attach, 1);
  assert.equal(f.session.getSnapshot().phase, 'exited');
  await f.session.close();
  f.session.mount(host);
  assert.equal(f.calls.attach, 1);
});

test('stage close has one owner, preserves failed-close tab and blocks input until retry', async () => {
  const f = fixture();
  await stageWindowStore.createWindow('terminal', { localCliId: 'shell', shellId: 'cmd', cwd: 'C:/snapshot' });
  const tab = stageWindowStore.getSnapshot().windows.at(-1);
  const session = terminalSessionStore.acquire(tab.id, f.transport);
  session.mount(host);
  f.create.resolve({ ok: true, ptyId: 'local-a', replay: '' });
  await session.connection;
  let fail = true;
  f.transport.dispose = async () => { f.calls.kill++; if (fail) throw new Error('access denied'); };
  await stageWindowStore.closeWindow(tab.id);
  assert.ok(stageWindowStore.getSnapshot().windows.some(win => win.id === tab.id));
  assert.match(session.getSnapshot().error, /关闭失败/);
  session.unmount(host);
  session.mount(host);
  assert.equal(session.host, host, 'failed-close screen can be shown again without reopening input');
  assert.equal(session.terminal.options.disableStdin, true);
  session.terminal.send('blocked');
  assert.deepEqual(f.calls.input, []);
  fail = false;
  await Promise.all([stageWindowStore.closeWindow(tab.id), stageWindowStore.closeWindow(tab.id)]);
  assert.equal(f.calls.kill, 2, 'one failed attempt and one successful retry, no stage-level kill');
  assert.equal(stageWindowStore.getSnapshot().windows.some(win => win.id === tab.id), false);
  await f.session.close();
});

test('a tab closed before its first mount creates no process', async () => {
  const f = fixture();
  await f.session.close();
  f.session.mount(host);
  assert.equal(f.calls.attach, 0);
  assert.equal(f.calls.kill, 0);
});
