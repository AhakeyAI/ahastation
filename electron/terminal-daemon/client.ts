import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROTOCOL_VERSION, receive, send, type Descriptor, type Launch, type Snapshot, type Response, type DaemonEvent } from './protocol.js';
import type { TerminalRecord } from '../terminal-sessions.js';
import { readDescriptor } from './storage.js';

/** No retries: especially input with a lost ACK must never be resent. */
export class TerminalClient {
  private pending = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(event: DaemonEvent) => void>();
  private generations = new Map<string, number>();
  private constructor(private socket: Socket, readonly descriptor: Descriptor) {
    receive(socket, value => {
      const frame = value as Response | DaemonEvent;
      if ('event' in frame) { for (const listener of this.listeners) listener(frame); return; }
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(frame.id);
      if (frame.ok) pending.resolve(frame.result); else pending.reject(new Error(frame.error));
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.generations.clear();
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Terminal disconnected; operation outcome may be unknown')); }
      this.pending.clear();
    });
  }
  static async connect(dataDir: string) {
    const descriptor = await readDescriptor(dataDir);
    const socket = createConnection(descriptor.endpoint);
    const client = new TerminalClient(socket, descriptor);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('Terminal connect timeout')); }, 3000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', error => { clearTimeout(timer); reject(error); });
      });
      await client.request('hello', { version: PROTOCOL_VERSION, instanceId: descriptor.instanceId,
        token: await readFile(join(dataDir, 'credential'), 'utf8') });
      return client;
    } catch (error) { socket.destroy(); throw error; }
  }
  request<T = unknown>(op: string, body: Record<string, unknown> = {}): Promise<T> {
    if (this.socket.destroyed) return Promise.reject(new Error('Terminal disconnected'));
    if (this.pending.size >= 128) return Promise.reject(new Error('Too many terminal requests'));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); this.socket.destroy();
        reject(new Error('Terminal ACK timeout; operation outcome may be unknown'));
      }, 15_000);
      this.pending.set(id, { resolve: result => resolve(result as T), reject, timer });
      send(this.socket, { id, op, ...body });
    });
  }
  inventory() { return this.request<TerminalRecord[]>('inventory'); }
  spawn(requestId: string, launch: Launch) { return this.request<Snapshot>('spawn', { requestId, launch }); }
  async attach(terminalId: string, control = true) {
    const result = await this.request<Snapshot & { generation: number }>('attach', { terminalId, control });
    if (control) this.generations.set(terminalId, result.generation);
    return result;
  }
  async detach(terminalId: string) {
    const result = await this.request('detach', { terminalId }); this.generations.delete(terminalId); return result;
  }
  input(terminalId: string, data: string) { return this.control('input', terminalId, { data }); }
  resize(terminalId: string, cols: number, rows: number) { return this.control('resize', terminalId, { cols, rows }); }
  terminate(terminalId: string) { return this.control<Snapshot>('terminate', terminalId); }
  private control<T = unknown>(op: string, terminalId: string, body: Record<string, unknown> = {}) {
    const generation = this.generations.get(terminalId);
    if (!generation) return Promise.reject(new Error('Terminal has no controller lease'));
    return this.request<T>(op, { terminalId, generation, ...body });
  }
  onEvent(listener: (event: DaemonEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  disconnect() { this.socket.destroy(); }
}
