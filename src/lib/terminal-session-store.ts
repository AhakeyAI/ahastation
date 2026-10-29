import { TerminalSession, INITIAL_TERMINAL_STATE, type PtyTerminalHandle } from './terminal-session';
import { TERMINAL_THEMES, type TerminalAppearance } from './terminal-appearance';

const sessions = new Map<string, TerminalSession>();
const listeners = new Set<() => void>();
let revision = 0;
const savedFont = Number(localStorage.getItem('aha.terminal.fontSize'));
let fontSize = savedFont >= 10 && savedFont <= 24 ? savedFont : 14;
let appearance: TerminalAppearance = localStorage.getItem('aha.terminal.appearance') === 'dark' ? 'dark' : 'light';

function notify() {
  revision++;
  for (const listener of listeners) listener();
}

export const terminalSessionStore = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => revision,
  getState: (id: string) => sessions.get(id)?.getSnapshot() ?? INITIAL_TERMINAL_STATE,
  getFontSize: () => fontSize,
  getAppearance: () => appearance,
  setAppearance(value: TerminalAppearance) {
    appearance = value;
    localStorage.setItem('aha.terminal.appearance', value);
    for (const session of sessions.values()) session.setTheme(TERMINAL_THEMES[value]);
    notify();
  },
  acquire(id: string, transport: PtyTerminalHandle) {
    let session = sessions.get(id);
    if (!session) {
      session = new TerminalSession(transport, fontSize, notify, TERMINAL_THEMES[appearance]);
      sessions.set(id, session);
    }
    return session;
  },
  async close(id: string) {
    const session = sessions.get(id);
    if (session) {
      await session.close();
      sessions.delete(id);
      notify();
    }
  },
  setFontSize(value: number) {
    fontSize = Math.max(10, Math.min(24, value));
    localStorage.setItem('aha.terminal.fontSize', String(fontSize));
    for (const session of sessions.values()) session.setFontSize(fontSize);
    notify();
  },
};
