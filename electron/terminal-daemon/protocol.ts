import { z } from 'zod';
import type { Socket } from 'node:net';
import type { TerminalRecord } from '../terminal-sessions.js';

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_QUEUE_BYTES = 2 * MAX_FRAME_BYTES;
export const CAPABILITIES = ['inventory', 'spawn-dedup', 'attach-tail', 'controller-generation', 'confirmed-stop'] as const;
const id = z.string().uuid();
const size = z.number().int().min(1).max(500);
export const launchSchema = z.object({
  terminalId: id, label: z.string().max(256).default(''),
  file: z.string().min(1).max(32768), args: z.array(z.string().max(32768)).max(256),
  cwd: z.string().min(1).max(32768), env: z.record(z.string(), z.string()),
  cols: size, rows: size,
}).strict();
const terminal = { terminalId: id };
const controlled = { ...terminal, generation: z.number().int().positive() };
export const requestSchema = z.discriminatedUnion('op', [
  z.object({ id, op: z.literal('hello'), token: z.string().length(64), version: z.literal(PROTOCOL_VERSION), instanceId: id }).strict(),
  z.object({ id, op: z.literal('inventory') }).strict(),
  z.object({ id, op: z.literal('spawn'), requestId: id, launch: launchSchema }).strict(),
  z.object({ id, op: z.literal('attach'), ...terminal, control: z.boolean() }).strict(),
  z.object({ id, op: z.literal('detach'), ...terminal }).strict(),
  z.object({ id, op: z.literal('input'), ...controlled, data: z.string().min(1).max(8192) }).strict(),
  z.object({ id, op: z.literal('resize'), ...controlled, cols: size, rows: size }).strict(),
  z.object({ id, op: z.literal('terminate'), ...controlled }).strict(),
]);
export type Request = z.infer<typeof requestSchema>;
export type Launch = z.infer<typeof launchSchema>;
export type Snapshot = TerminalRecord & { ok: true; ptyId: string; replay: string };
export interface Descriptor {
  schemaVersion: 1; protocolVersion: number; instanceId: string; pid: number;
  startedAt: string; endpoint: string;
}
export type DaemonEvent = { event: 'output'; terminalId: string; data: string; sequence: number }
  | { event: 'exit'; terminalId: string; exitCode: number | null };
export type Response = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

export function send(socket: Socket, frame: unknown) {
  const data = JSON.stringify(frame) + '\n';
  if (Buffer.byteLength(data) > MAX_FRAME_BYTES || socket.writableLength + Buffer.byteLength(data) > MAX_QUEUE_BYTES) {
    socket.destroy(new Error('Terminal transport queue exceeded; reconnect required'));
    return;
  }
  socket.write(data);
}

/** Bound bytes before parsing, including incomplete frames. */
export function receive(socket: Socket, onFrame: (frame: unknown) => void) {
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    let end: number;
    while ((end = pending.indexOf(10)) !== -1) {
      if (end > MAX_FRAME_BYTES) { socket.destroy(); return; }
      const frame = pending.subarray(0, end); pending = pending.subarray(end + 1);
      try { onFrame(JSON.parse(frame.toString('utf8'))); }
      catch { socket.destroy(); return; }
      if (socket.destroyed) return;
    }
    if (pending.length > MAX_FRAME_BYTES) socket.destroy();
  });
}
