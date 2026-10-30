// Continue an observed CLI session inside the app. When the original is still
// running in another window it is forked (a new branch session), so two
// processes never write the same transcript; otherwise it is resumed in place.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ObservedSnapshot } from './observe/types.js';
import type { LocalCliId } from './local-cli.js';

export type ContinueMode = 'fork' | 'resume';

export interface ContinueLaunch {
  cliId: LocalCliId;
  args: string[];
  cwd: string;
}

export type KimiForkRunner = (cwd: string, sessionId: string) => Promise<string>;

export interface ContinueDeps {
  kimiFork?: KimiForkRunner;
  kill?: (pid: number) => void;
  newUuid?: () => string;
}

const CLI_FOR_KIND = { 'claude-code': 'claude', codex: 'codex', kimi: 'kimi' } as const;

/** Only a process owned by a terminal (tty) is safe to signal; desktop apps are not. */
export function isTerminalOwned(session: { pid?: number; tty?: string }): boolean {
  return typeof session.pid === 'number' && session.pid > 1 && !!session.tty && session.tty !== '??';
}

export function parseKimiForkOutput(stdout: string): string | null {
  return stdout.match(/Forked to (session_[A-Za-z0-9-]+)/)?.[1] ?? null;
}

export function makeKimiForkRunner(file: string, env: NodeJS.ProcessEnv): KimiForkRunner {
  return (cwd, sessionId) => new Promise((resolve, reject) => {
    execFile(file, ['fork', '-y', sessionId], { cwd, env, timeout: 30_000 }, (err, stdout, stderr) => {
      const id = parseKimiForkOutput(`${stdout}\n${stderr}`);
      if (id) resolve(id);
      else reject(new Error(err?.message || stderr.trim() || 'kimi fork 没有返回新会话'));
    });
  });
}

const defaultKimiFork = makeKimiForkRunner('kimi', process.env);

export async function resolveContinueLaunch(
  observedId: string,
  mode: ContinueMode,
  snapshot: ObservedSnapshot,
  deps: ContinueDeps = {},
): Promise<{ ok: true; launch: ContinueLaunch } | { ok: false; error: string }> {
  const session = snapshot.sessions.find((s) => s.id === observedId);
  if (!session) return { ok: false, error: '找不到这个会话，可能已经结束' };
  const nativeId = session.nativeSessionId;
  if (!nativeId) return { ok: false, error: '这个会话没有可接续的会话 ID' };
  if (!session.cwd) return { ok: false, error: '这个会话没有工作目录' };
  const cliId = CLI_FOR_KIND[session.clientKind as keyof typeof CLI_FOR_KIND];
  if (!cliId) return { ok: false, error: '这个客户端暂不支持在 App 内接续' };
  const cwd = session.cwd;
  if (cliId === 'claude') {
    // The observer maps a process to its session from --session-id before
    // --resume; without it the fork would be attributed to the original.
    return { ok: true, launch: { cliId, cwd, args: mode === 'fork'
      ? ['--resume', nativeId, '--fork-session', '--session-id', (deps.newUuid ?? randomUUID)()]
      : ['--resume', nativeId] } };
  }
  if (cliId === 'codex') {
    return { ok: true, launch: { cliId, cwd, args: [mode === 'fork' ? 'fork' : 'resume', nativeId] } };
  }
  if (mode === 'resume') return { ok: true, launch: { cliId, cwd, args: ['--session', nativeId] } };
  try {
    const forked = await (deps.kimiFork ?? defaultKimiFork)(cwd, nativeId);
    return { ok: true, launch: { cliId, cwd, args: ['--session', forked] } };
  } catch (err) {
    return { ok: false, error: `复制 Kimi 会话失败：${(err as Error).message}` };
  }
}

/** CLIs whose interactive mode takes a first prompt as a positional argument. */
export const PROMPT_ARG_CLIS: readonly LocalCliId[] = ['claude', 'codex'];

export function initialPromptArgs(cliId: LocalCliId | undefined, prompt: string | undefined): string[] {
  const text = prompt?.trim();
  if (!text || !cliId || !PROMPT_ARG_CLIS.includes(cliId)) return [];
  // A leading dash would be parsed as a flag.
  return [text.startsWith('-') ? `任务：${text}` : text];
}

export function endObservedSession(
  observedId: string,
  snapshot: ObservedSnapshot,
  deps: ContinueDeps = {},
): { ok: true } | { ok: false; error: string } {
  const session = snapshot.sessions.find((s) => s.id === observedId);
  if (!session?.pid) return { ok: true };
  if (!isTerminalOwned(session)) return { ok: false, error: '原会话属于桌面 App，请在 App 里关闭' };
  try {
    (deps.kill ?? ((pid: number) => { process.kill(pid, 'SIGTERM'); }))(session.pid);
    return { ok: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return { ok: true };
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}
