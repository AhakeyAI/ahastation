// Minimal stub of the parts of `electron` that the orchestrator's transitive
// imports touch at module load time. The test never reaches code that calls
// these — they exist only so `import { app } from 'electron'` resolves.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_USER_DATA_DIR = mkdtempSync(join(tmpdir(), 'ahastation-electron-stub-'));
export const testMeetingsPath = (meetingId) => join(TEST_USER_DATA_DIR, 'meetings', meetingId);
export const testSettingsPath = () => join(TEST_USER_DATA_DIR, 'settings.json');
process.once('exit', () => rmSync(TEST_USER_DATA_DIR, { recursive: true, force: true }));

export const app = {
  getPath: () => TEST_USER_DATA_DIR,
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
