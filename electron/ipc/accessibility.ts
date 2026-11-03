// ipc/accessibility.ts — Accessibility permission check & guidance IPC.
// Computer Use mouse/keyboard actions need the macOS Accessibility permission;
// Windows and Linux report it as granted.

import { ipcMain } from 'electron';
import { isAccessibilityGranted, requestAccessibility } from '../computer-use.js';

export function registerAccessibilityIpc(): void {
  ipcMain.handle('accessibility:check', () => {
    return { granted: isAccessibilityGranted() };
  });

  ipcMain.handle('accessibility:request', () => {
    const granted = requestAccessibility();
    return { granted };
  });
}
