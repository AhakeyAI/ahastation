import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  associate,
  detectMcpServerPids,
  extractSessionIdFromCommand,
  extractCwdFromCommand,
  loadClaudePidFiles,
  mcpHeldRolloutPaths,
} from '../dist-electron/observe/mapping.js';
import { parseLsofFieldOutput, parsePsOutput } from '../dist-electron/observe/process/snapshot.js';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'observe');
const psText = readFileSync(join(FIXTURES, 'ps-sample.txt'), 'utf8');
const snapshot = parsePsOutput(psText, 1_000);

const NO_SELF = { pids: new Set(), sessionIds: new Set() };
const identity = (p) => p;

function signal(clientKind, nativeSessionId, cwd, filePath = '/unused') {
  return {
    clientKind,
    nativeSessionId,
    cwd,
    filePath,
    mtimeMs: 1,
    sizeBytes: 1,
    tailSignals: clientKind === 'claude-code'
      ? { kind: 'claude', trailingRealUser: false, unclosedToolUse: false, messagesSeen: 2 }
      : { kind: 'codex', generating: false, pendingFunctionCalls: 0, sawTaskComplete: false, isExec: false, turnCount: 1 },
  };
}

// ---------------------------------------------------------------------------
// extractSessionIdFromCommand
// ---------------------------------------------------------------------------

test('cmd-arg extraction: space and = forms for every supported flag', () => {
  const id = 'c1a0de00-0000-4000-8000-000000000001';
  assert.equal(extractSessionIdFromCommand(`/usr/local/bin/claude --resume ${id}`), id);
  assert.equal(extractSessionIdFromCommand(`/usr/local/bin/claude --resume=${id}`), id);
  assert.equal(extractSessionIdFromCommand(`claude --session-id ${id}`), id);
  assert.equal(extractSessionIdFromCommand(`claude --session-id=${id}`), id);
  assert.equal(extractSessionIdFromCommand(`claude --resume-session-id=${id}`), id);
  assert.equal(extractSessionIdFromCommand(`claude --resume-session-id ${id}`), id);
  // codex resume <id> subcommand form
  assert.equal(extractSessionIdFromCommand(`/usr/local/bin/codex resume ${id}`), id);
  assert.equal(extractSessionIdFromCommand('/usr/local/bin/claude'), null);
  assert.equal(extractSessionIdFromCommand('claude --resume not-a-uuid'), null);
});

// ---------------------------------------------------------------------------
// Claude PID files
// ---------------------------------------------------------------------------

test('PID files: missing directory degrades to an empty map', async () => {
  const home = mkdtempSync(join(tmpdir(), 'observe-nopids-'));
  const map = await loadClaudePidFiles(home);
  assert.equal(map.size, 0);
});

// ---------------------------------------------------------------------------
// MCP suppression
// ---------------------------------------------------------------------------

test('MCP suppression: mcp-server pids detected, held rollouts collected', () => {
  const mcpPids = detectMcpServerPids(snapshot);
  assert.deepEqual(mcpPids, [4401]);
  const lsof = parseLsofFieldOutput(readFileSync(join(FIXTURES, 'lsof-sample.txt'), 'utf8'));
  const held = mcpHeldRolloutPaths(lsof, mcpPids);
  assert.equal(held.size, 2);
  for (const path of held) assert.match(path, /\.codex\/sessions\/.+\.jsonl$/);
});

// ---------------------------------------------------------------------------
// associate(): three fallbacks + self-exclusion
// ---------------------------------------------------------------------------

test('fallback 1: command-line session id wins', () => {
  const signals = [signal('claude-code', 'c1a0de00-0000-4000-8000-000000000001', '/somewhere/else')];
  const map = associate({
    clientKind: 'claude-code',
    pids: [4201],
    signals,
    snapshot,
    lsofByPid: new Map(),
    realpathOf: identity,
    selfExclusion: NO_SELF,
  });
  assert.deepEqual(map.get('c1a0de00-0000-4000-8000-000000000001'), { pid: 4201, via: 'cmd-args' });
});

test('fallback 2: PID file associates when cmd args do not', () => {
  const sid = 'c1a0de00-0000-4000-8000-000000000009';
  const signals = [signal('claude-code', sid, '/x')];
  const map = associate({
    clientKind: 'claude-code',
    pids: [4201],
    signals,
    snapshot: { ...snapshot, byPid: new Map([[4201, { ...snapshot.byPid.get(4201), command: 'claude' }]]) },
    lsofByPid: new Map(),
    pidFileMap: new Map([[4201, { sessionId: sid, cwd: '/x' }]]),
    realpathOf: identity,
    selfExclusion: NO_SELF,
  });
  assert.deepEqual(map.get(sid), { pid: 4201, via: 'pid-file' });
});

test('fallback 3a: cwd match associates via lsof cwd', () => {
  const sid = 'c1a0de00-0000-4000-8000-000000000010';
  const signals = [signal('claude-code', sid, '/Users/test/work/project-alpha')];
  const lsof = new Map([[4210, { cwd: '/Users/test/work/project-alpha', files: [] }]]);
  const map = associate({
    clientKind: 'claude-code',
    pids: [4210],
    signals,
    snapshot: { ...snapshot, byPid: new Map([[4210, { ...snapshot.byPid.get(4210), command: 'claude' }]]) },
    lsofByPid: lsof,
    realpathOf: identity,
    selfExclusion: NO_SELF,
  });
  assert.deepEqual(map.get(sid), { pid: 4210, via: 'cwd' });
});

test('fallback 3b: codex fd → rollout path', () => {
  const sid = 'd0de0000-0000-7000-8000-0000000000a1';
  const rollout = '/Users/test/.codex/sessions/2026/07/24/rollout-x-d0de0000-0000-7000-8000-0000000000a1.jsonl';
  const signals = [signal('codex', sid, '/elsewhere', rollout)];
  // lsof cwd does NOT match the signal cwd — only the open rollout fd can.
  const lsof = new Map([[4301, { cwd: '/unrelated', files: [rollout] }]]);
  const map = associate({
    clientKind: 'codex',
    pids: [4301],
    signals,
    snapshot,
    lsofByPid: lsof,
    realpathOf: identity,
    selfExclusion: NO_SELF,
  });
  assert.deepEqual(map.get(sid), { pid: 4301, via: 'fd' });
});

test('self-exclusion: own pid never associates', () => {
  const sid = 'c1a0de00-0000-4000-8000-000000000001';
  const signals = [signal('claude-code', sid, '/x')];
  const map = associate({
    clientKind: 'claude-code',
    pids: [4201],
    signals,
    snapshot,
    lsofByPid: new Map(),
    realpathOf: identity,
    selfExclusion: { pids: new Set([4201]), sessionIds: new Set() },
  });
  assert.equal(map.size, 0);
});

test('self-exclusion: own session id never associates', () => {
  const sid = 'c1a0de00-0000-4000-8000-000000000001';
  const signals = [signal('claude-code', sid, '/x')];
  const map = associate({
    clientKind: 'claude-code',
    pids: [4201],
    signals,
    snapshot,
    lsofByPid: new Map(),
    realpathOf: identity,
    selfExclusion: { pids: new Set(), sessionIds: new Set([sid]) },
  });
  assert.equal(map.size, 0);
});

test('quoted CLI IDs and absolute -C/--cd directories survive spaces without reading prompt flags', () => {
  const id = 'c1a0de00-0000-4000-8000-000000000001';
  const cwd = join(tmpdir(), 'project with spaces');
  assert.equal(extractSessionIdFromCommand(`"/tools with spaces/claude" --resume "${id}"`), id);
  assert.equal(extractSessionIdFromCommand(`claude -p "please --resume ${id}"`), null);
  assert.equal(extractSessionIdFromCommand(`claude --resume ${id}abc`), null);
  for (const flag of ['-C', '--cd', '--cd=']) {
    assert.equal(extractCwdFromCommand(`codex ${flag}${flag.endsWith('=') ? '' : ' '}"${cwd}"`), cwd);
  }
  assert.equal(extractCwdFromCommand('codex -C relative'), null);
  assert.equal(extractCwdFromCommand(`codex -C "${cwd}" --cd "${join(tmpdir(), 'other')}"`), null);
  assert.equal(extractCwdFromCommand('codex -C "unfinished'), null);
});

test('directory-only association requires exactly one process and one session', () => {
  const cwd = join(tmpdir(), 'project with spaces');
  const sid = 'c1a0de00-0000-4000-8000-000000000010';
  const processRow = { pid: 42, command: `codex -C "${cwd}"` };
  const input = { clientKind: 'codex', pids: [42], signals: [signal('codex', sid, cwd)],
    snapshot: { byPid: new Map([[42, processRow]]) }, lsofByPid: new Map(), realpathOf: identity, selfExclusion: NO_SELF };
  assert.deepEqual(associate(input).get(sid), { pid: 42, via: 'cwd' });
  assert.equal(associate({ ...input, signals: [...input.signals, signal('codex', 'other', cwd)] }).size, 0);
  assert.equal(associate({ ...input, pids: [42, 43], snapshot: { byPid: new Map([[42, processRow], [43, processRow]]) } }).size, 0);
});

test('open rollout identifies a Codex session before a different cwd match; multiple rollouts stay unknown', () => {
  const signals = [signal('codex', 'cwd-session', '/project'), signal('codex', 'fd-session', '/elsewhere', '/rollout')];
  const input = { clientKind: 'codex', pids: [42], signals, snapshot: { byPid: new Map() },
    lsofByPid: new Map([[42, { cwd: '/project', files: ['/rollout'] }]]), realpathOf: identity, selfExclusion: NO_SELF };
  assert.deepEqual([...associate(input)], [['fd-session', { pid: 42, via: 'fd' }]]);
  assert.equal(associate({ ...input, lsofByPid: new Map([[42, { cwd: '/project', files: ['/rollout', '/unused'] }]]) }).size, 0);
});

test('an explicit unknown resume ID cannot be reassigned to a different cwd or PID-file session', () => {
  const input = { clientKind: 'claude-code', pids: [4201], snapshot,
    signals: [signal('claude-code', 'other', '/project')], lsofByPid: new Map([[4201, { cwd: '/project', files: [] }]]),
    pidFileMap: new Map([[4201, { sessionId: 'other' }]]), realpathOf: identity, selfExclusion: NO_SELF };
  assert.equal(associate(input).size, 0);
});
