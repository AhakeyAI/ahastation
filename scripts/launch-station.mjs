// User-owned double-click launcher. No Vite server, model turn or auth changes.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, join, delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

export function applicationEnv(source, nodePath, gitDir) {
  const env = { ...source };
  // Scoped to this app process: inherited Electron-as-Node/debug settings can
  // turn a GUI launch into a CLI process, or force connection to a stale Vite.
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'VITE_DEV_SERVER_URL', 'VIBE_MEET_DEVTOOLS']) delete env[key];
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = [dirname(nodePath), gitDir, env[pathKey]].filter(Boolean).join(delimiter);
  return env;
}

export function findGit(env, nodePath, run = spawnSync) {
  const candidates = ['git',
    env.ProgramFiles && join(env.ProgramFiles, 'Git', 'cmd', 'git.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'),
    join(dirname(nodePath), '..', '..', 'native', 'git', 'cmd', 'git.exe')].filter(Boolean);
  for (const binary of candidates) {
    const result = run(binary, ['--version'], { env, encoding: 'utf8', windowsHide: true });
    if (result.status === 0 && /^git version /m.test(result.stdout ?? '')) return binary === 'git' ? undefined : dirname(binary);
  }
  throw new Error('Git was not found. Install Git for Windows or add it to PATH, then retry.');
}

export function launchDetached(binary, args, { cwd, env }, spawnImpl = spawn) {
  return new Promise((resolveLaunch, reject) => {
    const child = spawnImpl(binary, args, { cwd, env, detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolveLaunch(child.pid); });
  });
}

export async function launchStation() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const logDir = join(tmpdir(), 'AhaStation-launch', new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
  mkdirSync(logDir, { recursive: true });
  const log = (event) => appendFileSync(join(logDir, 'launcher.log'), `${new Date().toISOString()} ${event}\n`);
  console.log(`Launch logs: ${logDir}`);
  log(`launcher-start pid=${process.pid} parent=${process.ppid} node=${process.version}`);
  try {
    const gitDir = findGit(process.env, process.execPath);
    const env = applicationEnv(process.env, process.execPath, gitDir);
    env.AHASTATION_LAUNCH_LOG_DIR = logDir;
    if (!existsSync(join(root, 'node_modules', 'electron'))) throw new Error('Dependencies missing. Run the existing npm install/setup first.');
    // Use bundled assets; an existing or conflicting port 5173 is irrelevant.
    // Preserve the existing dev scripts for developers using Vite/HMR.
    const steps = [
      ['scripts/clean-dist-electron.mjs'],
      ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.electron.json'],
      ['scripts/copy-preloads.mjs'],
      ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'],
      ['node_modules/vite/bin/vite.js', 'build'],
    ];
    for (const args of steps) {
      log(`build-start ${args[0]}`);
      const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
      if (result.error || result.status !== 0) throw new Error(`Build failed: ${args[0]} (exit ${result.status ?? 'spawn error'})`);
      log(`build-end ${args[0]}`);
    }
    const electron = createRequire(import.meta.url)('electron');
    const pid = await launchDetached(electron, ['.'], { cwd: root, env });
    log(`electron-spawn pid=${pid}; launcher exits without waiting`);
    console.log('AhaStation launch requested. The existing single-instance app will show/focus its window.');
    console.log('If no window appears, inspect lifecycle.jsonl in the log directory above.');
  } catch (error) {
    log(`launcher-failed ${error instanceof Error ? error.message : 'unknown error'}`);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launchStation().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
