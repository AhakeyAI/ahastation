// ide-registry.ts IPC — IDE catalog state + default/override management.
// Main window and the Settings window (the IDE panel lives in Settings);
// every payload zod-validated via the validators.ts handleSecure gate.

import { z } from 'zod';
import { getIdeRegistry } from '../ide/ide-registry.js';
import type { IpcContext } from './context.js';
import { settingsWindowWebContentsId } from './settings-window.js';
import { anySenderPolicy, emptyPayloadSchema, handleSecure, mainWindowSenderPolicy } from './validators.js';

const ideIdSchema = z.string().min(1).max(64);

export const ideRegistrySetDefaultSchema = z.object({ id: ideIdSchema }).strict();

export const ideRegistrySetOverrideSchema = z
  .object({ hostId: z.string().min(1).max(128), ideId: ideIdSchema.nullable() })
  .strict();

export function registerIdeRegistryIpc(ctx: IpcContext): void {
  const mainOrSettings = anySenderPolicy(
    mainWindowSenderPolicy(() => ctx.liveWindow()?.webContents.id ?? null),
    mainWindowSenderPolicy(settingsWindowWebContentsId),
  );

  handleSecure('ide-registry:list', {
    schema: emptyPayloadSchema,
    authorize: mainOrSettings,
    handler: async () => {
      const registry = getIdeRegistry();
      await registry.init();
      return { ok: true, state: registry.getState() };
    },
  });

  handleSecure('ide-registry:set-default', {
    schema: ideRegistrySetDefaultSchema,
    authorize: mainOrSettings,
    handler: async (payload) => {
      const registry = getIdeRegistry();
      await registry.init();
      return registry.setDefault(payload.id);
    },
  });

  handleSecure('ide-registry:set-override', {
    schema: ideRegistrySetOverrideSchema,
    authorize: mainOrSettings,
    handler: async (payload) => {
      const registry = getIdeRegistry();
      await registry.init();
      return registry.setOverride(payload.hostId, payload.ideId);
    },
  });
}
