// projects IPC — lobby project rooms: map folders to their git repository
// (read-only rev-parse), create a project from scratch, clone one with
// progress. Main window only; every payload zod-validated.

import { z } from 'zod';
import { abortClone, cloneProject, createProject, defaultProjectParent, resolveRepos } from '../projects.js';
import type { IpcContext } from './context.js';
import { emptyPayloadSchema, handleSecure, mainWindowSenderPolicy } from './validators.js';

const absPath = z.string().min(1).max(4096);

export function registerProjectsIpc(ctx: IpcContext): void {
  const mainOnly = mainWindowSenderPolicy(() => ctx.liveWindow()?.webContents.id ?? null);

  handleSecure('projects:resolve-repos', {
    schema: z.object({ cwds: z.array(absPath).max(400) }).strict(),
    authorize: mainOnly,
    handler: async (payload) => ({ ok: true, repos: await resolveRepos(payload.cwds) }),
  });

  handleSecure('projects:default-parent', {
    schema: z.object({ recent: z.array(absPath).max(50).optional() }).strict(),
    authorize: mainOnly,
    handler: async (payload) => ({ ok: true, path: defaultProjectParent(payload.recent) }),
  });

  handleSecure('projects:create', {
    schema: z.object({ parentPath: absPath, name: z.string().min(1).max(255), git: z.boolean() }).strict(),
    authorize: mainOnly,
    handler: async (payload) => createProject(payload),
  });

  handleSecure('projects:clone', {
    schema: z.object({ url: z.string().min(1).max(2048), parentPath: absPath }).strict(),
    authorize: mainOnly,
    handler: async (payload) => cloneProject(payload, (line) => {
      const win = ctx.liveWindow();
      if (win && !win.isDestroyed()) win.webContents.send('projects:clone-progress', { line });
    }),
  });

  handleSecure('projects:clone-abort', {
    schema: emptyPayloadSchema,
    authorize: mainOnly,
    handler: async () => { abortClone(); return { ok: true }; },
  });
}
