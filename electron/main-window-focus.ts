import type { BrowserWindow } from 'electron';

/** A settings/AhaBar window may keep the app alive after main was closed. */
export function focusMainWindow(getWindow: () => BrowserWindow | null, createWindow: () => void): void {
  if (!getWindow()) createWindow();
  const win = getWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
