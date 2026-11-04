import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

// stdin carries only numeric request IDs. No command or path from a session is executed.
const SCRIPT = `
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
while ($null -ne ($requestLine = [Console]::ReadLine())) {
  if ($requestLine -notmatch '^[0-9]+$') { break }
  try {
    $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,Name)
    $json = ConvertTo-Json -InputObject $rows -Compress
    [Console]::WriteLine('AHA_PROCESS ' + $requestLine + ' ' + $json)
  } catch {
    [Console]::WriteLine('AHA_PROCESS_ERROR ' + $requestLine)
  }
}
`;

type SpawnReader = (file: string, args: string[], options: { windowsHide: boolean; stdio: 'pipe' }) => ChildProcessWithoutNullStreams;
interface Pending {
  id: number;
  promise: Promise<string>;
  resolve: (json: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  text: string;
  bytes: number;
}

/** One bounded query at a time; a broken helper is replaced on the next capture. */
export class WindowsProcessReader {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending: Pending | null = null;
  private requestId = 0;

  constructor(private readonly options: { spawnImpl?: SpawnReader; timeoutMs?: number; maxBytes?: number } = {}) {}

  capture(): Promise<string> {
    if (this.pending) return this.pending.promise;
    let resolve!: Pending['resolve'];
    let reject!: Pending['reject'];
    const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    const id = ++this.requestId;
    this.pending = { id, promise, resolve, reject, text: '', bytes: 0,
      timer: setTimeout(() => this.fail(), this.options.timeoutMs ?? 5_000) };
    try {
      const child = this.child ?? this.start();
      child.stdin.write(`${id}\n`, (error) => { if (error && this.child === child) this.fail(); });
    } catch { this.fail(); }
    return promise;
  }

  dispose(): void { this.fail(); }

  private start(): ChildProcessWithoutNullStreams {
    const child = (this.options.spawnImpl ?? spawn)('powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'pipe' });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text: string) => { if (this.child === child) this.receive(text); });
    // Drain diagnostics without retaining process command lines or emitting them into logs.
    child.stderr.on('data', () => {});
    for (const emitter of [child, child.stdin, child.stdout, child.stderr]) {
      emitter.on('error', () => { if (this.child === child) this.fail(); });
    }
    child.on('exit', () => { if (this.child === child) this.fail(); });
    child.stdout.on('end', () => { if (this.child === child) this.fail(); });
    // Idle pipes must not keep a headless test/CLI alive. A pending query's timer does.
    child.unref();
    for (const pipe of [child.stdin, child.stdout, child.stderr]) {
      (pipe as typeof pipe & { unref?: () => void }).unref?.();
    }
    return child;
  }

  private receive(text: string): void {
    const pending = this.pending;
    if (!pending) { if (text.trim()) this.fail(); return; }
    pending.bytes += Buffer.byteLength(text, 'utf8');
    if (pending.bytes > (this.options.maxBytes ?? 16 * 1024 * 1024)) { this.fail(); return; }
    pending.text += text;
    const end = pending.text.indexOf('\n');
    if (end < 0) return;
    const line = pending.text.slice(0, end).replace(/\r$/, '');
    const prefix = `AHA_PROCESS ${pending.id} `;
    if (!line.startsWith(prefix) || pending.text.slice(end + 1).trim()) { this.fail(); return; }
    const json = line.slice(prefix.length);
    try { JSON.parse(json); } catch { this.fail(); return; }
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(json);
  }

  private fail(): void {
    const pending = this.pending;
    const child = this.child;
    this.pending = null;
    this.child = null;
    if (child) { child.stdin.destroy(); child.kill(); }
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Process snapshot unavailable'));
    }
  }
}
