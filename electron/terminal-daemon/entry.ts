import { createServer, type Socket } from 'node:net';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, chmod, unlink } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PtyHost } from '../pty-host.js';
import { TerminalSessions } from '../terminal-sessions.js';
import { PROTOCOL_VERSION, CAPABILITIES, receive, requestSchema, send, type Descriptor, type DaemonEvent, type Request } from './protocol.js';
import { endpointFor, atomicJson, restrictPipeAccess } from './storage.js';

export async function startTerminalDaemon(dataDir: string, secureEndpoint = restrictPipeAccess) {
  dataDir = resolve(dataDir);
  const token = await readFile(join(dataDir, 'credential'), 'utf8');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local credential');
  const descriptor: Descriptor = { schemaVersion: 1, protocolVersion: PROTOCOL_VERSION,
    instanceId: randomUUID(), pid: process.pid, startedAt: new Date().toISOString(), endpoint: endpointFor(dataDir) };
  type Peer = { socket: Socket; authenticated: boolean; attached: Set<string> };
  const peers = new Set<Peer>();
  const controllers = new Map<string, { peer: Peer; generation: number }>();
  let generation = 0;
  const requests = new Map<string, { digest: string; terminalId: string; operation: Promise<unknown> }>();
  const stopping = new Map<string, Promise<unknown>>();
  let metadata = Promise.resolve();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let ready = false;
  const broadcast = (event: DaemonEvent) => {
    for (const peer of peers) if (peer.authenticated && peer.attached.has(event.terminalId)) send(peer.socket, event);
  };
  const sessions = new TerminalSessions(new PtyHost(), {
    data: e => broadcast({ event: 'output', terminalId: e.ptyId, data: e.data, sequence: e.sequence }),
    exit: e => { broadcast({ event: 'exit', terminalId: e.ptyId, exitCode: e.exitCode }); void persist(); idle(); },
  });
  function persist() {
    const records = sessions.list();
    // Report this write's failure, but let a later operation retry the disk.
    metadata = metadata.catch(() => {}).then(() => atomicJson(dataDir, 'sessions.json', { schemaVersion: 1, instanceId: descriptor.instanceId, records }));
    // A disk failure must not become an unhandled rejection or silently certify a write.
    metadata.catch(() => {});
    return metadata;
  }
  function idle() {
    clearTimeout(idleTimer);
    if (ready && !sessions.list().some(s => !s.exited || s.terminationError) && ![...peers].some(p => p.authenticated)) {
      idleTimer = setTimeout(() => { server.close(); }, 1500);
    }
  }
  async function handle(peer: Peer, request: Request): Promise<unknown> {
    if (!peer.authenticated) {
      if (request.op !== 'hello' || request.instanceId !== descriptor.instanceId ||
        !timingSafeEqual(Buffer.from(request.token), Buffer.from(token))) throw new Error('Terminal authentication failed');
      peer.authenticated = true; clearTimeout(idleTimer);
      return { ...descriptor, capabilities: CAPABILITIES };
    }
    switch (request.op) {
      case 'hello': throw new Error('Already authenticated');
      case 'inventory': return sessions.list();
      case 'spawn': {
        const digest = createHash('sha256').update(JSON.stringify(request.launch)).digest('hex');
        const previous = requests.get(request.requestId);
        if (previous) {
          if (previous.digest !== digest) throw new Error('requestId reused with different launch parameters');
          await previous.operation;
          return sessions.get(previous.terminalId);
        }
        if (requests.size >= 4096 || sessions.list().length >= 128) throw new Error('Daemon session/request capacity reached');
        if (sessions.get(request.launch.terminalId)) throw new Error('terminalId already exists; attach instead');
        if (!isAbsolute(request.launch.file) || !isAbsolute(request.launch.cwd)) throw new Error('Absolute executable and cwd required');
        const { terminalId, label, ...options } = request.launch;
        // Electron's own runtime switches must not leak into manual commands.
        delete options.env.ELECTRON_RUN_AS_NODE; delete options.env.ELECTRON_NO_ASAR;
        sessions.create(terminalId, options, label);
        clearTimeout(idleTimer);
        const operation = sessions.ready(terminalId).then(async result => { await persist(); return result; });
        requests.set(request.requestId, { digest, terminalId, operation });
        return await operation;
      }
      case 'attach': {
        const snapshot = sessions.get(request.terminalId);
        if (!snapshot) throw new Error('Unknown terminal');
        peer.attached.add(request.terminalId);
        const lease = request.control ? ++generation : 0;
        if (request.control) controllers.set(request.terminalId, { peer, generation: lease });
        // This is a bounded byte tail and sequence, not a D3 screen snapshot.
        return { ...snapshot, generation: lease };
      }
      case 'detach': {
        peer.attached.delete(request.terminalId);
        if (controllers.get(request.terminalId)?.peer === peer) controllers.delete(request.terminalId);
        return { ok: true };
      }
      default: {
        const lease = controllers.get(request.terminalId);
        if (lease?.peer !== peer || lease.generation !== request.generation) throw new Error('Stale terminal controller');
        if (request.op === 'input') {
          const result = sessions.input(request.terminalId, request.data);
          if (!result.ok) throw new Error(result.error ?? 'Terminal input failed');
          return result;
        }
        if (request.op === 'resize') {
          const result = sessions.resize(request.terminalId, request.rows, request.cols);
          if (!result.ok) throw new Error('Terminal resize failed');
          await persist(); return result;
        }
        let operation = stopping.get(request.terminalId);
        if (!operation) {
          operation = sessions.terminate(request.terminalId).finally(() => stopping.delete(request.terminalId));
          stopping.set(request.terminalId, operation);
        }
        try { return await operation; }
        finally { await persist(); idle(); }
      }
    }
  }
  const server = createServer(socket => {
    if (peers.size >= 32 || !ready) { socket.destroy(); return; }
    const peer: Peer = { socket, authenticated: false, attached: new Set() };
    peers.add(peer);
    const authTimer = setTimeout(() => { if (!peer.authenticated) socket.destroy(); }, 3000);
    let queue = Promise.resolve();
    let queued = 0;
    receive(socket, frame => {
      const parsed = requestSchema.safeParse(frame);
      if (!parsed.success || ++queued > 128) { socket.destroy(); return; }
      const request = parsed.data;
      queue = queue.then(async () => {
        if (socket.destroyed) return;
        try { send(socket, { id: request.id, ok: true, result: await handle(peer, request) }); }
        catch (error) {
          send(socket, { id: request.id, ok: false, error: error instanceof Error ? error.message : 'Terminal operation failed' });
          if (!peer.authenticated) socket.end();
        }
      }).finally(() => { queued--; });
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(authTimer); peers.delete(peer);
      for (const [id, lease] of controllers) if (lease.peer === peer) controllers.delete(id);
      idle();
    });
  });
  // Only the successful binder writes discovery. No PID-based stale lock stealing.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ path: descriptor.endpoint, readableAll: false, writableAll: false }, resolve);
  });
  try {
    if (process.platform !== 'win32') await chmod(descriptor.endpoint, 0o600);
    await secureEndpoint(descriptor.endpoint);
    await atomicJson(dataDir, 'daemon.json', descriptor);
    await persist();
  } catch (error) {
    server.close();
    throw error;
  }
  ready = true; idle();
  server.on('close', () => {
    if (process.platform !== 'win32') void unlink(descriptor.endpoint).catch(() => {});
    // node-pty's Windows conout workers can outlive a naturally closed socket.
    // No live terminals or clients remain; flush metadata and release the host
    // process (and its native handles/threads) rather than leave an empty daemon.
    void metadata.then(() => process.exit(0), () => process.exit(1));
  });
  return { descriptor, server };
}

// This file is a standalone Electron Node-mode entry, never imported by main.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2]) {
  startTerminalDaemon(process.argv[2]).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') console.error('Terminal daemon startup failed:', error.message);
    process.exit(1);
  });
}
