import { getSettings } from './store.js';
import { defaultNativeWorkerBackendId } from './worker-backend-policy.js';

/** Resolve local Workers independently from the Host's transport. Missing
 * native binaries fail at admission; they never fall back to an SDK. */
export function resolveDefaultWorkerBackendId(hostBackendId: string): string {
  return defaultNativeWorkerBackendId(hostBackendId, getSettings().defaultWorkerBackendId);
}
