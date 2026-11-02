// rate-limits IPC — per-agent quota for the meeting usage strip. Main window
// only. The service polls lazily (first `get`), refreshes on window focus
// (debounced) and on the strip's refresh button, and pushes every change to
// the renderer as 'rate-limits:update'.

import { app } from 'electron';
import { z } from 'zod';
import { RateLimitService } from '../rate-limits.js';
import type { IpcContext } from './context.js';
import { sendToAppWindows } from '../room-windows.js';
import { emptyPayloadSchema, handleSecure, mainWindowSenderPolicy } from './validators.js';

let service: RateLimitService | null = null;

export function registerRateLimitsIpc(ctx: IpcContext): void {
  const mainOnly = mainWindowSenderPolicy(() => ctx.liveWindow()?.webContents.id ?? null);
  service = new RateLimitService((state) => {
    sendToAppWindows(ctx.liveWindow(), 'rate-limits:update', state);
  });
  const svc = service;

  app.on('browser-window-focus', () => { void svc.refresh('focus'); });
  app.on('before-quit', () => svc.stop());

  handleSecure('rate-limits:get', {
    schema: emptyPayloadSchema,
    authorize: mainOnly,
    handler: async () => {
      svc.ensureStarted();
      return { ok: true, state: svc.snapshot() };
    },
  });

  handleSecure('rate-limits:refresh', {
    schema: z.object({}).strict().nullish(),
    authorize: mainOnly,
    handler: async () => {
      svc.ensureStarted();
      await svc.refresh('manual');
      return { ok: true, state: svc.snapshot() };
    },
  });
}
