import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, copyFile, mkdir, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CODEX_RUNTIME, readCodexRuntimeContract, validateCodexRuntimeContract, isSupportedCodexAppServerVersion } from '../dist-electron/backends/codex-runtime.js';
import { resolveCodexRuntime } from '../dist-electron/backends/codex-adapter.js';

test('the bundled SDK, lockfile, generated contract and package allowlist agree with the canonical interval', async () => {
  const read = async path => JSON.parse(await readFile(new URL('../' + path, import.meta.url), 'utf8'));
  const canonical = await read('contracts/runtime/codex.json');
  const exportable = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'contracts/runtime/codex.json'], { encoding: 'utf8', windowsHide: true });
  assert.equal(exportable.trim(), 'contracts/runtime/codex.json');
  assert.deepEqual(CODEX_RUNTIME, canonical);
  assert.deepEqual(await read('dist-electron/runtime/codex.json'), canonical);
  const pkg = await read('package.json');
  const lock = await read('package-lock.json');
  assert.equal(pkg.dependencies['@openai/codex-sdk'], canonical.bundled);
  assert.equal(lock.packages[''].dependencies['@openai/codex-sdk'], canonical.bundled);
  for (const [name, value] of Object.entries(lock.packages).filter(([name]) => name.startsWith('node_modules/@openai/codex'))) {
    assert.equal(value.version.split('-')[0], canonical.bundled, name);
    assert.ok(value.integrity?.startsWith('sha512-'), name);
  }
  assert.ok((await read('electron-builder.json')).files.includes('contracts/runtime/codex.json'));
});

test('invalid, reversed or out-of-range runtime contracts fail closed', async () => {
  for (const bad of [null, [], {}, { ...CODEX_RUNTIME, schemaVersion: true },
    { ...CODEX_RUNTIME, unexpected: true }, { ...CODEX_RUNTIME, min: CODEX_RUNTIME.maxExclusive },
    { ...CODEX_RUNTIME, bundled: '0.164.0' }, { ...CODEX_RUNTIME, bundled: '0.156.1-beta.1' },
    { ...CODEX_RUNTIME, maxExclusive: '9007199254740992.0.0' }]) {
    assert.throws(() => validateCodexRuntimeContract(bad), /Invalid Codex runtime contract/);
  }
  const root = await mkdtemp(join(tmpdir(), 'codex-runtime-contract-'));
  try {
    assert.throws(() => readCodexRuntimeContract(join(root, 'missing.json')), /ENOENT/);
    await writeFile(join(root, 'invalid.json'), '{');
    assert.throws(() => readCodexRuntimeContract(join(root, 'invalid.json')), SyntaxError);
    // A packaged/compiled loader must not recover a missing asset from the source checkout.
    await mkdir(join(root, 'backends'));
    const loader = join(root, 'backends/codex-runtime.mjs');
    await copyFile(new URL('../dist-electron/backends/codex-runtime.js', import.meta.url), loader);
    assert.throws(() => execFileSync(process.execPath, [loader], { encoding: 'utf8', stdio: 'pipe' }), /ENOENT/);
    await mkdir(join(root, 'runtime'));
    await writeFile(join(root, 'runtime/codex.json'), JSON.stringify({ ...CODEX_RUNTIME, bundled: '0.164.0' }));
    assert.throws(() => execFileSync(process.execPath, [loader], { encoding: 'utf8', stdio: 'pipe' }), /Invalid Codex runtime contract/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('TypeScript and Python accept the same stable versions and reject the same boundaries', t => {
  const python = process.env.COLLABORATION_PYTHON ?? process.env.POCKET_VIBE_TEST_PYTHON;
  if (!python) { t.skip('Set COLLABORATION_PYTHON to run the cross-language interval check'); return; }
  const versions = [null, '', '0.156.0', '0.156.1', '0.156.2', '0.156.999', '0.157.0', '0.164.0',
    '0.156.1-beta.1', '0.156.1+build', '00.156.1', '0.156', '0.156.1.2', '0.15\u0666.1', '0.156.1\u0660', '9007199254740992.0.0'];
  const code = "import json,sys; sys.path.insert(0,'services/remote/device'); from codex_runtime import CODEX_RUNTIME,is_supported; print(json.dumps({'contract':CODEX_RUNTIME,'accepted':[is_supported(v) for v in json.load(sys.stdin)]}))";
  const result = JSON.parse(execFileSync(python, ['-c', code], { input: JSON.stringify(versions), encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(result.contract, CODEX_RUNTIME);
  assert.deepEqual(result.accepted, versions.map(isSupportedCodexAppServerVersion));
});

test('resolveCodexRuntime prefers an executable unpacked native binary', async (t) => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    t.skip('fixture currently targets the macOS ARM64 release build');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'ahastation-codex-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(
    root,
    'app.asar.unpacked/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
  );
  await mkdir(join(binary, '..'), { recursive: true });
  await writeFile(binary, '#!/bin/sh\nexit 0\n');
  await chmod(binary, 0o755);

  assert.equal(resolveCodexRuntime(root), await realpath(binary));
  assert.equal(resolveCodexRuntime(root).includes('app.asar/'), false);
});
