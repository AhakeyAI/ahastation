import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const script = fileURLToPath(new URL('../scripts/prepare-codex-compatibility-update.mjs', import.meta.url));
const canonical = JSON.parse(await readFile(new URL('../contracts/runtime/codex.json', import.meta.url), 'utf8'));
const transport = await readFile(new URL('../electron/backends/codex-app-server-transport.ts', import.meta.url));
const protectedFiles = ['contracts/runtime/codex.json', 'package.json', 'package-lock.json',
  'electron/backends/codex-app-server-transport.ts', 'dist-electron/runtime/codex.json'];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-compatibility-candidate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = { name: 'owned-compatibility-fixture', version: '1.0.0', dependencies: { '@openai/codex-sdk': canonical.bundled } };
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {
    '': { dependencies: { ...pkg.dependencies } },
    'node_modules/@openai/codex-sdk': { version: canonical.bundled, integrity: 'sha512-owned-sdk-fixture' },
    'node_modules/@openai/codex': { version: canonical.bundled, integrity: 'sha512-owned-cli-fixture' },
    'node_modules/@openai/codex-win32-x64': { version: canonical.bundled + '-win32-x64', integrity: 'sha512-owned-native-fixture' },
  } };
  const contents = { 'contracts/runtime/codex.json': canonical, 'package.json': pkg, 'package-lock.json': lock,
    'dist-electron/runtime/codex.json': canonical, 'electron/backends/codex-app-server-transport.ts': transport };
  for (const [path, value] of Object.entries(contents)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n');
  }
  await writeFile(join(root, '.gitignore'), 'runtime/\n');
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Owned Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  git(['add', '--all']);
  git(['commit', '-m', 'Owned compatibility fixture']);
  const snapshot = async () => Object.fromEntries(await Promise.all(protectedFiles.map(async path => {
    try { return [path, await readFile(join(root, path))]; }
    catch (error) { if (error.code === 'ENOENT') return [path, null]; throw error; }
  })));
  return { root, pkg, lock, git, snapshot };
}

async function run(fix, { version = canonical.maxExclusive, handshake = { ok: true, version }, contractStatus = '0' } = {}) {
  const resultPath = join(fix.root, 'runtime', 'handshake.json');
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, JSON.stringify(handshake));
  return spawnSync(process.execPath, [script, '--version', version, '--result', resultPath, '--contract-status', contractStatus], {
    cwd: fix.root, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
}

function cannotApply(result, failure = false) {
  assert.equal(result.passed, false, 'handshake/contracts must not masquerade as G8');
  assert.equal(result.updateRequired, failure, 'only failed checks select the upstream investigation report');
  assert.equal(result.canApply, false);
  assert.equal(result.requiresRealSmoke, true);
  assert.equal(result.previousMaxExclusive, canonical.maxExclusive);
  assert.equal(result.nextMaxExclusive, canonical.maxExclusive);
}

test('successful weekly checks prepare a candidate card without changing the sole contract, transport, dependencies or lock', async t => {
  const fix = await fixture(t);
  const before = await fix.snapshot();
  const child = await run(fix);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  cannotApply(result);
  assert.equal(result.checksPassed, true);
  const version = canonical.maxExclusive.split('.').map(Number);
  assert.equal(result.candidateMaxExclusive, `${version[0]}.${version[1]}.${version[2] + 1}`);
  const card = await readFile(result.cardPath, 'utf8');
  assert.match(card, /不代表 G8 已验证/);
  assert.match(card, /自动应用：禁止/);
  assert.match(card, /真实冒烟.*未执行或核验/);
  assert.deepEqual(await fix.snapshot(), before);
  assert.equal(fix.git(['diff', '--name-only']), '');
  assert.equal(fix.git(['ls-files', '--others', '--exclude-standard']), `docs/plans/codex-compatibility-${canonical.maxExclusive}.md`);
});

test('handshake or contract failures still produce failure cards and never signal an applicable update', async t => {
  const fix = await fixture(t);
  const before = await fix.snapshot();
  for (const options of [{ handshake: { ok: false, version: canonical.maxExclusive } },
    { handshake: { ok: true, version: canonical.bundled } }, { contractStatus: '1' }, { contractStatus: '00' }]) {
    const child = await run(fix, options);
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    cannotApply(result, true);
    assert.equal(result.checksPassed, false);
    assert.equal(result.candidateMaxExclusive, null);
    assert.match(await readFile(result.cardPath, 'utf8'), /检查未通过/);
    assert.deepEqual(await fix.snapshot(), before);
  }
});

// Exact upstream workflow at d358977887e45d7cdeeeef66bab77be445f50d1f,
// Git blob 187ea2520200a3ffaca0a5dd9bbd36e6b56655fb. Only checkout CRLF is normalized.
const upstreamWorkflow = (await readFile(new URL('./fixtures/codex-compatibility-workflow.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const upstreamWorkflowHash = 'dbe0c19a9ab9e7e199dee5f8600ef0a3230da4eddfb6bb2da27550f24ac58eb1';

function workflowStep(name) {
  const marker = `      - name: ${name}\n`;
  assert.ok(upstreamWorkflow.includes(marker), name);
  const block = upstreamWorkflow.split(marker)[1].split('\n      - ')[0];
  const run = block.split('        run: |\n')[1];
  assert.ok(run, name);
  return { run: run.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n'),
    condition: block.match(/^        if: (.+)$/m)?.[1] };
}

// The shell fragments and report-title branch are upstream code. These functions
// supply only owned process outcomes and record git/gh argv; no real mutation runs.
const workflowStubs = String.raw`
record() { "$FIXTURE_NODE" -e 'require("node:fs").appendFileSync(process.env.FIXTURE_CALL_LOG,JSON.stringify(process.argv.slice(1))+"\n")' "$@"; }
git() { record git "$@"; }
gh() { record gh "$@"; }
node() {
  case "$1" in
    --test) return "$FIXTURE_CONTRACT_STATUS" ;;
    scripts/check-codex-compatibility.mjs)
      "$FIXTURE_NODE" -e 'const fs=require("node:fs"),a=process.argv.slice(1),ok=process.env.FIXTURE_HANDSHAKE_STATUS==="0";fs.writeFileSync(a[a.indexOf("--out")+1],JSON.stringify({ok,version:ok?a[a.indexOf("--expected-version")+1]:null,...(process.env.FIXTURE_SMOKE_METADATA==="1"?{realSmokePassed:true}:{})}));process.exit(Number(process.env.FIXTURE_HANDSHAKE_STATUS));' "$@" ;;
    scripts/prepare-codex-compatibility-update.mjs)
      shift; "$FIXTURE_NODE" "$FIXTURE_PREPARE" "$@" ;;
    *) "$FIXTURE_NODE" "$@" ;;
  esac
}
`;

async function consumeWorkflow(fix, { version = canonical.maxExclusive, handshakeStatus = '0', contractStatus = '0', smokeMetadata = false } = {}) {
  assert.equal(createHash('sha256').update(upstreamWorkflow).digest('hex'), upstreamWorkflowHash);
  let bash = '/bin/bash';
  if (process.platform === 'win32') {
    const gitPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
    assert.equal(gitPath.status, 0, gitPath.stderr);
    bash = resolve(gitPath.stdout.trim(), '../../../bin/bash.exe');
  }
  await access(bash);
  const runner = join(fix.root, 'runtime');
  const latest = join(runner, 'codex-latest/node_modules/@openai/codex/package.json');
  await mkdir(dirname(latest), { recursive: true });
  await writeFile(latest, JSON.stringify({ version }));
  const envFile = join(runner, 'github-env');
  const callLog = join(runner, 'workflow-calls.jsonl');
  await writeFile(envFile, '');
  await writeFile(callLog, '');
  const env = { ...process.env, PATH: '', BASH_ENV: '', ENV: '', CDPATH: '',
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined, SHELLOPTS: undefined, BASHOPTS: undefined,
    FIXTURE_NODE: process.execPath.replaceAll('\\', '/'), FIXTURE_PREPARE: script.replaceAll('\\', '/'),
    FIXTURE_CALL_LOG: callLog, FIXTURE_HANDSHAKE_STATUS: handshakeStatus,
    FIXTURE_CONTRACT_STATUS: contractStatus, FIXTURE_SMOKE_METADATA: smokeMetadata ? '1' : '0',
    RUNNER_TEMP: runner.replaceAll('\\', '/'), GITHUB_ENV: envFile.replaceAll('\\', '/'), GITHUB_RUN_ID: 'owned-123' };
  const execute = step => {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', workflowStubs + step.run], {
      cwd: fix.root, env, encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result;
  };
  const readEnv = async () => Object.assign(env, Object.fromEntries((await readFile(envFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => {
    const equal = line.indexOf('='); return [line.slice(0, equal), line.slice(equal + 1)];
  })));
  execute(workflowStep('Run initialize handshake and adapter contracts without a model turn'));
  await readEnv();
  const prepared = execute(workflowStep('Prepare verified-range update or failure card'));
  await readEnv();
  const report = workflowStep('Open a human-review compatibility PR');
  // Execute the original fixed workflow's expression, not a recreated policy.
  if (runInNewContext(report.condition, { env }, { timeout: 1000 })) execute(report);
  return { result: JSON.parse(prepared.stdout), env,
    calls: (await readFile(callLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

test('actual upstream workflow keeps successful normal/new/unverified-smoke checks out of the upgrade PR', async t => {
  const fix = await fixture(t);
  const before = await fix.snapshot();
  for (const options of [{ version: canonical.bundled }, {}, { smokeMetadata: true }]) {
    const consumed = await consumeWorkflow(fix, options);
    cannotApply(consumed.result);
    assert.equal(consumed.env.HANDSHAKE_STATUS, '0');
    assert.equal(consumed.env.CONTRACT_STATUS, '0');
    assert.equal(consumed.env.UPDATE_REQUIRED, 'false');
    assert.deepEqual(consumed.calls, [], 'the real workflow condition must skip all git/gh actions');
    assert.deepEqual(await fix.snapshot(), before);
    assert.equal(fix.git(['branch', '--show-current']), 'main');
  }
});

for (const [name, options] of [
  ['handshake failure', { handshakeStatus: '1' }],
  ['contract failure', { contractStatus: '1' }],
]) test(`actual upstream workflow selects only the investigation report for ${name}`, async t => {
  const fix = await fixture(t);
  const before = await fix.snapshot();
  const consumed = await consumeWorkflow(fix, options);
  cannotApply(consumed.result, true);
  assert.equal(consumed.result.checksPassed, false);
  assert.equal(consumed.env.UPDATE_REQUIRED, 'true');
  const title = `chore(codex): investigate ${canonical.maxExclusive} compatibility failure`;
  assert.deepEqual(consumed.calls.find(call => call[0] === 'git' && call[1] === 'add'),
    ['git', 'add', 'electron/backends/codex-app-server-transport.ts', `docs/plans/codex-compatibility-${canonical.maxExclusive}.md`]);
  assert.deepEqual(consumed.calls.find(call => call[0] === 'git' && call[1] === 'commit'), ['git', 'commit', '-m', title]);
  const pr = consumed.calls.find(call => call[0] === 'gh');
  assert.ok(pr, 'the source workflow must reach its human investigation report step');
  assert.deepEqual(pr.slice(0, 4), ['gh', 'pr', 'create', '--base']);
  assert.equal(pr[pr.indexOf('--title') + 1], title);
  assert.equal(pr[pr.indexOf('--body-file') + 1], `docs/plans/codex-compatibility-${canonical.maxExclusive}.md`);
  assert.equal(consumed.calls.some(call => call.some(arg => arg.includes('expand compatible range'))), false);
  assert.match(await readFile(consumed.result.cardPath, 'utf8'), /检查未通过/);
  assert.deepEqual(await fix.snapshot(), before);
  assert.equal(fix.git(['branch', '--show-current']), 'main', 'git/gh shell functions never mutate the owned repository');
});

test('versions already inside or below the interval never lower its bounds or replace the bundled runtime', async t => {
  const fix = await fixture(t);
  const before = await fix.snapshot();
  for (const version of [canonical.bundled, '0.0.0']) {
    const child = await run(fix, { version });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    cannotApply(result);
    assert.equal(result.candidateMaxExclusive, null);
    assert.deepEqual(await fix.snapshot(), before);
  }
});

test('unverified real-smoke flags or metadata in a handshake cannot turn candidate preparation into G8 approval', async t => {
  const fix = await fixture(t);
  const before = await fix.snapshot();
  const child = await run(fix, { handshake: { ok: true, version: canonical.maxExclusive, realSmokePassed: true,
    realVerticalSmoke: { schemaVersion: 1, kind: 'real-backend-smoke', backendId: 'codex', runtimeVersion: canonical.maxExclusive,
      runId: 'owned-format-fixture-not-real-smoke', verifiedAt: '2026-10-30T00:00:00Z',
      checks: ['work-report', 'interrupt', 'resume', 'permission-bridge', 'canonical-permission-normalization', 'recovery'] } } });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  cannotApply(result);
  assert.equal(result.checksPassed, true);
  assert.deepEqual(await fix.snapshot(), before);
});

test('missing or invalid canonical contracts fail closed even when a generated contract exists', async t => {
  const fix = await fixture(t);
  const path = join(fix.root, 'contracts/runtime/codex.json');
  for (const body of [null, '{bad-json', '{}', JSON.stringify({ ...canonical, schemaVersion: 2 }),
    JSON.stringify({ ...canonical, min: canonical.maxExclusive }), JSON.stringify({ ...canonical, bundled: canonical.maxExclusive }),
    JSON.stringify({ ...canonical, maxExclusive: '9007199254740992.0.0' })]) {
    if (body === null) await unlink(path);
    else await writeFile(path, body);
    const before = await fix.snapshot();
    const child = await run(fix);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /ENOENT|JSON|Invalid Codex runtime contract/);
    assert.deepEqual(await fix.snapshot(), before);
    await assert.rejects(access(join(fix.root, 'docs')), /ENOENT/);
  }
});

test('package and Codex dependency lock drift refuse candidate cards instead of silently repairing or repinning dependencies', async t => {
  const fix = await fixture(t);
  for (const kind of ['package', 'lock-root', 'lock-sdk', 'lock-native', 'lock-integrity']) {
    const pkg = structuredClone(fix.pkg);
    const lock = structuredClone(fix.lock);
    if (kind === 'package') pkg.dependencies['@openai/codex-sdk'] = canonical.maxExclusive;
    if (kind === 'lock-root') lock.packages[''].dependencies['@openai/codex-sdk'] = canonical.maxExclusive;
    if (kind === 'lock-sdk') lock.packages['node_modules/@openai/codex-sdk'].version = canonical.maxExclusive;
    if (kind === 'lock-native') lock.packages['node_modules/@openai/codex-win32-x64'].version = canonical.maxExclusive + '-win32-x64';
    if (kind === 'lock-integrity') delete lock.packages['node_modules/@openai/codex-sdk'].integrity;
    await writeFile(join(fix.root, 'package.json'), JSON.stringify(pkg));
    await writeFile(join(fix.root, 'package-lock.json'), JSON.stringify(lock));
    const before = await fix.snapshot();
    const child = await run(fix);
    assert.equal(child.status, 1, kind);
    assert.match(child.stderr, /Bundled Codex/);
    assert.deepEqual(await fix.snapshot(), before, kind);
    await assert.rejects(access(join(fix.root, 'docs')), /ENOENT/);
  }
});

test('invalid candidate versions and unsafe candidate upper bounds cannot create cards or touch protected files', async t => {
  const fix = await fixture(t);
  const before = await fix.snapshot();
  for (const version of ['../private', '0.157.0-beta.1', '00.157.0', '9007199254740992.0.0', '1.2.9007199254740991']) {
    const child = await run(fix, { version });
    assert.equal(child.status, 1, version);
    assert.match(child.stderr, /Invalid stable semantic version|upper bound is not a safe integer/);
    assert.deepEqual(await fix.snapshot(), before);
    await assert.rejects(access(join(fix.root, 'docs')), /ENOENT/);
  }
});
