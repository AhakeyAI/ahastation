import { ContractError, parseContract, streamId } from './validation.js';
import type { CollaborationEvent, CollaborationSnapshot } from './types.js';

export function fingerprint(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(fingerprint).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + fingerprint((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
/** Account-local projection. On a gap, stop applying events and request a fresh snapshot. */
export class CollaborationProjection {
  private state: CollaborationSnapshot = { schemaVersion: 1, cursor: 0, devices: [], projects: [], bindings: [] };
  private seen = new Map<string, string>();
  loadSnapshot(input: CollaborationSnapshot): void {
    const next = parseContract('snapshot', input);
    if (next.cursor < this.state.cursor) throw new ContractError('SNAPSHOT_REQUIRED', 'Snapshot is older than current cursor');
    this.state = next; this.seen.clear();
  }
  getSnapshot(): CollaborationSnapshot { return structuredClone(this.state); }
  apply(input: CollaborationEvent): 'applied' | 'duplicate' | 'stale' {
    const event = parseContract('event', input);
    const encoded = fingerprint(event);
    const prior = this.seen.get(event.eventId);
    if (prior && prior !== encoded) throw new ContractError('EVENT_CONFLICT', 'Event ID reused with different content');
    if (prior) return 'duplicate';
    if (event.seq <= this.state.cursor) return 'stale';
    if (event.seq !== this.state.cursor + 1) throw new ContractError('SNAPSHOT_REQUIRED', 'Event sequence gap');
    const key = streamId(event);
    const records: any[] = event.type === 'device.changed' ? this.state.devices
      : event.type === 'project.changed' ? this.state.projects : this.state.bindings;
    const index = records.findIndex(payload => streamId({ type: event.type, payload }) === key);
    if (index >= 0 && event.revision < records[index].revision) {
      throw new ContractError('EVENT_CONFLICT', 'Entity revision moved backwards');
    }
    if (index >= 0 && event.revision === records[index].revision && fingerprint(records[index]) !== fingerprint(event.payload)) {
      throw new ContractError('EVENT_CONFLICT', 'Entity revision reused with different content');
    }
    // References must already exist in the account snapshot / ordered event stream.
    if (event.type === 'project.binding_changed' && (
      !this.state.devices.some(d => d.deviceId === event.payload.deviceId) ||
      !this.state.projects.some(p => p.projectId === event.payload.projectId))) {
      throw new ContractError('SNAPSHOT_REQUIRED', 'Binding references unknown entity');
    }
    if (index < 0) records.push(event.payload); else records[index] = event.payload;
    this.state.cursor = event.seq; this.seen.set(event.eventId, encoded);
    if (this.seen.size > 1024) this.seen.delete(this.seen.keys().next().value!);
    return 'applied';
  }
}
