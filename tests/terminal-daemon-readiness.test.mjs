import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('published daemon discovery immediately accepts authenticated clients with persisted metadata', {
  timeout: 20_000,
}, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aha-daemon-readiness-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await promisify(execFile)(process.execPath, [resolve('tests/fixtures/terminal-daemon-readiness.mjs'), dataDir], {
    windowsHide: true, timeout: 15_000,
  });
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'result.json'), 'utf8')), { discoveryReady: true });
});
