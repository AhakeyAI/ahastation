import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { App } from 'electron';

/** Metadata only: never log argv, URL, environment, prompts or credentials. */
export function installLifecycleLog(app: App): void {
  let dir = process.env.AHASTATION_LAUNCH_LOG_DIR;
  if (!dir) {
    try { dir = app.getPath('logs'); }
    catch { dir = join(tmpdir(), 'AhaStation-lifecycle'); }
  }
  const write = (event: string, fields: Record<string, string | number> = {}) => {
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'lifecycle.jsonl'), JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid, ...fields }) + '\n');
    } catch { /* Logging failure must not change application lifecycle. */ }
  };
  write('main-start', { parentPid: process.ppid, platform: process.platform });
  app.on('ready', () => write('ready'));
  app.on('second-instance', () => write('second-instance'));
  app.on('window-all-closed', () => write('window-all-closed'));
  app.on('before-quit', () => write('before-quit'));
  app.on('will-quit', () => write('will-quit'));
  app.on('browser-window-created', (_event, win) => {
    write('window-created', { windowId: win.id });
    win.on('close', () => write('window-close-request', { windowId: win.id }));
    win.on('closed', () => write('window-closed', { windowId: win.id }));
    win.webContents.on('render-process-gone', (_event, details) => write('renderer-exit', { reason: details.reason, exitCode: details.exitCode }));
    win.webContents.on('did-fail-load', (_event, code) => write('renderer-load-failed', { code }));
    win.webContents.on('did-finish-load', () => write('renderer-loaded', { windowId: win.id }));
  });
  app.on('child-process-gone', (_event, details) => write('child-exit', { type: details.type, reason: details.reason, exitCode: details.exitCode }));
  app.on('quit', (_event, code) => write('quit', { code }));
  process.on('exit', (code) => write('process-exit', { code }));
  process.on('uncaughtExceptionMonitor', () => write('uncaught-exception'));
}
