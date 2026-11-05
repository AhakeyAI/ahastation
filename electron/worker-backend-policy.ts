/** Local meeting Workers use the user's native interactive CLI. Host backends
 * remain independent. SDK names in old plans are aliases, never SDK fallbacks. */
export function nativeWorkerBackendId(backendId: string): string {
  switch (backendId.trim()) {
    case 'codex':
    case 'codex-terminal': return 'codex-terminal';
    case 'claude-code':
    case 'claude-code-terminal': return 'claude-code-terminal';
    default: throw new Error(`unsupported-contract: Worker '${backendId}' 尚未接入本地原生 CLI 派工，请选择 Codex 或 Claude Code 终端`);
  }
}

export function defaultNativeWorkerBackendId(hostBackendId: string, configured?: string): string {
  if (configured && ['codex', 'codex-terminal', 'claude-code', 'claude-code-terminal'].includes(configured)) {
    return nativeWorkerBackendId(configured);
  }
  return hostBackendId.startsWith('claude') ? 'claude-code-terminal' : 'codex-terminal';
}
