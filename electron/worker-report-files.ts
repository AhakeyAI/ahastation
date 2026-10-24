import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { changedWorkspacePaths } from './delivery-candidate.js';
import type { TaskWorkspace } from './task-workspace.js';
import type { WorkReport } from './worker-protocol.js';

const execFileAsync = promisify(execFile);

export async function terminalReportFiles(workspace: TaskWorkspace): Promise<WorkReport['files']> {
  if (workspace.sourceRevision === 'non-git' || workspace.baseline.kind !== 'git-clean') {
    throw new Error('Automatic file collection requires a clean Git baseline; submit an explicit report through aha-worker.');
  }
  const git = async (args: string[]) => (await execFileAsync('git', args, {
    cwd: workspace.cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  })).stdout;
  if ((await git(['rev-parse', 'HEAD'])).trim() !== workspace.sourceRevision) {
    throw new Error('Task HEAD changed. Leave changes uncommitted so the coordinator can freeze and review them.');
  }
  const paths = await changedWorkspacePaths(workspace.cwd);
  const tracked = new Set((await git(['ls-tree', '-r', '--name-only', '-z', 'HEAD'])).split('\0'));
  const deleted = new Set((await git(['diff', '--name-only', '--diff-filter=D', '--no-renames', '-z', 'HEAD', '--'])).split('\0'));
  return paths.map((path) => ({ path, action: deleted.has(path) ? 'deleted' : tracked.has(path) ? 'modified' : 'created' }));
}

export async function validateTerminalReportFiles(workspace: TaskWorkspace, report: WorkReport): Promise<void> {
  // Dirty/shared and non-Git workspaces retain the existing explicit-report path checks.
  if (workspace.sourceRevision === 'non-git' || workspace.baseline.kind !== 'git-clean') return;
  const actual = await terminalReportFiles(workspace);
  const expected = new Map(actual.map((file) => [file.path, file.action]));
  const provided = new Map(report.files.map((file) => [file.path, file.action]));
  if (provided.size !== report.files.length || provided.size !== expected.size
    || [...expected].some(([path, action]) => provided.get(path) !== action)) {
    throw new Error(`Report files do not match worktree changes. Expected: ${JSON.stringify(actual)}`);
  }
}
