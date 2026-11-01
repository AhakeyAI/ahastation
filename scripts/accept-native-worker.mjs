// Deliberate offline acceptance entry, independent of default admission.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runNativeWorkerOfflineAcceptance } from '../dist-electron/native-worker/acceptance.js';
const helper = resolve('build/worker-guard/WindowsGuard.exe');
const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const hash = process.platform === 'win32' ? hashFile(helper) : '';
const cliProbes = process.platform === 'win32' && !process.argv.includes('--no-cli-probes') ? [
  { agent: 'claude', path: resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe') },
  { agent: 'codex', path: resolve('node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe') },
].map(value => ({ ...value, sha256: hashFile(value.path) })) : [];
console.log(JSON.stringify(await runNativeWorkerOfflineAcceptance(helper, hash, cliProbes), null, 2));
