import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeSync, existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { createPrivateHookFile, ensurePrivateHookDirectory } from '../global-hooks/file-security.js';
import { WorkerOwnershipService, type WorkerBinding } from './ownership.js';
import { NativeWorkerBrokerChannel } from './broker-channel.js';
import { WindowsAppContainerGuard } from './windows-guard.js';
import type { NativeRunOptions } from './run.js';

export type NativeAuthorityPorts = Pick<NativeRunOptions, 'attempt' | 'workspaceRoot' | 'getGrant' | 'isCurrentAttempt' | 'askUser' | 'persistPermissionDecision' | 'onReport'>;
/** Main-process owner of the existing Worker-subset IF-2 writer. Acquiring a
 * profile refuses any other writer/legacy schema; it never replaces Station
 * or user-adopted entries. No rebind/recovery of authority after restart.
 * Station owner integration (#83/#72) must supply its real authorization ports
 * before this service can support Station launches. Hub identity is unused.
 */
export class NativeWorkerProfileService {
  readonly hostEpoch = randomUUID();
  private ownership?: WorkerOwnershipService;
  private readonly channels = new Set<NativeWorkerBrokerChannel>();
  private closed = false;
  private isolatedAcceptance = false;
  constructor(readonly profileDirectory: string) {}
  /** Explicitly initialize a NEW isolated acceptance profile only. Normal
   * existing profiles require their owning service/migration to create IF-2. */
  initializeAcceptanceProfile(): void {
    if (this.ownership || this.closed) throw new Error('profile-service-unavailable');
    const rel = relative(realpathSync.native(tmpdir()), resolve(this.profileDirectory));
    if (!isAbsolute(this.profileDirectory) || !rel || rel.startsWith('..') || isAbsolute(rel)
      || existsSync(this.profileDirectory)) throw new Error('acceptance-profile-must-be-new-under-system-temp');
    ensurePrivateHookDirectory(this.profileDirectory);
    if (existsSync(join(this.profileDirectory, 'sessions', 'owned.json'))) throw new Error('acceptance-profile-must-be-new');
    const owner = new WorkerOwnershipService(this.profileDirectory);
    try { owner.initialize(); this.ownership = owner; this.isolatedAcceptance = true; } catch (error) { owner.close(); throw error; }
  }
  createOfflineBroker(input: { agent: 'claude' | 'codex'; workerId: string; taskId: string; attemptId: string;
    helperPath: string; helperSha256: string; ports: NativeAuthorityPorts; cliVersionProbe?: { path: string; sha256: string } }): NativeWorkerBrokerChannel {
    if (this.closed || process.platform !== 'win32') throw new Error('unsupported-native-boundary');
    // This relay's session ID is a synthetic protocol fixture, not a CLI ID.
    // Never put it into a normal profile's native session registry. A future
    // provider launcher must obtain and verify its real session ID separately.
    if (!this.isolatedAcceptance) throw new Error('offline-broker-requires-isolated-acceptance-profile');
    const grant = input.ports.getGrant();
    if (!grant || grant.taskId !== input.taskId || !input.ports.isCurrentAttempt()) throw new Error('authority-unavailable');
    if (!this.ownership) throw new Error('acceptance-owner-unavailable');
    const runtimeId = randomUUID(), credentialRef = randomUUID(), sessionId = `fixture-${randomUUID()}`;
    const binding: WorkerBinding = { agent: input.agent, origin: 'worker', runtimeId, hostEpoch: this.hostEpoch,
      workerId: input.workerId, taskId: input.taskId, attemptId: input.attemptId,
      permissionOwnerRef: grant.approvalDecisionId, credentialRef };
    const directory = join(this.profileDirectory, runtimeId); ensurePrivateHookDirectory(directory);
    const journal = join(directory, 'decisions.jsonl'); createPrivateHookFile(journal, '');
    const append = (value: unknown) => {
      const fd = openSync(journal, 'a');
      try { writeSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    };
    const guard = new WindowsAppContainerGuard({ ...input, directory, binding, sessionId,
      initialBasis: { hostEpoch: binding.hostEpoch, runtimeId, taskId: binding.taskId, attemptId: binding.attemptId,
        credentialRef, authorityEpoch: 1, controlEpoch: 1 } });
    let channel: NativeWorkerBrokerChannel;
    channel = new NativeWorkerBrokerChannel(guard, { ...input.ports, binding, ownership: this.ownership,
      persistPermissionDecision: async value => {
        // Existing scheduler repository/journal is the authority, not this log.
        await input.ports.persistPermissionDecision(value);
        append({ kind: 'permission', value });
      },
      onReport: async (report, receiptId) => {
        append({ kind: 'report-candidate', binding, attempt: input.ports.attempt, receiptId, report, evidence: channel.evidence() });
        if (!input.ports.isCurrentAttempt()) throw new Error('stale-report');
        await input.ports.onReport(report, receiptId);
        append({ kind: 'report-delivered', binding, attempt: input.ports.attempt, receiptId });
      },
      // Isolation is enforced independently; no hash-as-sandbox claim.
      checkBoundary: async () => true,
      stopTimeoutMs: 100,
    });
    this.channels.add(channel); return channel;
  }
  async stopAll(): Promise<void> {
    await Promise.all([...this.channels].map(async c => { if (await c.run.stop()) this.channels.delete(c); }));
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.stopAll();
    // Unknown trees retain the writer lease for explicit recovery.
    if (this.channels.size === 0) { this.ownership?.close(); this.ownership = undefined; }
  }
}

let mainService: NativeWorkerProfileService | undefined;
/** Installed once by the Electron main process, never by a hook/renderer. */
export function registerNativeWorkerProfileService(profile: string): NativeWorkerProfileService {
  if (mainService) throw new Error('native-profile-service-already-registered');
  return mainService = new NativeWorkerProfileService(profile);
}
export function nativeWorkerProfileService(): NativeWorkerProfileService {
  if (!mainService) throw new Error('native-profile-service-unavailable');
  return mainService;
}
