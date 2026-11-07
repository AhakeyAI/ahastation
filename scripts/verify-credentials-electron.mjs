/** Real OS credential round-trip in two windowless Electron processes. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output'))
  throw new Error('Usage: node scripts/verify-credentials-electron.mjs [--output NEW_DIRECTORY]');
const output = args.length ? resolve(args[1]) : await (async () => {
  const base = resolve(process.env.AHASTATION_TEST_EVIDENCE_DIR ?? join(root, 'runtime/t'));
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, 'cred-'));
})();
if (args.length) await mkdir(output); // Never reuse or overwrite an existing profile.
const profile = join(output, 'profile');
await mkdir(profile, { mode: 0o700 });
await mkdir(join(profile, 'session'), { mode: 0o700 });
const token = 'generated-credential-probe-' + randomUUID();
const tokenHash = createHash('sha256').update(token).digest('hex');
const nonce = randomUUID();
await writeFile(join(output, 'probe.json'), JSON.stringify({ nonce, tokenHash }), { mode: 0o600 });
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$|^HUB_|^MYSQL_|^VITE_/i.test(key)) delete env[key];
}
Object.assign(env, {
  AHASTATION_ENABLE_COLLABORATION: '', AHASTATION_COLLABORATION_MODE: '',
  AHASTATION_REMOTE_ALLOW_LOOPBACK: '', AHASTATION_COLLABORATION_TEST_HUB: '',
  AHASTATION_USER_DATA_DIR: profile,
  AHASTATION_CREDENTIAL_PROBE_TOKEN: token, AHASTATION_CREDENTIAL_PROBE_NONCE: nonce,
});
const processes = [];
const report = { output, profile, tokenHash, modelInvoked: false, collaborationEnabled: false };
try {
  for (const phase of ['write', 'read']) {
    const command = [fileURLToPath(new URL('../tests/fixtures/real-credential-probe.mjs', import.meta.url)), output, phase];
    const logFile = join(output, phase + '.log');
    await writeFile(logFile, '');
    const child = spawn(electron, command, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const record = { phase, executable: electron, command, pid: child.pid, exitCode: null };
    processes.push(record);
    const append = bytes => appendFileSync(logFile, bytes);
    child.stdout.on('data', append); child.stderr.on('data', append);
    const exitCode = await new Promise((done, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 45000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => {
        clearTimeout(timer); record.exitCode = code;
        if (timedOut) reject(new Error('Owned credential probe timed out'));
        else done(code);
      });
    });
    assert.equal(exitCode, 0, 'Electron phase failed; see its isolated log');
    report[phase] = JSON.parse(await readFile(join(output, phase + '.json'), 'utf8'));
  }
  assert.notEqual(processes[0].pid, processes[1].pid, 'Read must use a new Electron process');
  assert.equal(report.write.secureStorage, report.read.secureStorage, 'OS storage availability changed between processes');
  report.status = report.read.secureStorage ? 'passed' : 'limited';
  report.reason = report.read.secureStorage ? undefined : 'OS secure storage unavailable: memory-only fallback checked; encrypted restart not accepted';
} catch (error) {
  report.status = 'failed'; report.error = error.stack;
} finally {
  report.processes = processes;
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ status: report.status, output, reason: report.reason }));
process.exitCode = report.status === 'passed' ? 0 : report.status === 'limited' ? 2 : 1;
