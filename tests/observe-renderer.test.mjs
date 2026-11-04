import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

async function load(relative) {
  const source = await readFile(new URL(relative, import.meta.url), 'utf8');
  let output = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  for (const specifier of ['react', 'react/jsx-runtime']) {
    output = output.replaceAll(`"${specifier}"`, JSON.stringify(import.meta.resolve(specifier)))
      .replaceAll(`'${specifier}'`, JSON.stringify(import.meta.resolve(specifier)));
  }
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

test('renderer revocation event cannot be overwritten by a delayed initial snapshot', async (t) => {
  const previous = globalThis.window; t.after(() => { globalThis.window = previous; });
  let event, resolveSeed;
  globalThis.window = { vibeMeet: { observe: { onEvent: (callback) => { event = callback; },
    getSnapshot: () => new Promise((resolve) => { resolveSeed = resolve; }) } } };
  const { observedStore } = await load('../src/lib/observed-store.ts');
  observedStore.subscribe(() => {});
  const revoked = { sessions: [], scannedAt: 100, access: { enabled: false, roots: [] }, localProjects: [] };
  event(revoked);
  resolveSeed({ sessions: [{ title: 'Old private title' }], scannedAt: 100, access: { enabled: true, roots: ['/old'] }, localProjects: [{ label: 'Old private project' }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observedStore.getSnapshot(), revoked);
});

test('scan controls render off by default and expose read-only history without adoption actions', async (t) => {
  const previous = globalThis.window; t.after(() => { globalThis.window = previous; });
  globalThis.window = { vibeMeet: { observe: { allowDirectory: async () => ({ ok: true }), disable: async () => ({ ok: true }) } } };
  const { ScanControls } = await load('../src/components/ScanControls.tsx');
  const off = renderToStaticMarkup(createElement(ScanControls, { snapshot: { sessions: [], scannedAt: 1 } }));
  assert.match(off, /本机会话扫描未启用/); assert.match(off, /启用只读扫描/);
  assert.doesNotMatch(off, /停用并清除授权/);
  const on = renderToStaticMarkup(createElement(ScanControls, { snapshot: {
    sessions: [{ id: 's-1', title: '<private>', projectName: 'demo', state: 'unknown', origin: 'user-adopted', ownership: 'owned' }],
    scannedAt: 2, access: { enabled: true, roots: ['project'] }, diagnostics: ['ownership-unavailable'],
    studioTasks: [{ meetingId: 'm-1', taskId: 't-1', title: 'Historical task', status: 'done' }],
  } }));
  assert.match(on, /停用并清除授权/); assert.match(on, /已收编/); assert.match(on, /&lt;private&gt;/);
  assert.match(on, /Historical task/); assert.match(on, /待核对/);
  assert.doesNotMatch(on, />纳入<|>忽略<|>关闭会话</);
});

test('current board lanes retain idle in settled while excluding stale activity and unresolved ownership', async () => {
  const { subStatusForObserved, SUB_STATUS_META } = await load('../src/lib/task-columns.ts');
  const now = Date.now();
  const base = { lastActiveAt: now, ownership: 'unowned', origin: 'user' };
  assert.equal(SUB_STATUS_META[subStatusForObserved({ ...base, state: 'idle', pid: 1 }, now)].parent, 'settled');
  for (const state of ['active', 'waiting']) {
    assert.ok(subStatusForObserved({ ...base, state }, now));
    assert.equal(subStatusForObserved({ ...base, state, lastActiveAt: now - 86_400_000 }, now), null);
    assert.equal(subStatusForObserved({ ...base, state, ownership: 'unresolved' }, now), null);
  }
});

test('local project groups render worktrees, branches, detached HEAD and unresolved ownership without granting actions', async (t) => {
  const previous = globalThis.window; t.after(() => { globalThis.window = previous; });
  globalThis.window = { vibeMeet: { observe: { allowDirectory: async () => ({ ok: true }) } } };
  const { ScanControls } = await load('../src/components/ScanControls.tsx');
  const snapshot = { sessions: [
    { id: 's1', title: '<user session>', state: 'idle', clientKind: 'codex', origin: 'user' },
    { id: 's2', title: 'Adopted', state: 'unknown', clientKind: 'claude-code', origin: 'user-adopted' },
    { id: 's3', title: 'Unknown session', state: 'unknown', origin: 'unknown', ownership: 'unresolved' },
  ], access: { enabled: true, roots: ['/projects'] }, localProjects: [
    { key: 'p1', label: 'example/team', status: 'candidate', mounts: [
      { key: 'm1', label: 'main', path: '/projects/main', branch: 'feature/<branch>', sessionIds: ['s1'] },
      { key: 'm2', label: 'detached', path: '/projects/detached', branch: null, sessionIds: ['s2'] },
    ] },
    { key: 'p2', label: 'unknown', status: 'unresolved', reason: 'ownership-unresolved', mounts: [
      { key: 'm3', label: 'unknown', path: '/projects/unknown', branch: null, sessionIds: ['s3'] },
    ] },
  ] };
  const html = renderToStaticMarkup(createElement(ScanControls, { snapshot }));
  assert.match(html, /本机候选项目/); assert.match(html, /工作树/); assert.match(html, /feature\/&lt;branch&gt;/);
  assert.match(html, /分离 HEAD/); assert.match(html, /会话归属尚未确认/); assert.match(html, /已收编/);
  assert.match(html, /&lt;user session&gt;/); assert.doesNotMatch(html, />授权执行<|>共享<|>纳入</);
  const revoked = renderToStaticMarkup(createElement(ScanControls, { snapshot: { ...snapshot, access: { enabled: false, roots: [] } } }));
  assert.doesNotMatch(revoked, /example\/team|\/projects\/main|user session/);
});
