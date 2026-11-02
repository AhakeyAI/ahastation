import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Descriptor } from './protocol.js';

export function endpointFor(dataDir: string) {
  const key = createHash('sha256').update(process.platform === 'win32' ? resolve(dataDir).toLowerCase() : resolve(dataDir)).digest('hex').slice(0, 32);
  return process.platform === 'win32' ? `\\\\.\\pipe\\ahastation-terminal-${key}` : join(resolve(dataDir), 'terminal.sock');
}
export async function prepareDataDir(dataDir: string) {
  // Credential files inherit only this user's ACL on Windows, mode 0700/0600 on Unix.
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const run = promisify(execFile);
    const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const { stdout } = await run(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
    if (!sid) throw new Error('Cannot resolve credential owner SID');
    await run(join(system32, 'icacls.exe'), [resolve(dataDir), '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true });
  }
  const temporary = join(dataDir, `credential-${randomBytes(8).toString('hex')}.tmp`);
  await writeFile(temporary, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  try {
    // Publish fully written bytes without replacing another launcher's token.
    await link(temporary, join(dataDir, 'credential'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  finally { await unlink(temporary); }
  const token = await readFile(join(dataDir, 'credential'), 'utf8');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local credential');
  return token;
}
export async function readDescriptor(dataDir: string): Promise<Descriptor> {
  const value = JSON.parse(await readFile(join(dataDir, 'daemon.json'), 'utf8')) as Descriptor;
  if (value.schemaVersion !== 1 || value.endpoint !== endpointFor(dataDir) || typeof value.instanceId !== 'string') {
    throw new Error('Invalid terminal daemon discovery record');
  }
  return value;
}
export async function atomicJson(dataDir: string, name: string, value: unknown) {
  const target = join(dataDir, name);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, target);
}

/** Tighten the pipe object's ACL before publishing discovery or accepting hello.
 * Windows shares this security descriptor across subsequent pipe instances;
 * the smoke probe reads it again after several clients have disconnected. */
export async function restrictPipeAccess(endpoint: string) {
  if (process.platform !== 'win32') return;
  const script = fileURLToPath(new URL('./windows-pipe-acl.ps1', import.meta.url))
    .replace(/\.asar([\\/])/, '.asar.unpacked$1');
  await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-PipeName', endpoint],
    { windowsHide: true, timeout: 8000 });
}
