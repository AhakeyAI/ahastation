import { getBackendRegistry } from './backends/registry.js';
import { getSettings } from './store.js';
import { isTerminalWorkerBackend } from './backends/terminal-cli-adapter.js';

/** Until native execution guards and B04 pass, defaults remain on SDK. */
export function resolveDefaultWorkerBackendId(hostBackendId: string): string {
  // Preserve the preference on disk; a disabled native route cannot run.
  const configured = getSettings().defaultWorkerBackendId;
  if (configured) {
    const backend = getBackendRegistry().get(configured);
    if (backend?.capabilities.executeTasks && !isTerminalWorkerBackend(configured)) return configured;
  }
  // SDK remains the operational default while native admission is closed.
  const host = getBackendRegistry().get(hostBackendId);
  if (host?.capabilities.executeTasks && !isTerminalWorkerBackend(hostBackendId)) return hostBackendId;
  const sdk = getBackendRegistry().get('claude-code');
  if (sdk?.capabilities.executeTasks) return 'claude-code';
  return hostBackendId;
}
