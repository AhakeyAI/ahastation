import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.COLLABORATION_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
function run(command, args, cwd = root, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', windowsHide: true,timeout:900000 });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// A missing Python/dependency is a failure of this dedicated command, never a silent skip.
run(process.execPath,['scripts/build-station-native.mjs'],root,{...process.env,AHASTATION_BUILD_PYTHON:python});
run(python, ['-m', 'unittest', 'discover', '-s', 'collaboration_contracts/tests', '-v'],
  fileURLToPath(new URL('../services/remote/', import.meta.url)));
for(const pattern of [
  'test_collaboration_p1.py','test_ui_fixes_native.py','test_ui_fixes_hub.py',
  'test_collaboration_hardening.py','test_collaboration_stability.py','test_collaboration_review_fixes.py',
  'test_station_collaboration.py','test_unified_meeting.py','test_station_codex_guardian.py',
  'test_codex_shared.py','test_probe_package.py',
])run(python,['-m','unittest','discover','-s','services/remote/tests','-p',pattern,'-v']);
run(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=120000',
  '--import',"data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));",
  'tests/collaboration-completion-evidence.test.mjs','tests/collaboration-p1-regression.test.mjs','tests/collaboration-ui-fixes.test.mjs',
  'tests/collaboration-ui-fixes-browser.test.mjs','tests/collaboration-ui-fixes-chain.test.mjs',
  'tests/collaboration-hardening.test.mjs','tests/collaboration-hardening-http.test.mjs',
  'tests/collaboration-hardening-git.test.mjs','tests/collaboration-hardening-scheduling.test.mjs',
  'tests/collaboration-stability.test.mjs','tests/collaboration-stability-ui.test.mjs',
  'tests/collaboration-review-fixes.test.mjs','tests/unified-meeting.test.mjs',
  'tests/collaboration-contracts.test.mjs','tests/collaboration-mocks.test.mjs',
  'tests/collaboration-project-access.test.mjs','tests/station-collaboration.test.mjs','tests/station-git-delivery.test.mjs','tests/station-process-recovery.test.mjs','tests/station-native-flow.test.mjs'], root,
  { ...process.env, COLLABORATION_PYTHON: python,POCKET_VIBE_TEST_PYTHON:python });
