// Manual terminal IPC validates the caller and delegates to the session owner.
import { z } from 'zod';
import { homedir } from 'node:os';
import { getPtyHost } from '../pty-host.js';
import type { IpcContext } from './context.js';
import { sendToAppWindows } from '../room-windows.js';
import { handleSecure, mainWindowSenderPolicy } from './validators.js';
import { PTY_INPUT_MAX_BYTES } from './ide-pty.js';
import { LOCAL_CLI_IDS, LOCAL_SHELL_IDS, listLocalClis, listLocalShells } from '../local-cli.js';
import { LocalTerminalSessions } from '../local-terminal-sessions.js';
import { augmentedPath, resolveBinaryFromPath } from '../backends/subprocess-backend.js';
import { endObservedSession, initialPromptArgs, makeKimiForkRunner, resolveContinueLaunch } from '../session-continue.js';

const PTY_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;
export const shellPtyCreateSchema = z.object({
  cwd: z.string().min(1).max(1024).optional(),
  cols: z.number().int().min(1).max(500).optional(),
  rows: z.number().int().min(1).max(500).optional(),
  cliId: z.enum(LOCAL_CLI_IDS).optional(),
  shellId: z.enum(LOCAL_SHELL_IDS).optional(),
  terminalId: z.string().regex(PTY_ID_RE).optional(),
  continueSession: z.object({
    observedId: z.string().min(1).max(512),
    mode: z.enum(['fork', 'resume']),
    endOriginal: z.boolean().optional(),
  }).strict().optional(),
  initialPrompt: z.string().max(4000).optional(),
}).strict().refine((value) => !(value.cliId && value.shellId), '选择 CLI 或 shell 其中一种')
  .refine((value) => !value.continueSession || !!value.terminalId, '接续会话需要终端标签');

export const shellPtyIdSchema = z.object({ ptyId: z.string().regex(PTY_ID_RE) }).strict();
export const shellPtyInputSchema = z.object({
  ptyId: z.string().regex(PTY_ID_RE), data: z.string().min(1).max(PTY_INPUT_MAX_BYTES),
}).strict();
export const shellPtyResizeSchema = z.object({
  ptyId: z.string().regex(PTY_ID_RE),
  rows: z.number().int().min(1).max(500), cols: z.number().int().min(1).max(500),
}).strict();

export function registerShellPtyIpc(ctx: IpcContext): void {
  const authorize = mainWindowSenderPolicy(() => ctx.liveWindow()?.webContents.id ?? null);
  const authorizeError = 'Sender is not the main window';
  const service = new LocalTerminalSessions(getPtyHost(), {
    data: (event) => sendToAppWindows(ctx.liveWindow(), 'shell-pty:data', event),
    exit: (event) => sendToAppWindows(ctx.liveWindow(), 'shell-pty:exit', event),
  }, () => ctx.getCurrentCwd() ?? undefined);
  let cleanupBound = false;

  handleSecure('shell-pty:list-clis', {
    schema: z.object({}).strict(), authorize, authorizeError,
    handler: () => ({ ok: true, clis: listLocalClis() }),
  });
  handleSecure('shell-pty:list-shells', {
    schema: z.object({}).strict(), authorize, authorizeError,
    handler: () => ({ ok: true, shells: listLocalShells(), defaultCwd: homedir() }),
  });
  handleSecure('shell-pty:create', {
    schema: shellPtyCreateSchema, authorize, authorizeError,
    handler: async ({ continueSession, initialPrompt, ...payload }) => {
      if (!cleanupBound) {
        ctx.liveWindow()!.webContents.once('destroyed', () => {
          service.closeAll();
          cleanupBound = false;
        });
        cleanupBound = true;
      }
      if (!continueSession || service.has(payload.terminalId!)) {
        return service.create({ ...payload, cliArgs: initialPromptArgs(payload.cliId, initialPrompt) });
      }
      const kimi = resolveBinaryFromPath('kimi');
      const snapshot = ctx.getObservedSnapshot();
      const resolved = await resolveContinueLaunch(continueSession.observedId, continueSession.mode, snapshot, {
        ...(kimi ? { kimiFork: makeKimiForkRunner(kimi, { ...process.env, PATH: augmentedPath() }) } : {}),
      });
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const { cliId, args, cwd } = resolved.launch;
      const result = service.create({ ...payload, shellId: undefined, cliId, cwd, cliArgs: args });
      if (!result.ok || !continueSession.endOriginal) return result;
      const ended = endObservedSession(continueSession.observedId, snapshot);
      return ended.ok ? result : { ...result, notice: `分支会话已打开，但原会话没有关闭：${ended.error}` };
    },
  });
  handleSecure('shell-pty:input', {
    schema: shellPtyInputSchema, authorize, authorizeError,
    handler: ({ ptyId, data }) => service.input(ptyId, data),
  });
  handleSecure('shell-pty:resize', {
    schema: shellPtyResizeSchema, authorize, authorizeError,
    handler: ({ ptyId, rows, cols }) => service.resize(ptyId, rows, cols),
  });
  handleSecure('shell-pty:kill', {
    schema: shellPtyIdSchema, authorize, authorizeError,
    handler: ({ ptyId }) => service.close(ptyId),
  });
}
