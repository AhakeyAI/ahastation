// Minimal stub of the parts of `electron` that the orchestrator's transitive
// imports touch at module load time. Tests that write settings receive an
// isolated userData directory rather than racing on a shared /tmp/settings.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userData;
function testUserData() {
  if (!userData) {
    userData = mkdtempSync(join(tmpdir(), 'aha-test-userdata-'));
    process.once('exit', () => rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  }
  return userData;
}

export const app = {
  getPath: name => name === 'userData' ? testUserData() : '/tmp',
  isPackaged: false,
};
export const ipcMain = { handle: () => {}, on: () => {} };
export const desktopCapturer = {};
export const systemPreferences = {
  getMediaAccessStatus: () => 'granted',
  askForMediaAccess: async () => true,
};
export const shell = { openExternal: async () => {} };
export const dialog = { showMessageBox: async () => ({ response: 1 }) };
export const BrowserWindow = class {
  static getFocusedWindow() { return null; }
};
export const safeStorage = { encryptString: () => Buffer.alloc(0), decryptString: () => '' };
export const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) };
export const nativeTheme = { shouldUseDarkColors: false, on: () => {} };
export const webContents = { fromId: () => null };

export default { app, ipcMain, dialog, desktopCapturer, systemPreferences, shell, BrowserWindow, safeStorage, screen, nativeTheme, webContents };
