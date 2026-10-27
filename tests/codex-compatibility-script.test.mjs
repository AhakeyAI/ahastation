import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCodexHandshake } from '../scripts/check-codex-compatibility.mjs';
import { prepareCompatibilityUpdate } from '../scripts/prepare-codex-compatibility-update.mjs';

const fixture = fileURLToPath(new URL('./fixtures/codex/fake-app-server.mjs', import.meta.url));

test('Codex compatibility handshake stops after initialize and checks the exact version', async () => {
  const ok = await runCodexHandshake({
    binary: process.execPath,
    prefixArgs: [fixture],
    expectedVersion: '0.157.2',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.version, '0.157.2');
  assert.equal(ok.accountRead, false);
  assert.equal(ok.modelTurn, false);
  assert.deepEqual(ok.methods, ['initialize', 'initialized']);

  const mismatch = await runCodexHandshake({
    binary: process.execPath,
    prefixArgs: [fixture],
    expectedVersion: '0.157.3',
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /version mismatch/);
});

test('Codex compatibility update expands only a passing newer version and writes a failure card otherwise', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ahastation-codex-update-'));
  const previous = process.cwd();
  t.after(() => {
    process.chdir(previous);
    return rm(root, { recursive: true, force: true });
  });
  const sourceDir = join(root, 'electron', 'backends');
  await mkdir(sourceDir, { recursive: true });
  const sourcePath = join(sourceDir, 'codex-app-server-transport.ts');
  await writeFile(sourcePath, "export const CODEX_APP_SERVER_MAX_EXCLUSIVE_VERSION = '0.157.0';\n");
  const resultPath = join(root, 'result.json');
  await writeFile(resultPath, JSON.stringify({ ok: true, version: '0.157.2' }));
  process.chdir(root);

  const passing = await prepareCompatibilityUpdate({ version: '0.157.2', result: resultPath, contractStatus: '0' });
  assert.equal(passing.passed, true);
  assert.equal(passing.updateRequired, true);
  assert.equal(passing.nextMaxExclusive, '0.157.3');
  assert.match(await readFile(sourcePath, 'utf8'), /0\.157\.3/);

  const inRange = await prepareCompatibilityUpdate({ version: '0.157.2', result: resultPath, contractStatus: '0' });
  assert.equal(inRange.updateRequired, false);

  await writeFile(resultPath, JSON.stringify({ ok: false, error: 'initialize failed' }));
  const failing = await prepareCompatibilityUpdate({ version: '0.158.0', result: resultPath, contractStatus: '1' });
  assert.equal(failing.passed, false);
  assert.equal(failing.updateRequired, true);
  assert.match(await readFile(sourcePath, 'utf8'), /0\.157\.3/);
  assert.match(await readFile(join(root, 'docs', 'plans', 'codex-compatibility-0.158.0.md'), 'utf8'), /不得扩大/);
});

test('weekly Codex workflow uses Node 24 and never invokes a paid model or auto-creates an Issue', async () => {
  const workflow = await readFile(resolve('.github/workflows/codex-compatibility.yml'), 'utf8');
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /actions\/checkout@v4\s+with:\s+ref: main/);
  assert.match(workflow, /tests\/codex-adapter\.test\.mjs/);
  assert.match(workflow, /--expected-version/);
  assert.doesNotMatch(workflow, /turn\/start|gh issue create|OPENAI_API_KEY/);
});
