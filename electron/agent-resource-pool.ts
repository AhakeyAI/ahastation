import { randomUUID } from 'node:crypto';
import { AgentProcessScope } from './agent-process-scope.js';
import { ProcessMetricsSampler, processTree, type ProcessSample } from './agent-process-metrics.js';

export interface AgentLease {
  id: string;
  backendId: string;
  role: 'host' | 'worker';
  scope: AgentProcessScope;
  state: 'resident' | 'draining';
  observed: Map<number, ProcessSample>;
  /** Only the session owner can prove that reclamation is safe. */
  reclaim?: () => boolean;
}

interface Waiter {
  backendId: string;
  role: 'host' | 'worker';
  signal: AbortSignal;
  resolve: (lease: AgentLease) => void;
  reject: (error: Error) => void;
  abort: () => void;
}

export interface AgentResourceSnapshot {
  limit: number;
  resident: number;
  draining: number;
  waiting: number;
  idleTimeoutMs: number;
  sampledAt: number | null;
  rssBytes: number | null;
  cpuPercent: number | null;
  processCount: number;
  error?: string;
  sessions: Array<{ id: string; backendId: string; role: 'host' | 'worker'; state: string; pids: number[] }>;
}

function positiveInteger(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

/** App-wide admission, not scheduler concurrency. Waiting approvals and closing
 * runtimes keep their lease. Shared runtimes conservatively consume one lease
 * per session; process memory itself is deduplicated by PID. */
export class AgentResourcePool {
  readonly limit: number;
  readonly idleTimeoutMs: number;
  private readonly leases = new Map<string, AgentLease>();
  private readonly waiters: Waiter[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private sampleInFlight?: Promise<void>;
  private lastSample?: Awaited<ReturnType<ProcessMetricsSampler['sample']>>;
  private readonly sampler: ProcessMetricsSampler;
  private readonly automatic: boolean;

  constructor(options: {
    limit?: number;
    idleTimeoutMs?: number;
    sampler?: ProcessMetricsSampler;
    automatic?: boolean;
  } = {}) {
    this.limit = positiveInteger(options.limit ?? process.env.AHA_AGENT_MAX_RESIDENT, 6, 32);
    this.idleTimeoutMs = positiveInteger(options.idleTimeoutMs ?? process.env.AHA_AGENT_IDLE_TIMEOUT_MS, 60_000, 3_600_000);
    this.sampler = options.sampler ?? new ProcessMetricsSampler();
    this.automatic = options.automatic ?? true;
  }

  acquire(backendId: string, role: 'host' | 'worker', signal: AbortSignal): Promise<AgentLease> {
    if (signal.aborted) return Promise.reject(new Error('Agent start cancelled'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        backendId, role, signal, resolve, reject,
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error('Agent start cancelled'));
          this.schedule();
        },
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.waiters.push(waiter);
      this.pump();
      this.schedule();
    });
  }

  private pump(): void {
    while (this.leases.size < this.limit && this.waiters.length) {
      const waiter = this.waiters.shift()!;
      waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal.aborted) { waiter.reject(new Error('Agent start cancelled')); continue; }
      const lease: AgentLease = {
        id: randomUUID(), backendId: waiter.backendId, role: waiter.role,
        scope: new AgentProcessScope(), state: 'resident', observed: new Map(),
      };
      this.leases.set(lease.id, lease);
      waiter.resolve(lease);
    }
  }

  /** Call only after start has settled and end() has been requested. */
  retire(lease: AgentLease): void {
    if (!this.leases.has(lease.id)) return;
    lease.state = 'draining';
    lease.reclaim = undefined;
    // A cancelled admission / pre-spawn failure has no OS resources to drain.
    if (!lease.scope.processes.size && !lease.observed.size) {
      this.leases.delete(lease.id);
      this.pump();
    }
    this.schedule();
  }

  private schedule(): void {
    if (!this.automatic || this.timer || (!this.leases.size && !this.waiters.length)) return;
    const draining = [...this.leases.values()].some((lease) => lease.state === 'draining');
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sweep().finally(() => this.schedule());
    }, draining || this.waiters.length ? 1_000 : 5_000);
    this.timer.unref();
  }

  /** Public for on-demand diagnostics and deterministic tests. Failed sampling
   * never proves a process exited and therefore never releases a tracked lease. */
  sweep(): Promise<void> {
    if (this.sampleInFlight) return this.sampleInFlight;
    this.sampleInFlight = this.doSweep().finally(() => { this.sampleInFlight = undefined; });
    return this.sampleInFlight;
  }

  private async doSweep(): Promise<void> {
    const leases = [...this.leases.values()];
    const captured = new Map(leases.map((lease) => [lease.id, new Map(lease.scope.processes)]));
    const capturedRoots = new Map(leases.map((lease) => [lease.id,
      [...lease.scope.processes.values()].filter((entry) => !entry.exited).map((entry) => entry.pid),
    ]));
    const roots = leases.flatMap((lease) => [
      ...[...lease.scope.processes.values()].filter((entry) => !entry.exited).map((entry) => entry.pid),
      ...lease.observed.keys(),
    ]);
    const sample = await this.sampler.sample(roots);
    this.lastSample = sample;
    if (!sample.error) {
      const current = new Map(sample.processes.map((item) => [item.pid, item]));
      for (const lease of leases) {
        // Never follow a PID that has been recycled since the last observation.
        // Freeze ownership before enumeration: an exit callback arriving while
        // the OS sample is in flight must not discard its observed children.
        const liveRoots = capturedRoots.get(lease.id) ?? [];
        const known = [...lease.observed.values()].filter((old) => {
          const now = current.get(old.pid);
          return now && (!old.startedAt || now.startedAt === old.startedAt);
        }).map((entry) => entry.pid);
        lease.observed.clear();
        for (const item of processTree(sample.processes, [...liveRoots, ...known])) {
          lease.observed.set(item.pid, item);
        }
      }
      for (const lease of leases) {
        if (lease.state !== 'draining') continue;
        // start() may spawn while OS enumeration is in flight. Absence from
        // an older snapshot is not evidence that this new child has exited.
        if ([...lease.scope.processes.values()].some((entry) =>
          !entry.exited && captured.get(lease.id)?.get(entry.pid) !== entry)) continue;
        const shared = new Set<number>();
        for (const other of leases) {
          if (other === lease || other.state !== 'resident') continue;
          for (const entry of other.scope.processes.values()) if (!entry.exited) shared.add(entry.pid);
        }
        const sharedTree = new Set(processTree(sample.processes, [...shared]).map((entry) => entry.pid));
        const rootAlive = [...lease.scope.processes.values()].some((entry) =>
          !entry.exited && current.has(entry.pid) && !sharedTree.has(entry.pid));
        const descendantAlive = [...lease.observed.values()].some((old) => {
          const now = current.get(old.pid);
          return now && (!old.startedAt || now.startedAt === old.startedAt) && !sharedTree.has(old.pid);
        });
        if (!rootAlive && !descendantAlive) this.leases.delete(lease.id);
      }
    }
    // Reclaim only after collecting the currently visible descendants. The
    // owner synchronously marks itself dormant before it requests termination.
    for (const lease of this.leases.values()) {
      if (lease.state === 'resident') lease.reclaim?.();
    }
    this.pump();
    this.schedule();
  }

  snapshot(): AgentResourceSnapshot {
    const leases = [...this.leases.values()];
    const sample = this.lastSample;
    return {
      limit: this.limit,
      resident: leases.filter((lease) => lease.state === 'resident').length,
      draining: leases.filter((lease) => lease.state === 'draining').length,
      waiting: this.waiters.length,
      idleTimeoutMs: this.idleTimeoutMs,
      sampledAt: sample?.sampledAt ?? null,
      rssBytes: sample && !sample.error ? sample.rssBytes : null,
      cpuPercent: sample?.cpuPercent ?? null,
      processCount: sample?.processes.length ?? 0,
      ...(sample?.error ? { error: sample.error } : {}),
      sessions: leases.map((lease) => ({
        id: lease.id, backendId: lease.backendId, role: lease.role, state: lease.state,
        pids: [...lease.scope.processes.values()].filter((item) => !item.exited).map((item) => item.pid),
      })),
    };
  }
}

let singleton: AgentResourcePool | undefined;
export function getAgentResourcePool(): AgentResourcePool {
  return singleton ??= new AgentResourcePool();
}
