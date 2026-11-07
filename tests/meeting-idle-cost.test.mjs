import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadTs(rel) {
  const source = await readFile(new URL(rel, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

function fakeWindow() {
  const listeners = { win: new Map(), doc: new Map() };
  const doc = {
    visibilityState: 'visible',
    focused: true,
    hasFocus() { return this.focused; },
    documentElement: { dataset: {} },
    addEventListener: (t, f) => listeners.doc.set(t, f),
    removeEventListener: (t) => listeners.doc.delete(t),
  };
  const win = {
    addEventListener: (t, f) => listeners.win.set(t, f),
    removeEventListener: (t) => listeners.win.delete(t),
  };
  return { doc, win, listeners };
}

test('main window is flagged inactive while blurred or hidden, so CSS can pause animations', async () => {
  const { installWindowActivityFlag } = await loadTs('../src/lib/window-activity.ts');
  const { doc, win, listeners } = fakeWindow();
  const uninstall = installWindowActivityFlag(doc, win);
  assert.equal(doc.documentElement.dataset.windowActive, 'true');
  doc.focused = false; listeners.win.get('blur')();
  assert.equal(doc.documentElement.dataset.windowActive, 'false');
  doc.focused = true; listeners.win.get('focus')();
  assert.equal(doc.documentElement.dataset.windowActive, 'true');
  doc.visibilityState = 'hidden'; listeners.doc.get('visibilitychange')();
  assert.equal(doc.documentElement.dataset.windowActive, 'false');
  uninstall();
  assert.equal(listeners.win.size + listeners.doc.size, 0);
});

test('only the main window installs the flag, and the stylesheet pauses animations under it', async () => {
  const [main, css] = await Promise.all([
    readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  ]);
  assert.match(main, /if \(!viewParam\) installWindowActivityFlag\(\);/);
  assert.match(css, /:root\[data-window-active="false"\] \*,[^{]*\{\s*animation-play-state: paused !important;/);
});

test('muting pauses the VAD instead of running it and discarding frames', async () => {
  const src = await readFile(new URL('../src/hooks/useVoiceCapture.ts', import.meta.url), 'utf8');
  const pause = src.slice(src.indexOf('async function setVadPaused'), src.indexOf('interface UseVoiceCaptureOptions'));
  assert.match(pause, /await vad\.pause\(\);\s*await context\?\.suspend\(\);/);
  assert.match(pause, /await context\?\.resume\(\);\s*await vad\.start\(\);/);
  assert.match(src, /void setVadPaused\(vad, paused\)/);
  // MicVAD.new starts on load, so a mute that happened during init must pause afterwards.
  assert.match(src, /if \(pausedRef\.current\) await setVadPaused\(vad, true\);/);
  // We own the AudioContext, so release closes it; resume reopens the mic with the same AEC settings.
  assert.match(src, /MicVAD\.new\(\{\s*audioContext,/);
  assert.match(src, /getStream: openMic,\s*resumeStream: openMic,/);
  assert.match(src.slice(src.indexOf('async function releaseCapture')), /context\.close\(\)/);
});

test('mic meter repaints at most ~15 fps', async () => {
  const src = await readFile(new URL('../src/components/BottomToolbar.tsx', import.meta.url), 'utf8');
  assert.match(src, /const METER_FRAME_MS = 66;/);
  assert.doesNotMatch(src.slice(src.indexOf('export function MicMeter')), /requestAnimationFrame/);
});

test('app quit stops every opencode server, including ones an editor window still holds', async () => {
  const main = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const quit = main.slice(main.indexOf("app.on('before-quit'"));
  assert.match(quit, /peekOpencodeServerRegistry\(\)\?\.handleLifecycle\('appQuit'\)/);
  assert.ok(quit.indexOf('shutdownAllSlots()') < quit.indexOf("handleLifecycle('appQuit')"));
  assert.ok(quit.indexOf("handleLifecycle('appQuit')") < quit.indexOf('app.exit(0)'));
});

test('Windows stops opencode with taskkill /T /F; POSIX keeps SIGTERM', async () => {
  const src = await readFile(new URL('../electron/backends/opencode-server-process.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function killServerProcess'), src.indexOf('export async function spawnOpencodeServer'));
  assert.match(fn, /process\.platform === 'win32'/);
  assert.match(fn, /spawn\('taskkill', \['\/pid', String\(pid\), '\/T', '\/F'\]/);
  assert.match(fn, /process\.kill\(pid, 'SIGTERM'\)/);
  assert.doesNotMatch(src, /proc\.kill\('SIGTERM'\)/);
});
