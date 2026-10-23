import type { DeviceConfig, LocalProjectBinding, Permission } from './types.js';
export interface SharedEntity { id: string; revision: number; [key: string]: unknown }
export interface SharedSnapshot { protocol: 2; cursor: number; entities: Record<string, SharedEntity[]>; capabilities?:string[] }
export interface SharedEvent { protocol: 2; seq: number; eventId: string; kind: string; id: string; revision: number; value: SharedEntity }
export interface SharedCommand { protocol: 2; requestId: string; action: string; payload: Record<string, unknown> }
export type HostInputStatus='preparing'|'starting'|'completed'|'failed'|'reconcile';
export interface HostInputFailure {message:string;notStarted:boolean}
export interface MessageSubmission {requestId:string;meetingId:string;text:string;status:'pending'|'accepted'|'rejected';messageId?:string;error?:string;digest?:string;command?:SharedCommand;uncertain?:boolean}
export type TurnOutcome='completed'|'interrupted'|'failed'|'unknown';
export interface ReconciliationIssue {reason:string;history:string[]}
export interface GitOperation {id:string;cwd:string;argv:string[];exitConfirmed:boolean;exitCode?:number;previous?:string[]}
export const hostInputTerminal=(status:string)=>status==='completed'||status==='failed';
export interface LocalReceipt {
  taskId: string; attemptId: string; status: 'received' | 'starting' | 'running' | 'waiting-desktop' | 'stopped' | 'reconcile' | 'executed' | 'delivery-pending' | 'delivered';
  bindingRevision: number; cwd?: string; nativeThreadId?: string; nativeTurnId?: string;
  output: string[]; exitConfirmed?: boolean; retryDelivery?: string; delivery?: Record<string, unknown>;
  finalSummary?:string;
  turnOutcome?:TurnOutcome;stopRequested?:boolean;deliveryError?:string;
  gitOperations?:Record<string,GitOperation>;
  taskSnapshot?: SharedEntity; executionInvoked?: boolean; executorPid?:number;
  nativeBaseline?:{head:string;status:string;diff:string};
  publication?:{projectId:string;cwd:string;branch:string;repository:string;commit:string;paths:string[];targetBranch:string};
  verification?:{tests:Array<{argv:string[];exitCode:number|null;output:string;source:'station-verifier'}>;unresolved:string[]};
}
export interface DirectoryGrant {
  projectId: string; root: string; workspaceRoot: string; allowedAgentIds: string[];
  permission: Permission | 'full-access'; confirmed: boolean; revision: number;
  fullAccessConfirmed?: boolean;
}
export interface StationLocalState {
  version: 2; deviceId: string; ownerId?: string; serviceUrl?: string; tokenEnc?: string;
  registrationRequestId?: string;
  registrationConfig?:DeviceConfig;credentialInvalid?:boolean;
  config: DeviceConfig; allowedAgents: string[]; bindings: Record<string, LocalProjectBinding>;
  directories: Record<string, DirectoryGrant>; receipts: Record<string, LocalReceipt>;
  outbox: SharedCommand[]; snapshot: SharedSnapshot; error?: string;
  hostMessages?: Record<string, HostInputStatus>;
  hostFailures?:Record<string,HostInputFailure>;
  // Legacy field name hostMessages stores input attempts, never a meeting lock.
  inputContexts?:Record<string,string>;
  hostPlanBases?:Record<string,{version:number;decisionVersion:number}>;
  messageSubmissions?:Record<string,MessageSubmission>;
  reconciliation?:Record<string,ReconciliationIssue>;
  gitHistory?:Record<string,Record<string,GitOperation>>;
  hostThreads?: Record<string,string>;
  projectChecks?: Record<string,string[][]>;
  meetingWorkspaces?: Record<string,string>;
  integrations?: Record<string,{commit:string;checks:string[];sourceCommit?:string;dependencies?:string}>;
  sharedFiles?: Array<{repository:string;commit:string;paths:string[]}>;
  nativeHistoryCursors?: Record<string,{checkpoint:string|null;inProgress?:string|null}>;
  stationNativeTurns?: Record<string,string[]>;
  checks?:Record<string,{projectId:string;taskId?:string;cwd:string;exitConfirmed:boolean}>;
  discussionThreads?:Record<string,string>;
  originalHostSessions?:Record<string,{protocol:string;sessionId:string;protocolVersion?:string;backendVersion?:string}>;
}
export interface StationView {
  accountKey?:string;
  messageSubmissions?:MessageSubmission[];
  reconciliation?:Record<string,ReconciliationIssue>;
  connected: boolean; deviceId: string; config: DeviceConfig; allowedAgents: string[];
  snapshot: SharedSnapshot; bindings: LocalProjectBinding[]; directories: DirectoryGrant[];
  error?: string; credentialReady: boolean; probes: Array<{ agentId: string; installed: boolean; authenticated: boolean; guide: string;executionModes?:Array<'worker'|'native-session'> }>;
  sharedFiles?: Array<{repository:string;commit:string;paths:string[]}>;
}
