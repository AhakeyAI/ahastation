import { getBackendRegistry } from './backends/registry.js';
import { getSettings } from './store.js';
import {
  isNativeCliWorkerBackend,
  isTerminalWorkerBackend,
} from './backends/terminal-cli-adapter.js';

/** Resolve the effective default Worker backend: explicit SDK or admitted
 *  Native CLI Worker (`claude-code-terminal`, `codex-terminal`) wins when
 *  configured; otherwise default to the host's SDK Worker. */
export function resolveDefaultWorkerBackendId(hostBackendId: string): string {
  const configured = getSettings().defaultWorkerBackendId;
  if (configured) {
    const backend = getBackendRegistry().get(configured);
    if (
      backend?.capabilities.executeTasks
      && (!isTerminalWorkerBackend(configured) || isNativeCliWorkerBackend(configured))
    ) {
      return configured;
    }
  }
  const host = getBackendRegistry().get(hostBackendId);
  if (host?.capabilities.executeTasks && !isTerminalWorkerBackend(hostBackendId)) return hostBackendId;
  const sdk = getBackendRegistry().get('claude-code');
  if (sdk?.capabilities.executeTasks) return 'claude-code';
  return hostBackendId;
}
