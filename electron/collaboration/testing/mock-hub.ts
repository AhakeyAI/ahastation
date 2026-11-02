/** In-memory DEVELOPMENT ONLY implementation. No network, persistence, authentication or execution. */
import { randomUUID } from 'node:crypto';
import { ContractError, parseContract, resultOf, streamId } from '../validation.js';
import { fingerprint } from '../events.js';
import type { CollaborationClient, LocalProjectAccessPort } from '../ports.js';
import type {
  BindingSummary, CollaborationDevice, CollaborationEvent, CollaborationProject, CollaborationSnapshot,
  DeviceConfig, LocalAuthorization, LocalProjectBinding,
} from '../types.js';

export interface SimulatedPrincipal { ownerId: string; deviceId: string }
interface Account {
  devices: Map<string, CollaborationDevice>; projects: Map<string, CollaborationProject>;
  bindings: Map<string, BindingSummary>; seq: number; events: CollaborationEvent[];
  creations: Map<string, { config: string; project: CollaborationProject }>;
  listeners: Set<(event: CollaborationEvent) => void>;
}
export function createMockCollaborationHub(options: { now?: () => number; journalLimit?: number } = {}) {
  const accounts = new Map<string, Account>();
  const now = options.now ?? Date.now;
  const limit = options.journalLimit ?? 1024;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('Invalid journal limit');
  const account = (principal: SimulatedPrincipal) => {
    // Test harness supplies a trusted principal. Production must derive it from credentials.
    for (const candidate of [principal.ownerId, principal.deviceId]) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate)) throw new ContractError('INVALID_INPUT', 'Invalid simulated principal');
    }
    let state = accounts.get(principal.ownerId);
    if (!state) {
      state = { devices: new Map(), projects: new Map(), bindings: new Map(), creations: new Map(), seq: 0, events: [], listeners: new Set() };
      accounts.set(principal.ownerId, state);
    }
    return state;
  };
  const emit = (state: Account, type: CollaborationEvent['type'], payload: any) => {
    const event = parseContract('event', {
      schemaVersion: 1, scope: 'account', type, eventId: randomUUID(),
      streamId: streamId({ type, payload }), seq: state.seq + 1,
      revision: payload.revision, occurredAt: now(), payload,
    });
    state.seq = event.seq; state.events.push(event);
    if (state.events.length > limit) state.events.shift();
    for (const listener of [...state.listeners]) {
      // A broken UI subscriber must not roll back an accepted write.
      try { listener(structuredClone(event)); } catch { /* isolated subscriber */ }
    }
  };
  const self = (state: Account, deviceId: string) => {
    const device = state.devices.get(deviceId);
    if (!device) throw new ContractError('NOT_FOUND', 'Register this device first');
    return device;
  };
  const revision = (actual: number, expected: number) => {
    if (!Number.isSafeInteger(expected) || expected < 1) throw new ContractError('INVALID_INPUT', 'Invalid expected revision');
    if (actual !== expected) throw new ContractError('REVISION_CONFLICT', 'Refresh before updating');
  };
  const forPrincipal = (input: SimulatedPrincipal): CollaborationClient => {
    const principal = { ...input }; const state = account(principal);
    return {
      registerSelf: config => resultOf(() => {
        const clean = parseContract('deviceConfig', config);
        const existing = state.devices.get(principal.deviceId);
        if (existing) {
          const oldConfig = Object.fromEntries(Object.keys(clean).map(key => [key, (existing as any)[key]]));
          if (fingerprint(oldConfig) !== fingerprint(clean)) throw new ContractError('REVISION_CONFLICT', 'Device exists; use updateSelf');
          return structuredClone(existing);
        }
        const device = parseContract('device', {
          ...clean, schemaVersion: 1, deviceId: principal.deviceId, online: false,
          lastSeenAt: now(), connectionGeneration: 0, activeTasks: 0, revision: 1,
        });
        state.devices.set(device.deviceId, device); emit(state, 'device.changed', device);
        return structuredClone(device);
      }),
      updateSelf: (config: DeviceConfig, expected) => resultOf(() => {
        const clean = parseContract('deviceConfig', config);
        const old = self(state, principal.deviceId); revision(old.revision, expected);
        const device = parseContract('device', { ...old, ...clean, revision: old.revision + 1 });
        state.devices.set(device.deviceId, device); emit(state, 'device.changed', device);
        return structuredClone(device);
      }),
      listDevices: () => resultOf(() => structuredClone([...state.devices.values()])),
      createProject: (config, requestId) => resultOf(() => {
        if (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestId)) {
          throw new ContractError('INVALID_INPUT', 'Project creation requires a stable request ID');
        }
        const clean = parseContract('projectConfig', config);
        const prior = state.creations.get(requestId);
        if (prior) {
          if (prior.config !== fingerprint(clean)) throw new ContractError('REVISION_CONFLICT', 'Creation request ID reused with different content');
          return structuredClone(prior.project);
        }
        const project = parseContract('project', { ...clean, schemaVersion: 1, projectId: randomUUID(), revision: 1 });
        state.creations.set(requestId, { config: fingerprint(clean), project: structuredClone(project) });
        state.projects.set(project.projectId, project); emit(state, 'project.changed', project);
        return structuredClone(project);
      }),
      updateProject: (id, config, expected) => resultOf(() => {
        const clean = parseContract('projectConfig', config);
        const old = state.projects.get(id);
        if (!old) throw new ContractError('NOT_FOUND', 'Project not found in this account');
        revision(old.revision, expected);
        const project = parseContract('project', { ...clean, schemaVersion: 1, projectId: id, revision: old.revision + 1 });
        state.projects.set(id, project); emit(state, 'project.changed', project);
        return structuredClone(project);
      }),
      listProjects: () => resultOf(() => structuredClone([...state.projects.values()])),
      reportBinding: report => resultOf(() => {
        const clean = parseContract('bindingReport', report);
        if (clean.deviceId !== principal.deviceId) throw new ContractError('DEVICE_SCOPE_MISMATCH', 'Cannot report another device binding');
        self(state, principal.deviceId);
        if (!state.projects.has(clean.projectId)) throw new ContractError('NOT_FOUND', 'Project not found in this account');
        const key = clean.projectId + ':' + clean.deviceId; const old = state.bindings.get(key);
        if (old && clean.bindingRevision < old.bindingRevision) throw new ContractError('REVISION_CONFLICT', 'Stale local binding version');
        if (old && clean.bindingRevision === old.bindingRevision) {
          const { revision: _, ...oldReport } = old;
          if (fingerprint(clean) !== fingerprint(oldReport)) throw new ContractError('REVISION_CONFLICT', 'Binding version reused');
          return structuredClone(old);
        }
        const binding = parseContract('bindingSummary', { ...clean, revision: (old?.revision ?? 0) + 1 });
        state.bindings.set(key, binding); emit(state, 'project.binding_changed', binding);
        return structuredClone(binding);
      }),
      getSnapshot: () => resultOf(() => parseContract('snapshot', {
        schemaVersion: 1, cursor: state.seq, devices: [...state.devices.values()],
        projects: [...state.projects.values()], bindings: [...state.bindings.values()],
      })),
      replay: after => resultOf(() => {
        if (!Number.isSafeInteger(after) || after < 0 || after > state.seq) throw new ContractError('INVALID_INPUT', 'Invalid replay cursor');
        if (state.events.length && after < state.events[0].seq - 1) throw new ContractError('SNAPSHOT_REQUIRED', 'Journal cursor expired');
        return structuredClone(state.events.filter(e => e.seq > after));
      }),
      subscribe: listener => {
        state.listeners.add(listener); return () => { state.listeners.delete(listener); };
      },
    };
  };
  return {
    forPrincipal,
    /** Trusted mock transport hooks, deliberately absent from the application client port. */
    connect: (principal: SimulatedPrincipal) => resultOf(() => {
      const state = account(principal); const old = self(state, principal.deviceId);
      const device = parseContract('device', { ...old, online: true, lastSeenAt: now(),
        connectionGeneration: old.connectionGeneration + 1, revision: old.revision + 1 });
      state.devices.set(device.deviceId, device); emit(state, 'device.changed', device);
      return device.connectionGeneration;
    }),
    disconnect: (principal: SimulatedPrincipal, generation: number) => resultOf(() => {
      const state = account(principal); const old = self(state, principal.deviceId);
      if (old.connectionGeneration !== generation || !old.online) return false;
      const device = parseContract('device', { ...old, online: false, revision: old.revision + 1 });
      state.devices.set(device.deviceId, device); emit(state, 'device.changed', device); return true;
    }),
  };
}

/** For UI/runtime consumer tests only. Never calls fs, Git or a model. */
export function createMockProjectAccess(bindingInput: LocalProjectBinding, now = Date.now): LocalProjectAccessPort {
  const binding = parseContract('localBinding', bindingInput);
  const grants = new Map<string, LocalAuthorization>();
  return {
    resolveAuthorizedWorkspace: request => resultOf(() => {
      const r = parseContract('authorizationRequest', request);
      if (!binding.confirmed || binding.projectId !== r.projectId) throw new ContractError('PROJECT_UNBOUND', 'Project is not bound');
      if (r.expectedBindingRevision !== undefined && r.expectedBindingRevision !== binding.revision) throw new ContractError('BINDING_CHANGED', 'Refresh local binding');
      if (!binding.allowedAgentIds.includes(r.agentId)) throw new ContractError('AGENT_UNAVAILABLE', 'Agent not authorized');
      if (r.requiredPermission === 'workspace-write' && binding.permissionCeiling === 'read-only') throw new ContractError('PERMISSION_EXCEEDED', 'Permission exceeds local grant');
      const grant = parseContract('authorization', {
        schemaVersion: 1, assurance: 'simulation', authorizationRef: randomUUID(), projectId: r.projectId,
        deviceId: binding.deviceId, taskId: r.taskId, attemptId: r.attemptId, agentId: r.agentId,
        executionMode: r.executionMode, baseCommit: r.baseCommit, permission: r.requiredPermission,
        repoRoot: binding.localRepoRoot, taskWorkspaceRoot: binding.taskWorkspaceRoot,
        bindingRevision: binding.revision, expiresAt: now() + 60000,
      });
      grants.set(grant.authorizationRef, grant); return structuredClone(grant);
    }),
    validateWorkspaceForExecution: request => resultOf(() => {
      const r = parseContract('workspaceRequest', request); const grant = grants.get(r.authorizationRef);
      if (!grant) throw new ContractError('AUTHORIZATION_NOT_FOUND', 'Unknown simulated authorization');
      if (now() >= grant.expiresAt) throw new ContractError('AUTHORIZATION_EXPIRED', 'Authorization expired');
      if (r.taskId !== grant.taskId || r.attemptId !== grant.attemptId || r.baseCommit !== grant.baseCommit) throw new ContractError('TASK_MISMATCH', 'Task authorization mismatch');
      if (r.bindingRevision !== grant.bindingRevision) throw new ContractError('BINDING_CHANGED', 'Binding changed');
      if (r.effectiveAgentPermission !== grant.permission) throw new ContractError('PERMISSION_EXCEEDED', 'Agent permission differs from task grant');
      return parseContract('workspace', {
        schemaVersion: 1, assurance: 'simulation', authorizationRef: grant.authorizationRef,
        projectId: grant.projectId, deviceId: grant.deviceId, taskId: grant.taskId, attemptId: grant.attemptId,
        agentId: grant.agentId, baseCommit: grant.baseCommit, cwd: r.workspacePath,
        permission: grant.permission, bindingRevision: grant.bindingRevision, expiresAt: grant.expiresAt,
      });
    }),
  };
}
