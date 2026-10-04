// terminal-backends.ts — renderer mirror of
// electron/backends/terminal-cli-adapter.ts TERMINAL_WORKER_BACKEND_IDS.
// Keep the two lists in sync: these are the backends that run a
// human-supervised interactive TUI worker inside a pty (stage terminal).

export const TERMINAL_WORKER_BACKEND_IDS: readonly string[] = [
  'claude-code-terminal',
  'kimi-code-terminal',
  'codex-terminal',
  'qoder-terminal',
];

const TERMINAL_WORKER_BACKEND_ID_SET: ReadonlySet<string> = new Set(TERMINAL_WORKER_BACKEND_IDS);

export function isTerminalWorkerBackendId(backendId: string | null | undefined): boolean {
  return !!backendId && TERMINAL_WORKER_BACKEND_ID_SET.has(backendId);
}

/** Deterministic pty id of a terminal-mode HOST session — renderer mirror of
 *  hostTerminalWorkerId in electron/backends/terminal-cli-adapter.ts. The
 *  main side injects this as the host session's workerId; the stage terminal
 *  attaches its RealTerminal to the same id. Keep the two copies in sync. */
export function hostTerminalWorkerId(meetingId: string, hostId: string): string {
  return `host-terminal-${meetingId}-${hostId}`;
}

/** Short display labels for terminal-mode host TUI worker entries. */
const TERMINAL_BACKEND_LABELS: Readonly<Record<string, string>> = {
  'claude-code-terminal': 'Claude',
  'kimi-code-terminal': 'Kimi',
  'codex-terminal': 'Codex',
  'qoder-terminal': 'Qoder',
};

export function terminalBackendLabel(backendId: string): string {
  return TERMINAL_BACKEND_LABELS[backendId] ?? backendId;
}
