import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TerminalClient } from './client.js';
import { prepareDataDir } from './storage.js';

export interface DaemonLaunchOptions { dataDir: string; runtimePath: string; entryPath?: string }
/** runtimePath is the app's process.execPath (Electron), never PATH's node.
 * This module is also usable by isolated test mains without importing Electron. */
export async function ensureTerminalDaemon(options: DaemonLaunchOptions) {
  const dataDir = resolve(options.dataDir);
  await prepareDataDir(dataDir);
  try { return await TerminalClient.connect(dataDir); }
  catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
  const child = spawn(options.runtimePath, [options.entryPath ?? fileURLToPath(new URL('./entry.js', import.meta.url)), dataDir], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true, windowsHide: true, stdio: 'ignore', cwd: dataDir,
  });
  let launchError: Error | undefined;
  child.on('error', error => { launchError = error; });
  child.unref();
  // The endpoint bind is the single-instance arbiter. Concurrent losers never
  // overwrite the winner's descriptor; both launchers connect to the winner.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    try { return await TerminalClient.connect(dataDir); }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    await delay(100);
  }
  throw new Error('Terminal daemon startup timed out');
}
