// room-windows.ts — extra full AhaStudio windows, one per project room, so two
// rooms can be watched side by side (like opening a Codex session in a new
// window). Each loads the same renderer with ?room=<cwd>; the renderer adopts
// the meeting main already runs for that folder instead of starting another.
//
// Main-window-only IPC also admits these senders (see validators.ts), and
// renderer pushes fan out to them through sendToAppWindows.
import { BrowserWindow, shell } from 'electron';
import { addRoomWindowSender, removeRoomWindowSender } from './room-window-senders.js';

const roomWindows = new Map<string, BrowserWindow>();

export interface RoomWindowOptions {
  preloadPath: string;
  backgroundColor: string;
  /** Vite dev server URL in development; packaged builds use app://bundle. */
  devServerUrl?: string;
}

/** Send to the main window (pass liveWindow()) and every open room window. */
export function sendToAppWindows(main: BrowserWindow | null, channel: string, payload: unknown): void {
  main?.webContents.send(channel, payload);
  for (const win of roomWindows.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

export function roomWindowUrl(cwd: string, devServerUrl?: string): string {
  const query = `room=${encodeURIComponent(cwd)}`;
  if (devServerUrl) return `${devServerUrl}${devServerUrl.includes('?') ? '&' : '?'}${query}`;
  return `app://bundle/index.html?${query}`;
}

export function openRoomWindow(cwd: string, title: string, opts: RoomWindowOptions): BrowserWindow {
  const existing = roomWindows.get(cwd);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return existing;
  }
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    title,
    backgroundColor: opts.backgroundColor,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  roomWindows.set(cwd, win);
  const senderId = win.webContents.id;
  addRoomWindowSender(senderId);
  win.on('closed', () => {
    removeRoomWindowSender(senderId);
    if (roomWindows.get(cwd) === win) roomWindows.delete(cwd);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') void shell.openExternal(url);
    } catch { /* ignore unparseable URLs */ }
    return { action: 'deny' };
  });
  const allowedOrigin = opts.devServerUrl ? new URL(opts.devServerUrl).origin : 'app://bundle';
  win.webContents.on('will-navigate', (event, url) => {
    try {
      const u = new URL(url);
      if (u.origin === allowedOrigin || (!opts.devServerUrl && u.protocol === 'app:')) return;
      event.preventDefault();
      if (u.protocol === 'http:' || u.protocol === 'https:') void shell.openExternal(url);
    } catch {
      event.preventDefault();
    }
  });

  void win.loadURL(roomWindowUrl(cwd, opts.devServerUrl)).catch((err) => {
    console.error('[room-window] load failed:', err);
  });
  return win;
}

export function closeAllRoomWindows(): void {
  for (const win of roomWindows.values()) if (!win.isDestroyed()) win.close();
  roomWindows.clear();
}
