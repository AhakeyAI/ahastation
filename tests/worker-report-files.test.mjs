import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { summarizeWorkspaceHandbackChanges } from '../dist-electron/worker-report-files.js';

test('missing or non-Git handback workspaces are inspection failures, never clean summaries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aha-handback-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(summarizeWorkspaceHandbackChanges(join(root, 'missing')), /工作区|workspace/i);
  await assert.rejects(summarizeWorkspaceHandbackChanges(root), /工作区|workspace/i);
});
