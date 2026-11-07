import { AsyncLocalStorage } from 'node:async_hooks';

const scopes = new AsyncLocalStorage<AgentProcessScope>();

/** Process ownership follows the caller's asynchronous start/send chain. */
export class AgentProcessScope {
  readonly processes = new Map<number, { pid: number; exited: boolean }>();

  run<T>(fn: () => T): T {
    return scopes.run(this, fn);
  }
}

/** Subscribe only to native exit, never session completion or a kill request. */
export function trackAgentProcess(
  pid: number | undefined,
  subscribeExit: (onExit: () => void) => void,
): void {
  const scope = scopes.getStore();
  if (!scope || pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return;
  // A one-shot backend may spawn many turns within one scope. Reused OS PIDs
  // need a new record after exit; the old callback must not close that record.
  const previous = scope.processes.get(pid);
  if (previous && !previous.exited) return;

  const record = { pid, exited: false };
  scope.processes.set(pid, record);
  subscribeExit(() => {
    // Capture this record: a later replacement under the same PID is unrelated.
    record.exited = true;
  });
}
