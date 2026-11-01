// Hidden, targeted local verification. Never run npm test or personal CLIs.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve('.');
const output = resolve('docs/evidence/native-worker-production'); mkdirSync(output, { recursive: true });
const log = resolve('native-production-validation.log'); writeFileSync(log, '');
const results = [];
let transportFaultEvidence = [];
const sourcePaths = ['electron/main.ts', 'electron/worker-scheduler.ts', 'electron/native-worker/run.ts',
  'electron/native-worker/admission.ts', 'electron/native-worker/windows-guard.ts', 'electron/native-worker/broker-channel.ts',
  'electron/native-worker/profile-service.ts', 'electron/native-worker/acceptance.ts', 'native/worker-guard/WindowsGuard.cs',
  'scripts/build-worker-guard.mjs', 'scripts/accept-native-worker.mjs', 'scripts/verify-native-production.mjs',
  'tests/native-worker-bridge.test.mjs', 'tests/native-worker-scheduler-ports.test.mjs', 'tests/native-worker-transport.test.mjs',
  'electron/native-worker/utf8-frames.ts', 'package.json', 'electron-builder.json', '.github/workflows/build-matrix.yml'];
function run(label, args) {
  const r = spawnSync(process.execPath, args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  appendFileSync(log, `${label}\n${r.stdout ?? ''}${r.stderr ?? ''}\nexit=${r.status}\n`);
  console.log(`${label}: ${r.status === 0 ? 'PASS' : 'FAIL'}`);
  if (r.status !== 0) throw new Error(`${label} failed; see native-production-validation.log`);
  results.push({ label, exit: r.status }); return r.stdout;
}
run('renderer typecheck', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']);
run('electron typecheck', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.electron.json']);
run('clean build output', ['scripts/clean-dist-electron.mjs']);
run('electron build', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.electron.json']);
run('preloads', ['scripts/copy-preloads.mjs']);
run('renderer build', ['node_modules/vite/bin/vite.js', 'build']);
run('guard build', ['scripts/build-worker-guard.mjs']);
const loader = 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("./tests/electron-stub.mjs", pathToFileURL("./"));';
for (const name of ['native-worker-bridge', 'global-hooks-admission', 'permission-approval-memory', 'plan-task-profile', 'permission-broker', 'native-worker-scheduler-ports', 'native-worker-transport']) {
  const stdout = run(name, ['--test', '--test-isolation=none', '--test-timeout=120000', '--import', loader, `tests/${name}.test.mjs`]);
  if (name === 'native-worker-transport') transportFaultEvidence = stdout.split('\n')
    .filter(line => /\{"mode":.*"pendingBytes":/.test(line)).map(line => JSON.parse(line.slice(line.indexOf('{'))));
}
const acceptance = JSON.parse(run('real guard and channel', ['scripts/accept-native-worker.mjs']));
// Do not publish machine-specific temporary paths/identity/credentials.
delete acceptance.root;
const head = spawnSync('git', ['rev-parse', 'HEAD'], { windowsHide: true, encoding: 'utf8' }).stdout.trim();
writeFileSync(resolve(output, 'local-validation.json'), JSON.stringify({ recordedAt: new Date().toISOString(),
  headAtRun: head, dirtyAtRun: true, platform: `${process.platform}-${process.arch}`, node: process.version,
  sourceHashes: Object.fromEntries(sourcePaths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
  dependencyLockSha256: createHash('sha256').update(readFileSync('package-lock.json')).digest('hex'), results, acceptance, transportFaultEvidence,
  scope: 'targeted local checks and real Windows offline broker, not engine/B04 certification' }, null, 2) + '\n');
