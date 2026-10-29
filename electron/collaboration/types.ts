/** Collaboration v1. Runtime source of truth: contracts/collaboration/v1.schema.json. */
export type Permission = 'read-only' | 'workspace-write';
export type ExecutionMode = 'worker' | 'native-session';
export interface AgentCapability {
  agentId: string; backendId: string; available: boolean;
  executionModes: ExecutionMode[]; unavailableReason?: string;
}
export interface DeviceConfig {
  name: string; platform: 'windows' | 'linux' | 'macos';
  acceptingTasks: boolean; maxConcurrency: number; agents: AgentCapability[];
}
export interface CollaborationDevice extends DeviceConfig {
  schemaVersion: 1; deviceId: string; online: boolean; lastSeenAt: number;
  connectionGeneration: number; activeTasks: number; revision: number;
}
export interface RepositoryIdentity {
  provider: 'github'; canonicalUrl: string; repositoryId?: string;
}
export interface ProjectConfig {
  name: string; repository: RepositoryIdentity; repoSubdirectory?: string;
}
export interface CollaborationProject extends ProjectConfig {
  schemaVersion: 1; projectId: string; revision: number;
}
/** Main-process only. Never send this object to the Hub or renderer. */
export interface LocalProjectBinding {
  schemaVersion: 1; projectId: string; deviceId: string;
  localRepoRoot: string; taskWorkspaceRoot: string; permissionCeiling: Permission;
  allowedAgentIds: string[]; confirmed: boolean; revision: number;
}
export interface BindingReport {
  schemaVersion: 1; projectId: string; deviceId: string;
  state: 'ready' | 'unbound' | 'invalid'; bindingRevision: number;
  reasonCode?: 'NOT_BOUND' | 'REVOKED' | 'REPOSITORY_MISMATCH' | 'PATH_NOT_AUTHORIZED' | 'AGENT_UNAVAILABLE';
}
export interface BindingSummary extends BindingReport { revision: number }
export interface AuthorizationRequest {
  projectId: string; taskId: string; attemptId: string; agentId: string;
  baseCommit: string; requiredPermission: Permission; executionMode: ExecutionMode;
  expectedBindingRevision?: number;
}
export interface LocalAuthorization {
  schemaVersion: 1; assurance: 'local-verified' | 'simulation'; authorizationRef: string;
  projectId: string; deviceId: string; taskId: string; attemptId: string; agentId: string;
  baseCommit: string; executionMode: ExecutionMode; permission: Permission;
  repoRoot: string; taskWorkspaceRoot: string; bindingRevision: number; expiresAt: number;
}
export interface WorkspaceValidationRequest {
  authorizationRef: string; taskId: string; attemptId: string; workspacePath: string;
  baseCommit: string; bindingRevision: number; effectiveAgentPermission: Permission;
}
export interface ExecutableWorkspace {
  schemaVersion: 1; assurance: 'local-verified' | 'simulation'; authorizationRef: string;
  projectId: string; deviceId: string; taskId: string; attemptId: string; agentId: string;
  baseCommit: string; cwd: string; permission: Permission; bindingRevision: number; expiresAt: number;
}
interface EventEnvelope {
  schemaVersion: 1; scope: 'account'; eventId: string; streamId: string;
  seq: number; revision: number; occurredAt: number;
}
export type CollaborationEvent = EventEnvelope & (
  | { type: 'device.changed'; payload: CollaborationDevice }
  | { type: 'project.changed'; payload: CollaborationProject }
  | { type: 'project.binding_changed'; payload: BindingSummary }
);
export interface LocalAuthorizationEvent {
  schemaVersion: 1; scope: 'local'; type: 'project.authorization_changed';
  projectId: string; deviceId: string; bindingRevision: number; occurredAt: number;
}
export interface CollaborationSnapshot {
  schemaVersion: 1; cursor: number; devices: CollaborationDevice[];
  projects: CollaborationProject[]; bindings: BindingSummary[];
}
export interface ContractTypes {
  deviceConfig: DeviceConfig; device: CollaborationDevice;
  projectConfig: ProjectConfig; project: CollaborationProject;
  localBinding: LocalProjectBinding; bindingReport: BindingReport; bindingSummary: BindingSummary;
  authorizationRequest: AuthorizationRequest; authorization: LocalAuthorization;
  workspaceRequest: WorkspaceValidationRequest; workspace: ExecutableWorkspace;
  event: CollaborationEvent; localAuthorizationEvent: LocalAuthorizationEvent; snapshot: CollaborationSnapshot;
}
export type ErrorCode =
  | 'INVALID_INPUT' | 'NOT_FOUND' | 'DEVICE_SCOPE_MISMATCH' | 'REVISION_CONFLICT'
  | 'PROJECT_UNBOUND' | 'REPOSITORY_MISMATCH' | 'PATH_NOT_AUTHORIZED'
  | 'PERMISSION_EXCEEDED' | 'BASE_COMMIT_UNAVAILABLE' | 'BINDING_CHANGED'
  | 'AGENT_UNAVAILABLE' | 'AUTHORIZATION_NOT_FOUND' | 'AUTHORIZATION_EXPIRED'
  | 'TASK_MISMATCH' | 'SNAPSHOT_REQUIRED' | 'EVENT_CONFLICT' | 'SIMULATION_ONLY';
export interface CollaborationError { code: ErrorCode; message: string; retryable: boolean }
export type Result<T> = { ok: true; value: T } | { ok: false; error: CollaborationError };
