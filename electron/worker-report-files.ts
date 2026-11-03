import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { changedWorkspacePaths } from './delivery-candidate.js';
import type { TaskWorkspace } from './task-workspace.js';
import type { WorkReport } from './worker-protocol.js';

const execFileAsync = promisify(execFile);
const GIT_OUTPUT_LIMIT = 32 * 1024 * 1024;

export interface HandbackWorkspaceSummary {
  workspaceCwd: string;
  headRevision: string | null;
  changedFiles: Array<{ path: string; action: 'created' | 'modified' | 'deleted' }>;
  diffStat: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_OUTPUT_LIMIT,
    windowsHide: true,
  });
  return stdout.replace(/\r?\n$/u, '');
}

async function existsInHead(cwd: string, filePath: string): Promise<boolean> {
  try {
    await git(cwd, ['cat-file', '-e', `HEAD:${filePath}`]);
    return true;
  } catch {
    return false;
  }
}

async function existsInWorktree(cwd: string, filePath: string): Promise<boolean> {
  try {
    await fs.lstat(resolve(cwd, filePath));
    return true;
  } catch {
    return false;
  }
}

function normalizePath(workspaceCwd: string, rawPath: string): string {
  const rel = relative(workspaceCwd, resolve(workspaceCwd, rawPath)).split('\\').join('/');
  if (!rel || rel === '.' || rel.startsWith('../') || rel === '..') {
    throw new Error(`reported file path escapes workspace: ${rawPath}`);
  }
  return rel;
}

export async function collectWorkspaceFileChanges(
  cwdInput: string,
): Promise<Array<{ path: string; action: 'created' | 'modified' | 'deleted' }>> {
  const cwd = resolve(cwdInput);
  const paths = await changedWorkspacePaths(cwd);
  return Promise.all(paths.map(async (path) => {
    const [inHead, inWorktree] = await Promise.all([
      existsInHead(cwd, path),
      existsInWorktree(cwd, path),
    ]);
    return {
      path,
      action: !inHead ? 'created' : !inWorktree ? 'deleted' : 'modified',
    };
  }));
}

export async function terminalReportFiles(
  workspace: TaskWorkspace | null,
): Promise<WorkReport['files']> {
  if (!workspace || workspace.baseline.kind === 'non-git') return [];
  if (workspace.kind === 'read-only') {
    if (workspace.baseline.kind !== 'git-clean') return [];
    const dirty = await changedWorkspacePaths(resolve(workspace.cwd));
    if (dirty.length > 0) {
      throw new Error(`read-only workspace contains unexpected changes: ${dirty.join(', ')}`);
    }
    return [];
  }
  const cwd = resolve(workspace.cwd);
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  if (head !== workspace.sourceRevision) {
    throw new Error('terminal task created a git commit; leave changes uncommitted and report them');
  }
  const files = await collectWorkspaceFileChanges(cwd);
  if (files.length > 0 && workspace.baseline.kind !== 'git-clean') {
    throw new Error('code-changing terminal reports require a clean git worktree');
  }
  return files;
}

export async function validateTerminalReportFiles(
  workspace: TaskWorkspace | null,
  report: WorkReport,
): Promise<void> {
  if (!workspace) {
    if (report.files.length > 0) {
      throw new Error('task has no managed workspace for file-bearing report');
    }
    return;
  }
  const cwd = resolve(workspace.cwd);
  if (workspace.kind === 'read-only') {
    if (report.files.length > 0) {
      throw new Error('read-only task cannot report modified files');
    }
    if (workspace.baseline.kind === 'git-clean') {
      const dirty = await changedWorkspacePaths(cwd);
      if (dirty.length > 0) {
        throw new Error(`read-only workspace contains unexpected changes: ${dirty.join(', ')}`);
      }
    }
    return;
  }
  if (workspace.baseline.kind === 'non-git') {
    for (const file of report.files) normalizePath(cwd, file.path);
    return;
  }
  const expected = await terminalReportFiles(workspace);
  const actual = report.files
    .map((file) => ({
      path: normalizePath(cwd, file.path),
      action: file.action,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const sortedExpected = [...expected].sort((a, b) => a.path.localeCompare(b.path));
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new Error(
      `reported files do not match actual workspace changes (reported=${JSON.stringify(actual)}, actual=${JSON.stringify(sortedExpected)})`,
    );
  }
}

export async function summarizeWorkspaceHandbackChanges(
  workspaceCwd: string,
): Promise<HandbackWorkspaceSummary> {
  const cwd = resolve(workspaceCwd);
  try {
    const headRevision = await git(cwd, ['rev-parse', 'HEAD']);
    const changedFiles = await collectWorkspaceFileChanges(cwd);
    const diffStat = changedFiles.length > 0
      ? await git(cwd, ['diff', '--stat', 'HEAD', '--', ...changedFiles.map((f) => f.path)]).catch(() => '')
      : '';
    return {
      workspaceCwd: cwd,
      headRevision,
      changedFiles,
      diffStat,
    };
  } catch {
    return {
      workspaceCwd: cwd,
      headRevision: null,
      changedFiles: [],
      diffStat: '',
    };
  }
}
