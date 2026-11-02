import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [executable, outJson, waitText = '20000'] = process.argv.slice(2);
if (!executable || !outJson) throw new Error('usage: packaged-app-smoke.mjs <exe> <out.json> [waitMs]');
const waitMs = Number(waitText);
const startedAt = new Date().toISOString();
const userData = resolve(outJson, '..', 'user-data');
mkdirSync(userData, { recursive: true });
const logPath = resolve(outJson, '..', 'application.log');
const logFd = openSync(logPath, 'w');
const child = spawn(resolve(executable), [`--user-data-dir=${userData}`, '--disable-gpu', '--no-sandbox'], {
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', logFd, logFd],
  windowsHide: false,
});
const started = Date.now();
let exit = null;
child.once('exit', (code, signal) => { exit = { code, signal }; });
await new Promise((done) => setTimeout(done, waitMs));
const aliveAtDeadline = exit === null;
if (aliveAtDeadline) {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await new Promise((done) => killer.once('exit', done));
  } else {
    child.kill('SIGTERM');
  }
}
const exitDeadline = Date.now() + 5000;
while (exit === null && Date.now() < exitDeadline) {
  await new Promise((done) => setTimeout(done, 50));
}
closeSync(logFd);
const log = readFileSync(logPath, 'utf8');
const fatalPatterns = [/UncaughtException/i, /Cannot find module/i, /app\.asar[^\n]*ENOENT/i, /SyntaxError/i];
const result = {
  schemaVersion: 1,
  startedAt,
  executable: resolve(executable),
  packaged: true,
  aliveAtDeadline,
  exit,
  waitMs: Date.now() - started,
  processTreeStopped: !aliveAtDeadline || exit !== null,
  fatalLogPatterns: fatalPatterns.filter((pattern) => pattern.test(log)).map(String),
  logSha256: createHash('sha256').update(log).digest('hex'),
  logPath,
  userData,
};
writeFileSync(outJson, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
if (!aliveAtDeadline || fatalPatterns.some((pattern) => pattern.test(log))) process.exitCode = 1;
