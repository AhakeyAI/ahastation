import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test('remote member replies stay in their meeting and host after switching tabs; failed remote startup leaves local meeting running', async () => {
  const output = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/meeting-store.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node' });
  let incoming; let serial = 0; const calls = [];
  globalThis.window = { setTimeout, clearTimeout, setInterval, clearInterval, vibeMeet: {
    onEvent: (fn) => { incoming = fn; return () => {}; },
    sessions: {
      open: async (cwd) => ({ ok: true, sessionId: `meeting-${++serial}`, cwd, backendId: 'claude-code' }),
      setActive: async () => ({ ok: true }),
      addHost: async (...args) => { calls.push(args); return { ok: true, hostId: args[3].session_id }; },
    },
    transcripts: { load: async () => ({ ok: true, entries: [] }), append: async () => ({ ok: true }) },
  } };
  const { meetingStore: store } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  store.subscribe(() => {});
  try {
    await store.openSession('/fixture-one');
    incoming({ sessionId: 'meeting-1', source: 'system', kind: 'session-ready', hostId: 'default' });
    const a = { agent_id: 'desktop', provider: 'codex', session_id: 'remote-a', cwd: 'C:\\remote\\a', title: 'A' };
    const b = { ...a, provider: 'claude', session_id: 'remote-b', cwd: '/remote/b', title: 'B' };
    await store.addHostGroup('pocket-vibe', a); await store.addHostGroup('pocket-vibe', b);
    assert.deepEqual(calls[0], ['meeting-1', 'pocket-vibe', undefined, a]);
    assert.equal(store.getSnapshot().hostGroups.get('remote-b').remoteTarget.cwd, '/remote/b');
    await store.openSession('/fixture-two');
    const reply = (hostId, text) => incoming({ sessionId: 'meeting-1', source: 'talker', hostId, kind: 'message', message: {
      type: 'assistant', message: { content: [{ type: 'text', text }] },
    } });
    reply('remote-a', 'reply A'); reply('remote-b', 'reply B');
    assert.equal(store.getSnapshot().workers.has('talker:remote-a'), false);
    await store.setActive('meeting-1');
    assert.equal(store.getSnapshot().workers.get('talker:remote-a').lastText, 'reply A');
    assert.equal(store.getSnapshot().workers.get('talker:remote-b').lastText, 'reply B');
    assert.match(store.getSnapshot().workers.get('talker:remote-a').title, /^A ·/);
    incoming({ sessionId: 'meeting-1', source: 'system', hostId: 'remote-a', kind: 'session-start-failed', error: 'Hub offline' });
    assert.equal(store.getSnapshot().running, true);
    assert.equal(store.getSnapshot().workers.get('talker:remote-a').status, 'failed');
    assert.match(store.getSnapshot().lastError, /Hub offline/);
  } finally { store.dispose(); delete globalThis.window; }
});

test('restored remote references are visible before transport events without resuming a Hub turn id', async () => {
  const output = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/meeting-store.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node' });
  const remoteTarget = { agent_id: 'remote', provider: 'codex', session_id: 'native-saved', cwd: '/remote/project', title: 'Saved session' };
  globalThis.window = { setTimeout, clearTimeout, setInterval, clearInterval, vibeMeet: {
    onEvent: () => () => {},
    sessions: { open: async () => ({ ok: true, sessionId: 'restored', cwd: '/fixture', remoteHosts: [{ id: 'restored-host', remoteTarget }] }) },
    transcripts: { load: async () => ({ ok: true, entries: [] }) },
  } };
  const { meetingStore: store } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text + '\n//restore fixture').toString('base64')}`);
  try {
    await store.openSession('/fixture', undefined, 'recovery-id');
    assert.deepEqual(store.getSnapshot().hostGroups.get('restored-host').remoteTarget, remoteTarget);
    assert.match(store.getSnapshot().workers.get('talker:restored-host').title, /Saved session/);
  } finally { store.dispose(); delete globalThis.window; }
});

test('renderer blocks connecting/failed remote text and all remote files before IPC, keeping ordinary local input compatible', async () => {
  const output = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/meeting-store.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node' });
  let incoming; const sends = [];
  globalThis.window = { setTimeout, clearTimeout, setInterval, clearInterval, vibeMeet: {
    onEvent: (fn) => { incoming = fn; return () => {}; },
    sessions: { open: async () => ({ ok: true, sessionId: 'guards', cwd: '/fixture' }), addHost: async () => ({ ok: true, hostId: 'remote-pending' }) },
    sendUserText: async (...args) => { sends.push(['text', ...args]); return { ok: true }; },
    sendUserImage: async (...args) => { sends.push(['image', ...args]); return { ok: true }; },
    sendUserAttachments: async (...args) => { sends.push(['attachments', ...args]); return { ok: true }; },
    transcripts: { load: async () => ({ ok: true, entries: [] }), append: async () => ({ ok: true }) },
  } };
  const { meetingStore: store } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text + '\n//input guards').toString('base64')}`);
  store.subscribe(() => {});
  try {
    await store.openSession('/fixture');
    incoming({ sessionId: 'guards', source: 'system', kind: 'session-ready', hostId: 'default' });
    await store.addHostGroup('pocket-vibe', { agent_id:'a', device_id:'device', provider:'codex', session_id:'native', cwd:'/remote', title:'Remote' });
    await store.sendText('@REMOTE-PENDING do this');
    assert.match(store.getSnapshot().lastError, /尚未就绪/); assert.deepEqual(sends, []);
    const files = [{ name:'test.txt', kind:'text', mime:'text/plain', sizeBytes:4, dataBase64:'dGVzdA==' }];
    assert.equal((await store.sendAttachments(files, '@remote-pending file')).ok, false);
    await store.sendImage('data:image/png;base64,AAAA', '@remote-pending image');
    assert.deepEqual(sends, []);
    incoming({ sessionId:'guards', source:'system', hostId:'remote-pending', kind:'session-start-failed', error:'Hub unreachable' });
    await store.sendText('@remote-pending after failure'); assert.deepEqual(sends, []);
    incoming({ sessionId:'guards', source:'system', hostId:'remote-pending', kind:'session-ready' });
    await store.sendText('@remote-pending ready'); assert.equal(sends[0][0], 'text');
    assert.equal((await store.sendAttachments(files, '@remote-pending ready file')).ok, false);
    await store.sendText('local text');
    assert.equal((await store.sendAttachments(files, 'local file')).ok, true);
    assert.equal(sends.at(-1)[0], 'attachments');
  } finally { store.dispose(); delete globalThis.window; }
});
