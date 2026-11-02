import { startTerminalDaemon } from '../../dist-electron/terminal-daemon/entry.js';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { endpointFor, prepareDataDir } from '../../dist-electron/terminal-daemon/storage.js';
import { send } from '../../dist-electron/terminal-daemon/protocol.js';

const dataDir = process.argv[2];
await prepareDataDir(dataDir);
await assert.rejects(startTerminalDaemon(dataDir, async endpoint => {
  // Probe the actual listening endpoint while its DACL setup is incomplete.
  await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    socket.on('error', () => {});
    socket.on('data', () => reject(new Error('Unauthenticated startup connection received data')));
    socket.on('close', resolve);
    socket.on('connect', () => send(socket, { id: randomUUID(), op: 'inventory' }));
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Startup connection remained open')); });
  });
  await assert.rejects(access(join(dataDir, 'daemon.json')));
  throw new Error('Injected ACL setup failure');
}), /Injected ACL setup failure/);
await assert.rejects(access(join(dataDir, 'daemon.json')));
await new Promise((resolve, reject) => {
  const socket = createConnection(endpointFor(dataDir));
  socket.on('error', () => { socket.destroy(); resolve(); });
  socket.on('connect', () => { socket.destroy(); reject(new Error('Failed startup retained a listening endpoint')); });
});
await writeFile(join(dataDir, 'result.json'), JSON.stringify({ preReadyRejected: true, aclFailureClosed: true }));
