// hidden-rooms.ts — 项目室「只从项目室隐藏」: which rooms the user hid on
// this machine. Kept free of runtime imports so node --test loads it directly.

import type { ProjectRoom } from './project-rooms';

/** Mirror of project-rooms.ts OTHER_ROOM_KEY (the catch-all room). */
const OTHER_ROOM_KEY = '__other__';

export const HIDDEN_ROOMS_STORAGE_KEY = 'aha.rooms.hidden';

/** Stable key a hidden room is remembered by. */
export function roomHideKey(room: ProjectRoom): string {
  return room.other ? OTHER_ROOM_KEY : room.cwd;
}

/** Split rooms into shown and hidden. Hiding only covers what was there at the
 *  time: opening the folder again afterwards brings the room back. */
export function partitionHiddenRooms(
  rooms: ProjectRoom[],
  hidden: Record<string, number>,
): { shown: ProjectRoom[]; hidden: ProjectRoom[] } {
  const shown: ProjectRoom[] = [];
  const out: ProjectRoom[] = [];
  for (const room of rooms) {
    const hiddenAt = hidden[roomHideKey(room)];
    (hiddenAt !== undefined && room.lastOpenedAt <= hiddenAt ? out : shown).push(room);
  }
  return { shown, hidden: out };
}

export function readHiddenRooms(): Record<string, number> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HIDDEN_ROOMS_STORAGE_KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, at]) => typeof at === 'number')) as Record<string, number>;
  } catch { return {}; }
}

export function writeHiddenRooms(hidden: Record<string, number>): void {
  try { localStorage.setItem(HIDDEN_ROOMS_STORAGE_KEY, JSON.stringify(hidden)); } catch { /* per-viewer only */ }
}
