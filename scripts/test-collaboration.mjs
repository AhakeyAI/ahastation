import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.COLLABORATION_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
function run(command, args, cwd = root, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// A missing Python/dependency is a failure of this dedicated command, never a silent skip.
run(python, ['-m', 'unittest', 'discover', '-s', 'collaboration_contracts/tests', '-v'],
  fileURLToPath(new URL('../services/remote/', import.meta.url)));
run(process.execPath, ['--test', '--test-concurrency=4', '--test-timeout=120000',
  'tests/collaboration-contracts.test.mjs', 'tests/collaboration-mocks.test.mjs',
  'tests/collaboration-project-access.test.mjs'], root,
  { ...process.env, COLLABORATION_PYTHON: python });
