import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, readdir, writeFile} from 'node:fs/promises';
import {dirname, delimiter, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium} from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(root, 'runtime', 'offline-tests');
await mkdir(evidence, {recursive: true});
const folder = await mkdtemp(join(evidence, 'run-'));
const home = join(folder, 'home');
await mkdir(home, {recursive: true});
const preload = resolve(root, 'tests/offline-network.mjs');
const python = process.env.COLLABORATION_PYTHON || process.env.POCKET_VIBE_TEST_PYTHON;
// Resolve the installed browser before the child receives its private HOME.
// This only reads Playwright metadata; non-browser tests need no download.
const browserExecutable = process.env.STATION_CHROME ?? chromium.executablePath();
const git = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], {encoding: 'utf8', windowsHide: true});
if (git.status !== 0) throw new Error('Offline tests require a local Git executable');
const gitDirectory = dirname(git.stdout.trim().split(/\r?\n/)[0]);
const path = [dirname(process.execPath), gitDirectory, ...(python ? [dirname(python)] : []),
  ...(process.platform === 'win32' ? [join(process.env.SystemRoot, 'System32'), process.env.SystemRoot] : ['/usr/bin', '/bin'])];
const env = {
  ...process.env,
  PATH: path.join(delimiter),
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'),
  XDG_DATA_HOME: join(home, 'data'), APPDATA: join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(home, 'AppData', 'Local'),
  CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
  POCKET_VIBE_STATE_DIR: join(folder, 'native-state'),
  AHASTATION_OFFLINE_TEST_ROOT: folder,
  AHASTATION_ENABLE_COLLABORATION: '1',
  AHASTATION_REMOTE_ALLOW_LOOPBACK: '1',
  AHASTATION_USER_DATA_DIR: join(folder, 'profile'),
  STATION_CHROME: browserExecutable,
  NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  PYTHONPATH: join(root, 'tests/fixtures/offline-python'),
  PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
  NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
  HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
  GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1',
  npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
};
await Promise.all([env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME,
  env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, env.AHASTATION_USER_DATA_DIR].map(path => mkdir(path, {recursive: true})));
for (const key of Object.keys(env)) {
  if (/API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|^GIT_ASKPASS$|^SSH_ASKPASS$|^OPENAI_BASE_URL$|^ANTHROPIC_BASE_URL$|^MYSQL_|^HUB_TEST_MYSQL_URL$|^COLLABORATION_TEST_MYSQL_FILE$|^HUB_DATABASE_URL$/i.test(key)) delete env[key];
}
await writeFile(join(folder, 'isolation.json'), JSON.stringify({
  loopbackOnly: true, isolatedHome: true, inheritedModelCredentials: false,
  nodeSocketGuard: true, pythonSocketGuard: true,
  browserExecutable,
  nativePrograms: 'Fixtures must use owned local repositories and fake agents; native programs are not an OS network sandbox.',
}, null, 2));

const mode = process.argv[2] || 'all';
const loader = "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./')); await import(pathToFileURL('./tests/fixtures/offline-backends.mjs').href);";
let args;
let command = process.execPath;
if (mode === 'collaboration') args = ['scripts/test-collaboration.mjs'];
else if (mode === 'mysql') {
  const [mysqlBase, output] = process.argv.slice(3);
  if (!python || !mysqlBase || !output || process.argv.length !== 5) throw new Error('Expected COLLABORATION_PYTHON and explicit MySQL distribution/output directories');
  command = python;
  args = ['scripts/rehearse-collaboration-mysql.py', '--mysql-base', resolve(mysqlBase), '--output', resolve(output), '--navicat-upgrade-checks'];
  env.NODE_OPTIONS += ` --import=data:text/javascript,${encodeURIComponent(loader.slice('data:text/javascript,'.length))}`;
}
else if (mode === 'all') {
  const files = (await readdir(join(root, 'tests'))).filter(name => name.endsWith('.test.mjs')).sort();
  args = ['--test', '--test-concurrency=2', '--test-timeout=120000', '--import', loader, ...files.map(name => `tests/${name}`)];
} else if (mode === 'files') {
  const files = process.argv.slice(3);
  if (!files.length || files.some(name => !/^tests\/[\w.-]+\.test\.mjs$/.test(name))) throw new Error('Expected explicit test files under tests/');
  args = ['--test', '--test-concurrency=2', '--test-timeout=120000', '--import', loader, ...files];
} else throw new Error('Expected all, collaboration, files, or mysql');
console.log(`Offline test evidence: ${folder}`);
const result = spawnSync(command, args, {cwd: root, env, stdio: 'inherit', windowsHide: true});
if (result.error) console.error(result.error.message);
await writeFile(join(folder, 'exit.json'), JSON.stringify({mode, exitCode: result.status, signal: result.signal, error: result.error?.message}, null, 2));
process.exit(result.status ?? 1);
