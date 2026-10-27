import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ApprovedCommandGuard,
  ApprovedCommandScopeError,
} from '../dist-electron/approved-command-guard.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ahastation-command-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'test'));
  await writeFile(join(root, 'src', 'app.ts'), 'before\n');
  await writeFile(join(root, 'test', 'app.test.ts'), 'before\n');
  return root;
}

test('approved command guard permits changes inside authorized write roots', async (t) => {
  const root = await fixture(t);
  const guard = new ApprovedCommandGuard({ workspaceRoot: root, writePaths: () => [join(root, 'src')] });
  await guard.before('command-1');
  const baseline = guard.pending.get('command-1');
  assert.equal(baseline.files.has('src/app.ts'), false, JSON.stringify({
    root: baseline.root,
    authorizedRoots: baseline.authorizedRoots,
    files: [...baseline.files.keys()],
  }));
  await writeFile(join(root, 'src', 'app.ts'), 'after\n');
  await writeFile(join(root, 'src', 'new.ts'), 'new\n');
  await guard.after('command-1');
});

test('approved command guard detects added modified and deleted out-of-scope files', async (t) => {
  const root = await fixture(t);
  const guard = new ApprovedCommandGuard({ workspaceRoot: root, writePaths: () => [join(root, 'src')] });

  await guard.before('added');
  await writeFile(join(root, 'test', 'escape.ts'), 'escaped\n');
  await assert.rejects(guard.after('added'), (error) => {
    assert.ok(error instanceof ApprovedCommandScopeError);
    assert.deepEqual(error.violations, [{ path: 'test/escape.ts', change: 'added' }]);
    return true;
  });

  await guard.before('modified');
  await writeFile(join(root, 'test', 'app.test.ts'), 'changed\n');
  await assert.rejects(guard.after('modified'), /modified: test\/app.test.ts/);

  await guard.before('deleted');
  await unlink(join(root, 'test', 'app.test.ts'));
  await assert.rejects(guard.after('deleted'), /deleted: test\/app.test.ts/);
});

test('approved command guard uses the latest addendum and isolates pending commands', async (t) => {
  const root = await fixture(t);
  const extra = [];
  const guard = new ApprovedCommandGuard({ workspaceRoot: root, writePaths: () => [join(root, 'src'), ...extra] });
  await guard.before('first');
  extra.push(join(root, 'test'));
  await guard.before('second');
  await writeFile(join(root, 'test', 'allowed.ts'), 'allowed\n');
  await assert.rejects(guard.after('first'), /added: test\/allowed.ts/);
  await guard.after('second');
  assert.equal(extra.length, 1);
});

test('approved command guard does not follow symlinks outside the workspace', async (t) => {
  const root = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'ahastation-command-guard-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'outside.txt'), 'before\n');
  try {
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') {
      t.skip('creating a junction requires Windows privilege');
      return;
    }
    throw error;
  }
  const guard = new ApprovedCommandGuard({ workspaceRoot: root, writePaths: () => [join(root, 'src')] });
  await guard.before('linked');
  await writeFile(join(outside, 'outside.txt'), 'after\n');
  await guard.after('linked');
});

test('approved command guard bounds pending snapshots and rejects missing baselines', async (t) => {
  const root = await fixture(t);
  const guard = new ApprovedCommandGuard({
    workspaceRoot: root,
    writePaths: () => [],
    maxPendingCommands: 1,
  });
  await guard.before('only');
  await assert.rejects(guard.before('overflow'), /Too many approved commands/);
  guard.cancel('only');
  await assert.rejects(guard.after('only'), /No approved command baseline/);
});
