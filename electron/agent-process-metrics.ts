import { execFile } from 'node:child_process';

export interface ProcessSample {
  pid: number;
  ppid: number;
  rssBytes: number;
  cpuTimeMs: number;
  startedAt?: string;
}

export interface ProcessMetrics {
  sampledAt: number;
  processes: ProcessSample[];
  rssBytes: number;
  cpuPercent: number | null;
  error?: string;
}

const TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function unsignedInteger(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) {
    throw new Error('Invalid process metric');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid process metric');
  return number;
}

/** ps cumulative time: mm:ss[.fraction], hh:mm:ss or dd-hh:mm:ss. */
export function parseCpuTimeMs(value: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) throw new Error('Invalid ps CPU time');
  const [, days, hours, minutes, seconds] = match;
  if ((days !== undefined && hours === undefined)
    || (hours !== undefined && Number(minutes) >= 60)
    || (days !== undefined && Number(hours) >= 24)
    || Number(seconds) >= 60) throw new Error('Invalid ps CPU time');
  const result = (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60
    + Number(minutes)) * 60 + Number(seconds)) * 1000;
  if (!Number.isFinite(result) || result > Number.MAX_SAFE_INTEGER) throw new Error('Invalid ps CPU time');
  return result;
}

/** Strict parsing avoids turning malformed/partial output into an idle reading. */
export function parsePsProcessSamples(output: string): ProcessSample[] {
  const lines = output.trim().split(/\r?\n/);
  if (!output.trim()) throw new Error('Empty ps process output');
  return lines.map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(line);
    if (!match) throw new Error('Invalid ps process row');
    const rssBytes = unsignedInteger(match[3]) * 1024;
    if (!Number.isSafeInteger(rssBytes)) throw new Error('Invalid ps RSS');
    return {
      pid: unsignedInteger(match[1]),
      ppid: unsignedInteger(match[2]),
      rssBytes,
      cpuTimeMs: parseCpuTimeMs(match[4]),
      startedAt: match[5].replace(/\s+/g, ' '),
    };
  });
}

export function parseWindowsProcessSamples(output: string): ProcessSample[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.replace(/^\uFEFF/, '').trim());
  } catch {
    throw new Error('Invalid Windows process JSON');
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid Windows process row');
    const record = row as Record<string, unknown>;
    const startedAt = record.CreationDate;
    if (startedAt != null && (typeof startedAt !== 'string' || !startedAt.trim())) {
      throw new Error('Invalid Windows process creation date');
    }
    return {
      pid: unsignedInteger(record.ProcessId),
      ppid: unsignedInteger(record.ParentProcessId),
      rssBytes: unsignedInteger(record.WorkingSetSize),
      // Win32_Process CPU counters are in 100-nanosecond units.
      cpuTimeMs: unsignedInteger(record.KernelModeTime) / 10_000
        + unsignedInteger(record.UserModeTime) / 10_000,
      ...(typeof startedAt === 'string' ? { startedAt: startedAt.trim() } : {}),
    };
  });
}

function execute(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...process.env, LC_ALL: 'C' },
    }, (error, stdout) => {
      // Do not propagate stdout/stderr or command details in a diagnostic.
      if (error) reject(new Error(`Process collection failed (${error.code ?? 'timeout or termination'})`));
      else resolve(stdout);
    });
  });
}

/** Read-only OS snapshot: no command lines, executable paths or environment data. */
export async function collectProcessSamples(): Promise<ProcessSample[]> {
  if (process.platform === 'win32') {
    const fields = 'ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,CreationDate';
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      `$rows = @(Get-CimInstance -Query 'SELECT ${fields} FROM Win32_Process' | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,@{Name='CreationDate';Expression={if ($null -ne $_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')}}})`,
      'ConvertTo-Json -InputObject $rows -Compress',
    ].join('; ');
    return parseWindowsProcessSamples(await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
  }
  return parsePsProcessSamples(await execute('/bin/ps', ['-axo', 'pid=,ppid=,rss=,time=,lstart=']));
}

/** Only roots present in the snapshot are followed; PID 0 is not an agent root. */
export function processTree(samples: readonly ProcessSample[], rootPids: readonly number[]): ProcessSample[] {
  const byPid = new Map<number, ProcessSample>();
  for (const sample of samples) {
    if (sample.pid > 0 && !byPid.has(sample.pid)) byPid.set(sample.pid, sample);
  }
  const children = new Map<number, number[]>();
  for (const sample of byPid.values()) {
    const siblings = children.get(sample.ppid) ?? [];
    siblings.push(sample.pid);
    children.set(sample.ppid, siblings);
  }
  const pending = [...rootPids];
  const visited = new Set<number>();
  const result: ProcessSample[] = [];
  while (pending.length) {
    const pid = pending.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const sample = byPid.get(pid);
    if (!sample) continue;
    result.push(sample);
    for (const child of children.get(pid) ?? []) pending.push(child);
  }
  return result;
}

interface Snapshot {
  sampledAt: number;
  samples: ProcessSample[];
}

interface Frame extends Snapshot {
  previous?: Snapshot;
  error?: string;
}

export class ProcessMetricsSampler {
  private previous?: Snapshot;
  private inFlight?: Promise<Frame>;

  constructor(
    private readonly collect: () => Promise<ProcessSample[]> = collectProcessSamples,
    private readonly now: () => number = Date.now,
  ) {}

  private snapshot(): Promise<Frame> {
    if (this.inFlight) return this.inFlight;
    // Defer invocation so even a synchronously throwing injected collector is caught.
    this.inFlight = Promise.resolve().then(async (): Promise<Frame> => {
      try {
        const samples = (await this.collect()).map((sample) => ({ ...sample }));
        const current = { sampledAt: this.now(), samples };
        const previous = this.previous;
        this.previous = current;
        return { ...current, previous };
      } catch (error) {
        this.previous = undefined;
        return {
          sampledAt: this.now(), samples: [],
          error: error instanceof Error ? error.message || 'Process collection failed' : 'Process collection failed',
        };
      }
    }).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  async sample(rootPids: readonly number[]): Promise<ProcessMetrics> {
    const roots = [...rootPids];
    const frame = await this.snapshot();
    if (frame.error) {
      return { sampledAt: frame.sampledAt, processes: [], rssBytes: 0, cpuPercent: null, error: frame.error };
    }
    const processes = processTree(frame.samples, roots);
    let cpuPercent: number | null = null;
    const elapsed = frame.previous ? frame.sampledAt - frame.previous.sampledAt : 0;
    if (frame.previous && elapsed > 0) {
      const previous = new Map(processTree(frame.previous.samples, roots).map((sample) => [sample.pid, sample]));
      let cpuDelta = 0;
      let comparable = 0;
      for (const sample of processes) {
        const before = previous.get(sample.pid);
        // Without creation time, PID + parent + nondecreasing counter is best effort.
        if (!before || before.startedAt !== sample.startedAt || before.ppid !== sample.ppid
          || sample.cpuTimeMs < before.cpuTimeMs) continue;
        comparable++;
        cpuDelta += sample.cpuTimeMs - before.cpuTimeMs;
      }
      if (comparable > 0 || processes.length === 0) cpuPercent = cpuDelta / elapsed * 100;
    }
    return {
      sampledAt: frame.sampledAt,
      processes: processes.map((sample) => ({ ...sample })),
      rssBytes: processes.reduce((sum, sample) => sum + sample.rssBytes, 0),
      cpuPercent,
    };
  }
}
