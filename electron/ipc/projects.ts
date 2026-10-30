// projects IPC — lobby project rooms: map folders to their git repository
// (read-only rev-parse), create a project from scratch, clone one with
// progress. Main window only; every payload zod-validated.

import { z } from 'zod';
import { abortClone, cloneProject, createProject, defaultProjectParent, githubStatus, resolveRepos } from '../projects.js';
import { addBacklog, listBacklog, removeBacklog } from '../backlog.js';
import type { IpcContext } from './context.js';
import { emptyPayloadSchema, handleSecure, mainWindowSenderPolicy } from './validators.js';

const absPath = z.string().min(1).max(4096);

export function registerProjectsIpc(ctx: IpcContext): void {
  const mainOnly = mainWindowSenderPolicy(() => ctx.liveWindow()?.webContents.id ?? null);
  const backlogChanged = async () => {
    const win = ctx.liveWindow();
    if (win && !win.isDestroyed()) win.webContents.send('backlog:changed', await listBacklog());
  };

  // Read-only: origin + `gh issue/pr list --limit 1`. Unknown counts stay null.
  handleSecure('projects:github-status', {
    schema: z.object({ cwd: absPath }).strict(),
    authorize: mainOnly,
    handler: async (payload) => ({ ok: true, status: await githubStatus(payload.cwd) }),
  });

  handleSecure('backlog:list', {
    schema: emptyPayloadSchema,
    authorize: mainOnly,
    handler: async () => ({ ok: true, items: await listBacklog() }),
  });

  // 写入看板: cards only, never dispatched. Issues are created only when the
  // user ticked 「同时在 GitHub 创建 Issue」 in the confirmation dialog.
  handleSecure('backlog:add', {
    schema: z.object({
      cwd: absPath,
      items: z.array(z.object({
        title: z.string().trim().min(1).max(300),
        kind: z.enum(['work-item', 'todo']),
        source: z.string().trim().max(300).optional(),
      }).strict()).min(1).max(60),
      createIssues: z.boolean(),
    }).strict(),
    authorize: mainOnly,
    handler: async (payload) => {
      const created = await addBacklog(payload);
      void backlogChanged();
      return { ok: true, items: created };
    },
  });

  handleSecure('backlog:remove', {
    schema: z.object({ id: z.string().min(1).max(64) }).strict(),
    authorize: mainOnly,
    handler: async (payload) => { await removeBacklog(payload.id); void backlogChanged(); return { ok: true }; },
  });

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
