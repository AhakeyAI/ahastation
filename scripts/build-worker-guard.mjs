import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
if (process.platform !== 'win32') { console.log('Windows AppContainer helper: platform skip'); process.exit(0); }
const compiler = join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
mkdirSync('build/worker-guard', { recursive: true });
const result = spawnSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/reference:System.Web.Extensions.dll',
  `/out:${resolve('build/worker-guard/WindowsGuard.exe')}`, resolve('native/worker-guard/WindowsGuard.cs'),
  resolve('native/worker-guard/WindowsConPty.cs')],
{ windowsHide: true, encoding: 'utf8', timeout: 30_000 });
if (result.status !== 0) { console.error(result.stdout, result.stderr); process.exit(1); }
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
writeFileSync('build/worker-guard/manifest.json', JSON.stringify({ schemaVersion: 1, boundary: 'windows-offline-broker-v1',
  helperSha256: sha256('build/worker-guard/WindowsGuard.exe'), sourceSha256: sha256('native/worker-guard/WindowsGuard.cs'),
  conPtySourceSha256: sha256('native/worker-guard/WindowsConPty.cs'),
  terminalBoundary: 'windows-offline-conpty-v1; no provider admission or controlled online capability' }, null, 2) + '\n');
console.log('Windows AppContainer helper compiled');
