// Offline #86 validation. No login probes, real PTYs, models, global hooks or
// GitHub writes. Each reviewed mock test runs in a hidden Node process with
// in-process test isolation, avoiding the runner's implicit child processes.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const log = resolve('issue-86-validation.log');
writeFileSync(log, `Node ${process.version}; ${process.platform}; ${new Date().toISOString()}\n`);
const results = [];
function node(label, args) {
  const result = cp.spawnSync(process.execPath, args, { cwd: root, windowsHide: true, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  appendFileSync(log, `\n${label}\n${result.stdout ?? ''}${result.stderr ?? ''}\nexit=${result.status}\n`);
  console.log(`${label}: ${result.status === 0 ? 'PASS' : 'FAIL'}`);
  if (result.status !== 0) { console.error(result.error ?? result.stdout ?? result.stderr); process.exit(1); }
  results.push({ name: label, exit: result.status,
    ...Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].flatMap(key => {
      const match = new RegExp(`^(?:ℹ |# )${key} (\\d+)$`, 'm').exec(result.stdout ?? '');
      return match ? [[key, Number(match[1])]] : [];
    })) });
}
node('renderer typecheck', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']);
node('electron typecheck', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.electron.json']);
node('clean electron output', ['scripts/clean-dist-electron.mjs']);
node('electron build', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.electron.json']);
node('preload copy', ['scripts/copy-preloads.mjs']);
node('renderer build', ['node_modules/vite/bin/vite.js', 'build']); // esbuild's own subprocesses use windowsHide
// The existing manifest script invokes git synchronously. Keep those owned
// subprocesses hidden without altering the unrelated manifest format.
const execFileSync = cp.execFileSync;
cp.execFileSync = (file, args, options) => execFileSync(file, args, { ...options, windowsHide: true });
syncBuiltinESMExports();
await import('./write-station-build-manifest.mjs');
const loader = 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("./tests/electron-stub.mjs", pathToFileURL("./"));';
const tests = ['native-worker-bridge', 'global-hooks-admission', 'claude-terminal-adapter', 'codex-terminal-adapter',
  'kimi-terminal-adapter', 'qoder-terminal-adapter', 'task-authority', 'plan-task-profile', 'backend-canonical-execution',
  'permission-approval-memory', 'codex-adapter', 'renderer-plan-validation', 'kickoff'];
for (const name of tests) node(name, ['--test', '--test-isolation=none', '--test-timeout=120000', '--import', loader, `tests/${name}.test.mjs`]);
mkdirSync('docs/evidence/issue-86', { recursive: true });
const manifest = JSON.parse(readFileSync('dist-electron/STATION-SOURCE-MANIFEST.json', 'utf8'));
writeFileSync('docs/evidence/issue-86/local-validation.json', JSON.stringify({ recordedAt: new Date().toISOString(),
  node: process.version, platform: process.platform, gitHeadAtRun: manifest.gitHead, dirtyAtRun: manifest.dirty,
  sourceDigest: manifest.sourceDigest, dependencyLockSha256: manifest.dependencyLockSha256,
  verifierSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  scope: 'typechecks, builds, mocked protocol tests; no native engine enforcement/real WorkReport/B04 claim', results }, null, 2) + '\n');
console.log(`Completed ${tests.length} targeted mock suites. Evidence: ${log}`);
