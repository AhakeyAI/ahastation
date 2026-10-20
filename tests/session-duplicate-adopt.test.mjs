import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Regression: leaving a meeting, then clicking the same cwd under
// "Recent meetings" must always re-enter. Main returned
// { ok:false, error:'duplicate', sessionId } (the session outlived the
// renderer across a window reload), and the renderer's duplicate branch
// called setActive() on a slot it no longer had — a silent no-op, so the
// click appeared dead with no error.

test('openSession duplicate branch adopts the main-side live session', () => {
  const store = read('src/lib/meeting-store.ts');
  const openBody = store.slice(store.indexOf('async openSession('));
  const duplicateIdx = openBody.indexOf("res.error === 'duplicate'");
  assert.notEqual(duplicateIdx, -1, 'openSession must handle the duplicate reply');
  const branch = openBody.slice(duplicateIdx, openBody.indexOf('return { ok: false, error: res.error };', duplicateIdx));
  assert.match(branch, /adoptLiveSession\(res\.sessionId,/,
    'duplicate branch must adopt the live session, not bare-setActive a missing slot');
  assert.doesNotMatch(branch, /await this\.setActive\(res\.sessionId\);\s*return/,
    'bare setActive no-ops when the renderer has no slot for the session');
});

test('adoptLiveSession rebuilds a local slot and queries actual host readiness', () => {
  const store = read('src/lib/meeting-store.ts');
  const body = store.slice(store.indexOf('private async adoptLiveSession('));
  assert.match(body, /window\.vibeMeet\.sessions\.list\(\)/);
  assert.match(body, /attachExisting\(slot, meta\.id, meta\.cwd\)/);
  assert.doesNotMatch(body.slice(0, body.indexOf('async openSession(')), /running: true/,
    'adopting a registry entry must not assume the host is running');
  assert.match(body, /this\.slots\.set\(slot\.id, slot\)/);
  assert.match(body, /this\.activeId = slot\.id/);
  assert.match(body, /loadHistoryForSlot\(live\)/);
  assert.match(body, /ok: false, error: 'Meeting is no longer running; please try again'/,
    'a session that vanished between duplicate and list must surface a retryable error');
});

test('resumePlaceholder duplicate branch cannot strand a slot-less activeId', () => {
  const store = read('src/lib/meeting-store.ts');
  const body = store.slice(store.indexOf('async resumePlaceholder('));
  const duplicateIdx = body.indexOf("res.error === 'duplicate'");
  assert.notEqual(duplicateIdx, -1);
  const branch = body.slice(duplicateIdx, body.indexOf('return { ok: false, error: res.error };', duplicateIdx));
  assert.match(branch, /adoptLiveSession\(res\.sessionId,/);
  assert.doesNotMatch(branch, /this\.activeId = res\.sessionId/,
    'pointing activeId at a slot-less id strands the user on the Lobby');
});

test('closeTab bounds the sessions.close wait so Leave always tears down locally', () => {
  const store = read('src/lib/meeting-store.ts');
  assert.match(store, /CLOSE_IPC_TIMEOUT_MS = 10_000/);
  const body = store.slice(store.indexOf('async closeTab('));
  assert.match(body, /Promise\.race\(\[\s*window\.vibeMeet\.sessions\.close\(id\)/);
  assert.match(body, /sessions\.close timed out/);
  assert.match(body, /this\.slots\.delete\(id\)/);
});

test('main sessions:close bounds orchestrator.end() and always frees the registry slot', () => {
  const ipc = read('electron/ipc/sessions.ts');
  assert.match(ipc, /END_TIMEOUT_MS = 15_000/);
  const body = ipc.slice(ipc.indexOf("ipcMain.handle('sessions:close'"));
  assert.match(body, /Promise\.race\(\[\s*slot\.orchestrator\.end\(\)/);
  assert.match(body, /endTimedOut/);
  assert.match(body, /ctx\.registry\.close\(id\)/);
});

test('leave never lets cancelSpeech/stopShare skip closeTab', () => {
  const app = read('src/App.tsx');
  const body = app.slice(app.indexOf('const leave = useCallback('));
  const closeIdx = body.indexOf('meetingStore.closeTab(id)');
  assert.notEqual(closeIdx, -1);
  const preClose = body.slice(0, closeIdx);
  assert.match(preClose, /try \{ cancelSpeech\(\); \} catch/);
  assert.match(preClose, /try \{ stopShare\(\); \} catch/);
});
