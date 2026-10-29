import { parseContract } from './validation.js';
import type { LocalAuthorizationEvent } from './types.js';
import type { LocalAuthorizationListener } from './ports.js';

/** Main-process local notifications. Persist the grant/revocation BEFORE publishing.
 * No automatic Hub forwarding; publish only a path-free BindingReport separately.
 */
export function createLocalAuthorizationChanges() {
  const revisions = new Map<string, number>();
  const listeners = new Set<LocalAuthorizationListener>();
  return {
    subscribe(listener: LocalAuthorizationListener): () => void {
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    publishCommitted(input: LocalAuthorizationEvent): boolean {
      const event = parseContract('localAuthorizationEvent', input);
      const key = event.projectId + ':' + event.deviceId;
      if ((revisions.get(key) ?? 0) >= event.bindingRevision) return false;
      revisions.set(key, event.bindingRevision);
      for (const listener of [...listeners]) {
        try { listener(structuredClone(event)); } catch { /* independent UI subscriber */ }
      }
      return true;
    },
  };
}
