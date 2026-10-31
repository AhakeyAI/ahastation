import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fingerprint } from './events.js';
import { normalizeGithubRepository } from './repository-identity.js';
import { ContractError, parseContract, resultOf } from './validation.js';
import type { LocalProjectAccessPort } from './ports.js';
import type {
  AgentCapability, AuthorizationRequest, CollaborationProject, ExecutableWorkspace,
  LocalAuthorization, LocalProjectBinding,
} from './types.js';

const execute = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execute('git', ['-C', cwd, ...args], {
    timeout: 5000, maxBuffer: 65536, windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}
const within = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
async function directory(input: string): Promise<string> {
  if (!path.isAbsolute(input)) throw new ContractError('PATH_NOT_AUTHORIZED', 'Expected absolute local directory');
  try {
    const resolved = await realpath(input);
    if (!(await stat(resolved)).isDirectory()) throw new Error('not directory');
    return resolved;
  } catch { throw new ContractError('PATH_NOT_AUTHORIZED', 'Local directory unavailable'); }
}
export interface LocalProjectAccessOptions {
  deviceId: string;
  getProject(projectId: string): CollaborationProject | undefined;
  getBinding(projectId: string): LocalProjectBinding | undefined;
  getAgent(agentId: string): AgentCapability | undefined;
  now?: () => number; grantTtlMs?: number;
}
/** Read-only filesystem/Git verifier. Does not create worktrees, fetch, execute tasks or reserve slots. */
export class LocalProjectAccess implements LocalProjectAccessPort {
  private grants = new Map<string, {
    request: AuthorizationRequest; grant: LocalAuthorization; signature: string;
    projectRoot: string; commonDirectory: string;
  }>();
  private now: () => number; private ttl: number;
  constructor(private options: LocalProjectAccessOptions) {
    this.now = options.now ?? Date.now; this.ttl = options.grantTtlMs ?? 60000;
    if (!Number.isSafeInteger(this.ttl) || this.ttl < 1 || this.ttl > 300000) throw new Error('Grant TTL must be 1..300000 ms');
  }
  private configuration(request: AuthorizationRequest) {
    const projectInput = this.options.getProject(request.projectId);
    const bindingInput = this.options.getBinding(request.projectId);
    if (!projectInput || !bindingInput) throw new ContractError('PROJECT_UNBOUND', 'Bind and confirm this project on this device');
    const project = parseContract('project', projectInput);
    const binding = parseContract('localBinding', bindingInput);
    if (project.projectId !== request.projectId || binding.projectId !== project.projectId ||
        binding.deviceId !== this.options.deviceId || !binding.confirmed) {
      throw new ContractError('PROJECT_UNBOUND', 'Local project grant unavailable');
    }
    if (request.expectedBindingRevision !== undefined && request.expectedBindingRevision !== binding.revision) {
      throw new ContractError('BINDING_CHANGED', 'Local binding version changed');
    }
    const rawAgent = this.options.getAgent(request.agentId);
    // Reuse deviceConfig validation for the agent shape, without introducing another schema.
    const agent = rawAgent && parseContract('deviceConfig', {
      name: 'local-agent-check', platform: 'windows', acceptingTasks: false, maxConcurrency: 1, agents: [rawAgent],
    }).agents[0];
    if (!agent || agent.agentId !== request.agentId || !agent.available ||
        !agent.executionModes.includes(request.executionMode) || !binding.allowedAgentIds.includes(request.agentId)) {
      throw new ContractError('AGENT_UNAVAILABLE', 'Requested Agent or execution mode is unavailable');
    }
    if (request.requiredPermission === 'workspace-write' && binding.permissionCeiling === 'read-only') {
      throw new ContractError('PERMISSION_EXCEEDED', 'Task exceeds local permission ceiling');
    }
    return { project, binding, signature: fingerprint({ project, binding, agent }) };
  }
  private async inspect(request: AuthorizationRequest) {
    const configuration = this.configuration(request);
    const { project, binding } = configuration;
    const repoRoot = await directory(binding.localRepoRoot);
    const taskWorkspaceRoot = await directory(binding.taskWorkspaceRoot);
    let top: string; let commonDirectory: string;
    try {
      top = await directory(await git(repoRoot, ['rev-parse', '--show-toplevel']));
      commonDirectory = await directory(await git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
      const origin = normalizeGithubRepository(await git(repoRoot, ['config', '--get', 'remote.origin.url']));
      if (top !== repoRoot || origin.canonicalUrl !== project.repository.canonicalUrl) throw new Error('different repository');
    } catch { throw new ContractError('REPOSITORY_MISMATCH', 'Selected clone does not match the project repository'); }
    const projectRoot = await directory(path.join(repoRoot, project.repoSubdirectory ?? ''));
    if (!within(repoRoot, projectRoot)) throw new ContractError('PATH_NOT_AUTHORIZED', 'Project subdirectory escapes local repository');
    try {
      const commit = await git(repoRoot, ['rev-parse', '--verify', request.baseCommit + '^{commit}']);
      if (commit !== request.baseCommit) throw new Error('different commit');
    } catch { throw new ContractError('BASE_COMMIT_UNAVAILABLE', 'Fetch the exact base commit locally before authorizing'); }
    if (this.configuration(request).signature !== configuration.signature) throw new ContractError('BINDING_CHANGED', 'Local configuration changed during validation');
    return { ...configuration, repoRoot, taskWorkspaceRoot, projectRoot, commonDirectory };
  }
  async resolveAuthorizedWorkspace(input: AuthorizationRequest) {
    return resultOf(async () => {
      const request = parseContract('authorizationRequest', input);
      const inspected = await this.inspect(request);
      for (const [key, value] of this.grants) if (value.grant.expiresAt <= this.now()) this.grants.delete(key);
      if (this.grants.size >= 1024) throw new ContractError('INVALID_INPUT', 'Too many outstanding local authorizations');
      const grant = parseContract('authorization', {
        schemaVersion: 1, assurance: 'local-verified', authorizationRef: randomUUID(),
        projectId: request.projectId, deviceId: this.options.deviceId, taskId: request.taskId,
        attemptId: request.attemptId, agentId: request.agentId, baseCommit: request.baseCommit,
        executionMode: request.executionMode, permission: request.requiredPermission,
        repoRoot: inspected.repoRoot, taskWorkspaceRoot: inspected.taskWorkspaceRoot,
        bindingRevision: inspected.binding.revision, expiresAt: this.now() + this.ttl,
      });
      this.grants.set(grant.authorizationRef, {
        request, grant, signature: inspected.signature, projectRoot: inspected.projectRoot,
        commonDirectory: inspected.commonDirectory,
      });
      return structuredClone(grant);
    });
  }
  async validateWorkspaceForExecution(input: import('./types.js').WorkspaceValidationRequest) {
    return resultOf(async () => {
      const request = parseContract('workspaceRequest', input);
      const saved = this.grants.get(request.authorizationRef);
      if (!saved) throw new ContractError('AUTHORIZATION_NOT_FOUND', 'Unknown local authorization');
      const { grant } = saved;
      if (this.now() >= grant.expiresAt) throw new ContractError('AUTHORIZATION_EXPIRED', 'Resolve local authorization again');
      if (request.taskId !== grant.taskId || request.attemptId !== grant.attemptId || request.baseCommit !== grant.baseCommit) {
        throw new ContractError('TASK_MISMATCH', 'Authorization belongs to another task or attempt');
      }
      if (request.bindingRevision !== grant.bindingRevision) throw new ContractError('BINDING_CHANGED', 'Binding version differs from grant');
      // Unknown/full native permissions are rejected structurally, never silently downgraded.
      if (request.effectiveAgentPermission !== grant.permission) throw new ContractError('PERMISSION_EXCEEDED', 'Effective Agent permission differs from task grant');
      const inspected = await this.inspect(saved.request);
      if (inspected.signature !== saved.signature || inspected.repoRoot !== grant.repoRoot ||
          inspected.taskWorkspaceRoot !== grant.taskWorkspaceRoot || inspected.projectRoot !== saved.projectRoot ||
          inspected.commonDirectory !== saved.commonDirectory) {
        throw new ContractError('BINDING_CHANGED', 'Local authorization changed before execution');
      }
      const cwd = await directory(request.workspacePath);
      if (!within(inspected.projectRoot, cwd) && !within(inspected.taskWorkspaceRoot, cwd)) {
        throw new ContractError('PATH_NOT_AUTHORIZED', 'Prepared workspace is outside locally authorized roots');
      }
      let preparedRoot: string; let preparedCommon: string; let head: string;
      try {
        preparedRoot = await directory(await git(cwd, ['rev-parse', '--show-toplevel']));
        preparedCommon = await directory(await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
        head = await git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
      } catch { throw new ContractError('REPOSITORY_MISMATCH', 'Prepared workspace is not a Git checkout'); }
      if (preparedCommon !== inspected.commonDirectory) throw new ContractError('REPOSITORY_MISMATCH', 'Workspace belongs to another local repository');
      const expectedCwd = await directory(path.join(preparedRoot, inspected.project.repoSubdirectory ?? ''));
      if (cwd !== expectedCwd || !within(preparedRoot, cwd)) throw new ContractError('PATH_NOT_AUTHORIZED', 'Workspace must use the configured project subdirectory');
      if (head !== grant.baseCommit) throw new ContractError('BASE_COMMIT_UNAVAILABLE', 'Prepared workspace does not have the requested base commit');
      if (this.now() >= grant.expiresAt) throw new ContractError('AUTHORIZATION_EXPIRED', 'Authorization expired during validation');
      if (this.configuration(saved.request).signature !== saved.signature) throw new ContractError('BINDING_CHANGED', 'Local configuration changed during validation');
      return parseContract('workspace', {
        schemaVersion: 1, assurance: 'local-verified', authorizationRef: grant.authorizationRef,
        projectId: grant.projectId, deviceId: grant.deviceId, taskId: grant.taskId, attemptId: grant.attemptId,
        agentId: grant.agentId, baseCommit: grant.baseCommit, cwd, permission: grant.permission,
        bindingRevision: grant.bindingRevision, expiresAt: grant.expiresAt,
      });
    });
  }
}
/** Consumer guard only; keep the port and its provenance inside the trusted main process. */
export function assertExecutableWorkspace(input: ExecutableWorkspace, now = Date.now()): ExecutableWorkspace {
  const workspace = parseContract('workspace', input);
  if (workspace.assurance !== 'local-verified') throw new ContractError('SIMULATION_ONLY', 'Simulated workspace cannot execute a real task');
  if (now >= workspace.expiresAt) throw new ContractError('AUTHORIZATION_EXPIRED', 'Workspace authorization expired');
  return workspace;
}
