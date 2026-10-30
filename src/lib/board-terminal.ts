// Task board 开始/查看: which local CLI to launch and which project room hosts
// it. Kept free of runtime imports so node --test can load it directly.

/** Observed client → local CLI id (electron/local-cli.ts LOCAL_CLI_IDS). */
export const OBSERVED_CLI = { 'claude-code': 'claude', codex: 'codex', kimi: 'kimi' } as const;

/** CLIs whose interactive mode accepts a first prompt (electron/session-continue.ts). */
export const PROMPT_ARG_CLIS: readonly string[] = ['claude', 'codex'];

/** Starting a backlog card prefers CLIs that can take the task as a first prompt. */
export const START_CLI_PREFERENCE: readonly string[] = ['claude', 'codex', 'kimi', 'qoder', 'opencode', 'qwen', 'gemini', 'pi'];

/** An already-open meeting of the same repository wins over opening its root. */
export function roomCwdForFolder(
  folder: string,
  openMeetingCwds: readonly string[],
  projectKeyOf: (cwd: string) => string,
): string {
  if (openMeetingCwds.includes(folder)) return folder;
  const key = projectKeyOf(folder);
  return openMeetingCwds.find((cwd) => projectKeyOf(cwd) === key) ?? key;
}
