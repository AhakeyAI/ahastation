// computer-use.ts — desktop automation primitives for the Computer Use
// integration, the same on macOS, Windows and Linux: screenshots via
// Electron's desktopCapturer, mouse/keyboard/scroll via libnut.
//
// Every action checks accessibility permission (macOS) before executing and
// returns a typed result so the MCP layer can surface errors to the worker.

import { desktopCapturer, screen, systemPreferences } from 'electron';
import { createRequire } from 'node:module';

export interface ActionOk<T = void> {
  ok: true;
  data: T;
}

export interface ActionErr {
  ok: false;
  error: string;
  needsPermission?: 'accessibility';
}

export type ActionResult<T = void> = ActionOk<T> | ActionErr;

export interface ScreenshotData {
  pngBase64: string;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Native input — one implementation for macOS, Windows and Linux (X11) via
// libnut (the nut.js native core). Each platform package ships a prebuilt
// N-API binary, so the same code runs in Electron without a rebuild. It is
// loaded lazily: a missing or broken binary turns into an action error
// instead of breaking app start.

interface Libnut {
  moveMouse(x: number, y: number): void;
  mouseClick(button?: string, double?: boolean): void;
  scrollMouse(x: number, y: number): void;
  keyTap(key: string, modifier?: string | string[]): void;
  typeString(text: string): void;
  getMousePos(): { x: number; y: number };
}

const LIBNUT_PACKAGE: Partial<Record<NodeJS.Platform, string>> = {
  darwin: '@nut-tree-fork/libnut-darwin',
  win32: '@nut-tree-fork/libnut-win32',
  linux: '@nut-tree-fork/libnut-linux',
};

const nodeRequire = createRequire(import.meta.url);
let libnut: Libnut | null = null;
let libnutError: string | null = null;

function loadLibnut(): Libnut | ActionErr {
  if (libnut) return libnut;
  if (libnutError) return { ok: false, error: libnutError };
  const pkg = LIBNUT_PACKAGE[process.platform];
  if (!pkg) {
    libnutError = `Computer Use is not available on ${process.platform}`;
    return { ok: false, error: libnutError };
  }
  try {
    libnut = nodeRequire(pkg) as Libnut;
    return libnut;
  } catch (err) {
    libnutError = `Computer Use input module failed to load: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, error: libnutError };
  }
}

function runInput(action: (nut: Libnut) => void): ActionResult {
  const permErr = requireAccessibility();
  if (permErr) return permErr;
  const nut = loadLibnut();
  if ('ok' in nut) return nut;
  try {
    action(nut);
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Screenshot pixels → the coordinate space the OS input API expects.
 * macOS posts events in points, so divide by the display scale. Windows
 * (Electron is per-monitor DPI aware) and X11 take physical pixels, which
 * is what the screenshot is in. */
function toInputPoint(x: number, y: number): { x: number; y: number } {
  const scale = process.platform === 'darwin' ? screen.getPrimaryDisplay().scaleFactor || 1 : 1;
  return { x: Math.round(x / scale), y: Math.round(y / scale) };
}

// ---------------------------------------------------------------------------
// Accessibility permission gate — only macOS asks the user for it. Windows
// and X11 let a desktop app send input without a system permission.

export function isAccessibilityGranted(): boolean {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.isTrustedAccessibilityClient(false);
}

export function requestAccessibility(): boolean {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.isTrustedAccessibilityClient(true);
}

function requireAccessibility(): ActionErr | null {
  if (isAccessibilityGranted()) return null;
  return {
    ok: false,
    error: 'Accessibility permission not granted. Open System Settings → Privacy & Security → Accessibility and enable AhaStudio.',
    needsPermission: 'accessibility',
  };
}

// ---------------------------------------------------------------------------
// Screenshot — uses Electron desktopCapturer, no accessibility needed

export async function takeScreenshot(displayId?: number): Promise<ActionResult<ScreenshotData>> {
  try {
    const displays = screen.getAllDisplays();
    const target = displayId != null
      ? displays.find((d) => d.id === displayId) ?? displays[0]
      : screen.getPrimaryDisplay();

    if (!target) {
      return { ok: false, error: 'No display found' };
    }

    const scaleFactor = target.scaleFactor || 1;
    const logicalWidth = target.size.width;
    const logicalHeight = target.size.height;
    const pixelWidth = logicalWidth * scaleFactor;
    const pixelHeight = logicalHeight * scaleFactor;

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: pixelWidth, height: pixelHeight },
    });

    const displayIdStr = String(target.id);
    const source = sources.find((s) => s.display_id === displayIdStr) ?? sources[0];
    if (!source) {
      return { ok: false, error: 'No screen source available — check Screen Recording permission' };
    }

    const thumbnail = source.thumbnail;
    if (thumbnail.isEmpty()) {
      return { ok: false, error: 'Screenshot returned empty — Screen Recording permission may be denied' };
    }

    const pngBuffer = thumbnail.toPNG();
    const size = thumbnail.getSize();

    return {
      ok: true,
      data: {
        pngBase64: pngBuffer.toString('base64'),
        width: size.width,
        height: size.height,
      },
    };
  } catch (err) {
    return { ok: false, error: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Mouse actions

export type MouseButton = 'left' | 'right' | 'middle';

export async function mouseClick(
  x: number,
  y: number,
  button: MouseButton = 'left',
  clickCount: number = 1,
): Promise<ActionResult> {
  const point = toInputPoint(x, y);
  return runInput((nut) => {
    nut.moveMouse(point.x, point.y);
    if (clickCount === 2) {
      nut.mouseClick(button, true);
      return;
    }
    for (let i = 0; i < clickCount; i++) nut.mouseClick(button, false);
  });
}

export async function mouseMove(x: number, y: number): Promise<ActionResult> {
  const point = toInputPoint(x, y);
  return runInput((nut) => nut.moveMouse(point.x, point.y));
}

// ---------------------------------------------------------------------------
// Keyboard actions

/** Tool key names → libnut key names. `delete` keeps its macOS meaning
 * (the key left of backspace on Mac keyboards is labelled delete). */
const KEY_MAP: Record<string, string> = {
  return: 'enter', enter: 'enter', tab: 'tab', space: 'space',
  delete: 'backspace', backspace: 'backspace',
  escape: 'escape', esc: 'escape',
  up: 'up', down: 'down', left: 'left', right: 'right',
  home: 'home', end: 'end', pageup: 'pageup', pagedown: 'pagedown',
  f1: 'f1', f2: 'f2', f3: 'f3', f4: 'f4', f5: 'f5', f6: 'f6',
  f7: 'f7', f8: 'f8', f9: 'f9', f10: 'f10', f11: 'f11', f12: 'f12',
};

/** Workers write shortcuts the Mac way (cmd+c). On Windows and Linux the
 * same shortcut is Ctrl, so `command` maps to control there. */
function modifierFor(name: string): string | undefined {
  switch (name.toLowerCase()) {
    case 'command': case 'cmd': return process.platform === 'darwin' ? 'command' : 'control';
    case 'control': case 'ctrl': return 'control';
    case 'option': case 'alt': return 'alt';
    case 'shift': return 'shift';
    default: return undefined;
  }
}

export async function keyboardType(text: string): Promise<ActionResult> {
  const clean = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return runInput((nut) => nut.typeString(clean));
}

export async function keyboardPress(
  key: string,
  modifiers: string[] = [],
): Promise<ActionResult> {
  const keyLower = key.toLowerCase();
  const name = KEY_MAP[keyLower] ?? (keyLower.length === 1 && !/[\x00-\x1f\x7f]/.test(keyLower) ? keyLower : undefined);
  if (!name) {
    return { ok: false, error: `Unknown key: "${key}". Use a single character or one of: ${Object.keys(KEY_MAP).join(', ')}` };
  }
  const mods = modifiers.map(modifierFor).filter((m): m is string => !!m);
  return runInput((nut) => nut.keyTap(name, mods));
}

// ---------------------------------------------------------------------------
// Scroll

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

export async function scroll(
  x: number,
  y: number,
  direction: ScrollDirection,
  amount: number = 3,
): Promise<ActionResult> {
  const point = toInputPoint(x, y);
  const dy = direction === 'up' ? amount : direction === 'down' ? -amount : 0;
  const dx = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
  return runInput((nut) => {
    nut.moveMouse(point.x, point.y);
    nut.scrollMouse(dx, dy);
  });
}
