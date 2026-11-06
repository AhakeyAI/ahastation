import { ipcMain } from 'electron';
import { z } from 'zod';
import { formatError } from '../format-error.js';
import type { IpcContext } from './context.js';

const sessionIdSchema = z.string().trim().min(1).max(500).nullable().optional();

export function registerMeetingDeliveryIpc(ctx: IpcContext): void {
  ipcMain.handle('meeting-delivery:get', async (_event, payload: unknown) => {
    const parsed = z.object({ sessionId: sessionIdSchema }).strict().safeParse(payload ?? {});
    if (!parsed.success) return { ok: false, error: 'invalid Meeting delivery request' };
    const slot = ctx.registry.resolve(parsed.data.sessionId);
    if (!slot) return { ok: false, error: 'No active session' };
    try {
      return {
        ok: true,
        delivery: await slot.orchestrator.getMeetingDelivery(),
        decision: slot.orchestrator.getFinalMeetingDecision(),
      };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  });

}
