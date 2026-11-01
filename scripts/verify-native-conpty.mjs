// Targeted hidden verification for this candidate only. No personal CLI,
// accounts, model, global config, npm test, installed app or remote writes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
const log = resolve('native-conpty-validation.log'); writeFileSync(log, '');
const results = [], osEvidence = [];
const output = resolve('docs/evidence/native-worker-conpty'); mkdirSync(output, { recursive: true });
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function run(label, args) {
  const result = spawnSync(process.execPath, args, { windowsHide: true, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  appendFileSync(log, `${label}\n${result.stdout ?? ''}${result.stderr ?? ''}\nexit=${result.status}\n`);
  console.log(`${label}: ${result.status === 0 ? 'PASS' : 'FAIL'}`);
  if (result.status !== 0) throw new Error(`${label}: see native-conpty-validation.log`);
  const stdout = result.stdout ?? '';
  results.push({ label, exit: result.status, ...Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].flatMap(key => {
    const match = new RegExp(`^(?:ℹ |# )${key} (\\d+)$`, 'm').exec(stdout); return match ? [[key, Number(match[1])]] : [];
  })) });
  for (const line of stdout.split('\n').filter(line => line.includes('{"boundary":"windows-offline-conpty-v1"'))) {
    const evidence = JSON.parse(line.slice(line.indexOf('{')));
    delete evidence.identity; // machine boot/PID and temp paths stay in the local ignored log
    osEvidence.push(evidence);
  }
}
run('renderer typecheck', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']);
run('electron typecheck', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.electron.json']);
run('clean electron output', ['scripts/clean-dist-electron.mjs']);
run('electron build', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.electron.json']);
run('preloads', ['scripts/copy-preloads.mjs']);
run('guard build', ['scripts/build-worker-guard.mjs']);
run('renderer build', ['node_modules/vite/bin/vite.js', 'build']);
const loader = 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("./tests/electron-stub.mjs", pathToFileURL("./"));';
for (const name of ['native-worker-conpty', 'pty-host', 'native-worker-bridge', 'native-worker-scheduler-ports', 'global-hooks-admission', 'native-worker-transport']) {
  run(name, ['--test', '--test-isolation=none', '--test-timeout=120000', '--import', loader, `tests/${name}.test.mjs`]);
}
// Exercise the actual report channel as well as the core mock: report retries
// must not depend on reopening the now-sealed host task input path.
run('offline broker without CLI probes', ['scripts/accept-native-worker.mjs', '--no-cli-probes']);
const sourcePaths = ['electron/native-worker/windows-conpty.ts', 'native/worker-guard/WindowsConPty.cs',
  'native/worker-guard/WindowsGuard.cs', 'electron/pty-host.ts', 'electron/native-worker/run.ts',
  'electron/native-worker/admission.ts', 'electron/worker-scheduler.ts', 'scripts/build-worker-guard.mjs',
  'scripts/verify-native-conpty.mjs', 'tests/fixtures/native-conpty.cs', 'tests/native-worker-conpty.test.mjs',
  'tests/pty-host.test.mjs', 'tests/native-worker-bridge.test.mjs', 'tests/native-worker-scheduler-ports.test.mjs',
  'electron/native-worker/acceptance.ts', 'scripts/accept-native-worker.mjs', '.github/workflows/build-matrix.yml'];
const head = spawnSync('git', ['rev-parse', 'HEAD'], { windowsHide: true, encoding: 'utf8' }).stdout.trim();
writeFileSync(resolve(output, 'local-validation.json'), JSON.stringify({ recordedAt: new Date().toISOString(),
  headAtRun: head, dirtyAtRun: true, base: '8bbb7e07b9b3a375e6a8d28a3bf02c65e0a74008',
  platform: `${process.platform}-${process.arch}`, node: process.version,
  sourceHashes: Object.fromEntries(sourcePaths.map(path => [path, hash(path)])), dependencyLockSha256: hash('package-lock.json'),
  ...(process.platform === 'win32' ? { helperSha256: hash('build/worker-guard/WindowsGuard.exe') } : {}),
  results, osEvidence, cliEngine: 'unknown; not run', nativeSessionId: 'unknown; not bound', stationOwner: 'not wired',
  defaultNativeAdmission: false, scope: 'owned hidden ConPTY and offline protocol evidence only; not P3 or B04' }, null, 2) + '\n');
