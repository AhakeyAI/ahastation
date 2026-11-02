// A project room opened in its own window (electron/room-windows.ts) loads the
// app with ?room=<cwd>. That window shows only this room and never moves the
// main window's focus.

export function roomWindowCwd(search: string = globalThis.location?.search ?? ''): string | null {
  const cwd = new URLSearchParams(search).get('room');
  return cwd ? cwd : null;
}

export function isRoomWindow(): boolean {
  return roomWindowCwd() !== null;
}
