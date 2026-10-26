import { spawn } from 'node:child_process';

interface ProcessHandle {
  readonly pid?: number;
  kill(signal?: string): unknown;
}

export function terminateProcessTree(
  child: ProcessHandle,
  spawnProcess: typeof spawn = spawn,
): void {
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawnProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      });
      killer.unref();
      return;
    } catch {
      // Fall through to the direct process handle.
    }
  }
  try { child.kill('SIGTERM'); } catch { /* already exited */ }
}
