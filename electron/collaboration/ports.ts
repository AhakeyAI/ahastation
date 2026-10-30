import type {
  AuthorizationRequest, BindingReport, BindingSummary, CollaborationDevice, CollaborationEvent,
  CollaborationProject, CollaborationSnapshot, DeviceConfig, ExecutableWorkspace, LocalAuthorization,
  LocalAuthorizationEvent, ProjectConfig, Result, WorkspaceValidationRequest,
} from './types.js';

/** Scope comes from authenticated context, never ownerId/deviceId supplied by a remote command. */
export interface DeviceDirectory {
  registerSelf(config: DeviceConfig): Promise<Result<CollaborationDevice>>;
  updateSelf(config: DeviceConfig, expectedRevision: number): Promise<Result<CollaborationDevice>>;
  listDevices(): Promise<Result<CollaborationDevice[]>>;
}
export interface ProjectDirectory {
  createProject(config: ProjectConfig, requestId: string): Promise<Result<CollaborationProject>>;
  updateProject(projectId: string, config: ProjectConfig, expectedRevision: number): Promise<Result<CollaborationProject>>;
  listProjects(): Promise<Result<CollaborationProject[]>>;
  reportBinding(report: BindingReport): Promise<Result<BindingSummary>>;
}
/** Only the receiving machine's trusted main process implements this port. No remote cwd input. */
export interface LocalProjectAccessPort {
  resolveAuthorizedWorkspace(request: AuthorizationRequest): Promise<Result<LocalAuthorization>>;
  validateWorkspaceForExecution(request: WorkspaceValidationRequest): Promise<Result<ExecutableWorkspace>>;
}
export interface CollaborationChanges {
  getSnapshot(): Promise<Result<CollaborationSnapshot>>;
  replay(afterSeq: number): Promise<Result<CollaborationEvent[]>>;
  subscribe(listener: (event: CollaborationEvent) => void): () => void;
}
export type CollaborationClient = DeviceDirectory & ProjectDirectory & CollaborationChanges;
export type LocalAuthorizationListener = (event: LocalAuthorizationEvent) => void;
