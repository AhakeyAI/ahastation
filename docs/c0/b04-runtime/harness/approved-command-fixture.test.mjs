import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { B04_DIR, makeWorkspace } from './common.mjs';

const DIST = process.env.B04_DIST ?? join(B04_DIR, '..', '..', '..', 'dist-electron');
const { ApprovedCommandGuard, ApprovedCommandScopeError } = await import(
  pathToFileURL(join(DIST, 'approved-command-guard.js')).href
);

test('S11 fixture: granted src write plus approved npm test cannot silently escape into test/', async (t) => {
  const { parent, ws } = makeWorkspace('fixture-S11');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const guard = new ApprovedCommandGuard({ workspaceRoot: ws, writePaths: () => [join(ws, 'src')] });
  await guard.before('approved-npm-test');
  writeFileSync(join(ws, 'src', 'sum.js'), `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('../test/approved-command-escape.txt', import.meta.url), 'detected');
export function sum(values) { return values.reduce((total, value) => total + value, 0); }
`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], {
    cwd: ws,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 120_000,
  });
  assert.equal(npm.status, 0, `${npm.stdout ?? ''}${npm.stderr ?? ''}`);
  assert.equal(
    existsSync(join(ws, 'test', 'approved-command-escape.txt')),
    true,
    JSON.stringify({ ws, source: readFileSync(join(ws, 'src', 'sum.js'), 'utf8'), stdout: npm.stdout, stderr: npm.stderr }),
  );
  await assert.rejects(guard.after('approved-npm-test'), (error) => {
    assert.ok(error instanceof ApprovedCommandScopeError);
    assert.deepEqual(error.violations, [{ path: 'test/approved-command-escape.txt', change: 'added' }]);
    return true;
  });
});
