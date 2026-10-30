// native-cli.ts — which locally installed CLI (electron/local-cli.ts
// LOCAL_CLI_IDS) matches a meeting backend, so "open terminal" on a worker
// without its own PTY can launch the user's native CLI instead.

const BACKEND_PREFIX_TO_CLI: ReadonlyArray<readonly [string, string]> = [
  ['claude', 'claude'],
  ['codex', 'codex'],
  ['opencode', 'opencode'],
  ['kimi', 'kimi'],
  ['qoder', 'qoder'],
  ['qwen', 'qwen'],
  ['gemini', 'gemini'],
];

/** Local CLI id for a backend id, or null when no native CLI corresponds
 *  (e.g. remote pocket-vibe hosts) and a plain shell should open instead. */
export function nativeCliForBackend(backendId: string | null | undefined): string | null {
  if (!backendId) return null;
  const id = backendId.toLowerCase();
  return BACKEND_PREFIX_TO_CLI.find(([prefix]) => id.startsWith(prefix))?.[1] ?? null;
}
