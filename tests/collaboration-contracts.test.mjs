import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateContract, parseContract } from '../dist-electron/collaboration/validation.js';
import { normalizeGithubRepository } from '../dist-electron/collaboration/repository-identity.js';

const cases = JSON.parse(readFileSync(new URL('../contracts/collaboration/validation-cases.json', import.meta.url)));
for (const entry of cases) {
  test('collaboration schema: ' + entry.name, () => {
    assert.equal(validateContract(entry.contract, entry.value).ok, entry.valid);
  });
}
test('collaboration validators never coerce, mutate, alias or disclose invalid values', () => {
  const entry = cases.find(c => c.contract === 'deviceConfig' && c.valid);
  const value = structuredClone(entry.value);
  const result = parseContract('deviceConfig', value);
  result.agents[0].available = false;
  assert.equal(value.agents[0].available, true);
  assert.equal(validateContract('deviceConfig', { ...value, password: 'test-private-value' }).ok, false);
  assert.ok(!JSON.stringify(validateContract('deviceConfig', { ...value, password: 'test-private-value' })).includes('test-private-value'));
  for (const bad of [NaN, Infinity, undefined, new Date(), () => {}, { x: 1n }]) {
    assert.equal(validateContract('deviceConfig', bad).ok, false);
  }
  const cycle = {}; cycle.self = cycle;
  assert.equal(validateContract('snapshot', cycle).ok, false);
  const accessor = Object.defineProperty({}, 'x', { enumerable: true, get() { throw new Error('must not evaluate'); } });
  assert.equal(validateContract('snapshot', accessor).ok, false);
  assert.equal(validateContract('snapshot', 'a'.repeat(262145)).ok, false);
});
test('collaboration GitHub identity accepts transport forms and rejects ambiguous identities', () => {
  for (const url of ['https://github.com/Owner/Repo.git', 'git@github.com:Owner/Repo.git', 'ssh://git@github.com/OWNER/REPO/']) {
    assert.equal(normalizeGithubRepository(url).canonicalUrl, 'https://github.com/owner/repo');
  }
  assert.equal(normalizeGithubRepository('git@github.com:Owner/.github.git').canonicalUrl, 'https://github.com/owner/.github');
  for (const url of ['https://token@github.com/a/b', 'https://github.com:443/a/b', 'https://github.com/a/b?token=x',
    'https://github.com/a/b/tree/main', 'https://github.com/a/%2e%2e', 'file:///tmp/repo', 'https://evil.test/a/b']) {
    assert.throws(() => normalizeGithubRepository(url));
  }
});
test('collaboration Python and TypeScript agree on every shared case', {
  skip: !process.env.COLLABORATION_PYTHON && 'Run npm run test:collaboration for mandatory cross-language verification',
}, () => {
  const stdout = execFileSync(process.env.COLLABORATION_PYTHON, [
    '-m', 'collaboration_contracts.validation', '--cases',
    fileURLToPath(new URL('../contracts/collaboration/validation-cases.json', import.meta.url)),
  ], { cwd: new URL('../services/remote/', import.meta.url), encoding: 'utf8', timeout: 30000 });
  const python = JSON.parse(stdout);
  assert.deepEqual(python, cases.map(entry => ({ name: entry.name, ok: validateContract(entry.contract, entry.value).ok })));
});
