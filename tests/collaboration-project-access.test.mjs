import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LocalProjectAccess, assertExecutableWorkspace } from '../dist-electron/collaboration/local-project-access.js';

const unwrap = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const rejects = (result, code) => { assert.equal(result.ok, false); assert.equal(result.error.code, code, JSON.stringify(result)); };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
function fixture(t, subdirectory) {
  const root = mkdtempSync(path.join(tmpdir(), 'station-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
  const repo = path.join(root, 'repo'); const workspaces = path.join(root, 'workspaces');
  mkdirSync(repo); mkdirSync(workspaces);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Contract Test'); git(repo, 'config', 'user.email', 'contracts@example.invalid');
  git(repo, 'remote', 'add', 'origin', 'git@github.com:Example/Station.git');
  if (subdirectory) mkdirSync(path.join(repo, subdirectory), { recursive: true });
  writeFileSync(path.join(repo, subdirectory ?? '', 'sample.txt'), 'contract test\n');
  git(repo, 'add', '.'); git(repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'test baseline');
  const commit = git(repo, 'rev-parse', 'HEAD');
  const project = { schemaVersion: 1, projectId: 'project', name: 'test', repository: { provider: 'github', canonicalUrl: 'https://github.com/example/station' }, revision: 1,
    ...(subdirectory ? { repoSubdirectory: subdirectory } : {}) };
  const binding = { schemaVersion: 1, projectId: 'project', deviceId: 'b', localRepoRoot: repo, taskWorkspaceRoot: workspaces,
    permissionCeiling: 'workspace-write', allowedAgentIds: ['codex'], confirmed: true, revision: 1 };
  const agent = { agentId: 'codex', backendId: 'codex', available: true, executionModes: ['worker', 'native-session'] };
  let now = 1000;
  const access = new LocalProjectAccess({ deviceId: 'b', getProject: () => project, getBinding: () => binding, getAgent: () => agent, now: () => now });
  const request = { projectId: 'project', taskId: 't', attemptId: 'a', agentId: 'codex', baseCommit: commit,
    requiredPermission: 'workspace-write', executionMode: 'worker', expectedBindingRevision: 1 };
  const prepared = grant => ({ authorizationRef: grant.authorizationRef, taskId: 't', attemptId: 'a', workspacePath: path.join(repo, subdirectory ?? ''),
    baseCommit: commit, bindingRevision: 1, effectiveAgentPermission: 'workspace-write' });
  return { root, repo, workspaces, commit, project, binding, agent, access, request, prepared, advance: () => { now += 60001; } };
}
test('collaboration local access: validates clone and prepared worktree against exact commit without mutation', async t => {
  const f = fixture(t, 'packages/app');
  const before = git(f.repo, 'status', '--porcelain');
  const grant = unwrap(await f.access.resolveAuthorizedWorkspace(f.request));
  const local = unwrap(await f.access.validateWorkspaceForExecution(f.prepared(grant)));
  assert.equal(assertExecutableWorkspace(local, 1000).assurance, 'local-verified');
  const worktree = path.join(f.workspaces, 't');
  git(f.repo, 'worktree', 'add', '--detach', worktree, f.commit);
  const result = unwrap(await f.access.validateWorkspaceForExecution({
    ...f.prepared(grant), workspacePath: path.join(worktree, 'packages/app'),
  }));
  assert.ok(result.cwd.endsWith(path.join('packages', 'app')));
  assert.equal(git(f.repo, 'status', '--porcelain'), before);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.commit);
});
test('collaboration local access: revocation and changed binding invalidate outstanding authorization', async t => {
  const f = fixture(t);
  const grant = unwrap(await f.access.resolveAuthorizedWorkspace(f.request));
  f.binding.confirmed = false;
  rejects(await f.access.validateWorkspaceForExecution(f.prepared(grant)), 'PROJECT_UNBOUND');
  f.binding.confirmed = true;
  f.binding.permissionCeiling = 'read-only';
  rejects(await f.access.validateWorkspaceForExecution(f.prepared(grant)), 'PERMISSION_EXCEEDED');
  f.binding.permissionCeiling = 'workspace-write';
  f.project.name = 'changed without bumping revision';
  rejects(await f.access.validateWorkspaceForExecution(f.prepared(grant)), 'BINDING_CHANGED');
});
test('collaboration local access: unknown grant, task mismatch, expiry and effective permission rejected', async t => {
  const f = fixture(t);
  const grant = unwrap(await f.access.resolveAuthorizedWorkspace(f.request));
  const r = f.prepared(grant);
  rejects(await f.access.validateWorkspaceForExecution({ ...r, authorizationRef: 'forged' }), 'AUTHORIZATION_NOT_FOUND');
  rejects(await f.access.validateWorkspaceForExecution({ ...r, taskId: 'other' }), 'TASK_MISMATCH');
  rejects(await f.access.validateWorkspaceForExecution({ ...r, bindingRevision: 2 }), 'BINDING_CHANGED');
  rejects(await f.access.validateWorkspaceForExecution({ ...r, effectiveAgentPermission: 'read-only' }), 'PERMISSION_EXCEEDED');
  rejects(await f.access.validateWorkspaceForExecution({ ...r, effectiveAgentPermission: 'danger-full-access' }), 'INVALID_INPUT');
  f.advance();
  rejects(await f.access.validateWorkspaceForExecution(r), 'AUTHORIZATION_EXPIRED');
});
test('collaboration local access: wrong repository, missing base and unavailable mode rejected', async t => {
  const f = fixture(t);
  rejects(await f.access.resolveAuthorizedWorkspace({ ...f.request, baseCommit: 'f'.repeat(40) }), 'BASE_COMMIT_UNAVAILABLE');
  f.agent.executionModes = ['native-session'];
  rejects(await f.access.resolveAuthorizedWorkspace(f.request), 'AGENT_UNAVAILABLE');
  f.agent.executionModes = ['worker'];
  f.binding.deviceId = 'another-machine';
  rejects(await f.access.resolveAuthorizedWorkspace(f.request), 'PROJECT_UNBOUND');
  f.binding.deviceId = 'b';
  git(f.repo, 'remote', 'set-url', 'origin', 'https://github.com/other/repository');
  rejects(await f.access.resolveAuthorizedWorkspace(f.request), 'REPOSITORY_MISMATCH');
});
test('collaboration local access: symlink/junction escape and sibling prefix fail closed', async t => {
  const f = fixture(t);
  const grant = unwrap(await f.access.resolveAuthorizedWorkspace(f.request));
  const outside = path.join(f.root, 'workspaces-evil'); mkdirSync(outside);
  const link = path.join(f.workspaces, 'escape');
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const candidate of [outside, link]) {
    rejects(await f.access.validateWorkspaceForExecution({ ...f.prepared(grant), workspacePath: candidate }), 'PATH_NOT_AUTHORIZED');
  }
});
test('collaboration local access: an unrelated clone with matching origin is not an authorized worktree', async t => {
  const f = fixture(t);
  const grant = unwrap(await f.access.resolveAuthorizedWorkspace(f.request));
  const other = path.join(f.workspaces, 'impostor');
  execFileSync('git', ['clone', '-q', f.repo, other], { windowsHide: true });
  git(other, 'remote', 'set-url', 'origin', 'git@github.com:Example/Station.git');
  rejects(await f.access.validateWorkspaceForExecution({ ...f.prepared(grant), workspacePath: other }), 'REPOSITORY_MISMATCH');
});
test('collaboration local access: worktree HEAD mismatch is not silently accepted', async t => {
  const f = fixture(t);
  const grant = unwrap(await f.access.resolveAuthorizedWorkspace(f.request));
  writeFileSync(path.join(f.repo, 'new.txt'), 'new commit');
  git(f.repo, 'add', '.'); git(f.repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'different HEAD');
  rejects(await f.access.validateWorkspaceForExecution(f.prepared(grant)), 'BASE_COMMIT_UNAVAILABLE');
});
