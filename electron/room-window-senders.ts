// webContents ids of open project-room windows (room-windows.ts). Kept free of
// electron imports so IPC sender policies can consult it anywhere.
const ids = new Set<number>();

export function addRoomWindowSender(id: number): void { ids.add(id); }
export function removeRoomWindowSender(id: number): void { ids.delete(id); }
export function isRoomWindowSender(id: number): boolean { return ids.has(id); }
