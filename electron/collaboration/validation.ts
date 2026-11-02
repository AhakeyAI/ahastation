import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ContractTypes, ErrorCode, Result } from './types.js';

export class ContractError extends Error {
  constructor(public readonly code: ErrorCode, message: string) { super(message); this.name = 'ContractError'; }
}
export const failure = (error: unknown): Result<never> => ({
  ok: false, error: {
    code: error instanceof ContractError ? error.code : 'INVALID_INPUT',
    // Do not forward raw Git/fs/validator errors: they may contain paths or input values.
    message: error instanceof ContractError ? error.message : 'Collaboration operation failed',
    retryable: error instanceof ContractError && ['REVISION_CONFLICT', 'SNAPSHOT_REQUIRED', 'BINDING_CHANGED'].includes(error.code),
  },
});
export async function resultOf<T>(operation: () => T | Promise<T>): Promise<Result<T>> {
  try { return { ok: true, value: await operation() }; } catch (error) { return failure(error); }
}
const schema = JSON.parse(readFileSync(new URL('../../contracts/collaboration/v1.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false });
ajv.addSchema(schema);
const names: Array<keyof ContractTypes> = [
  'deviceConfig', 'device', 'projectConfig', 'project', 'localBinding', 'bindingReport', 'bindingSummary',
  'authorizationRequest', 'authorization', 'workspaceRequest', 'workspace', 'event', 'localAuthorizationEvent', 'snapshot',
];
const validators = Object.fromEntries(names.map(name => [name, ajv.compile({ $ref: schema.$id + '#/$defs/' + name })]));

/** Reject non-JSON values and bound work before invoking schema validation. No normalization/coercion. */
export function checkJson(value: unknown, depth = 0, count = { value: 0 }, seen = new Set<object>()): void {
  if (++count.value > 20000 || depth > 24) throw new ContractError('INVALID_INPUT', 'JSON complexity limit exceeded');
  if (typeof value === 'string') {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
      throw new ContractError('INVALID_INPUT', 'Expected valid Unicode string');
    }
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw new ContractError('INVALID_INPUT', 'Expected plain JSON');
  if (seen.has(value)) throw new ContractError('INVALID_INPUT', 'Cyclic JSON');
  seen.add(value);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new ContractError('INVALID_INPUT', 'Expected plain JSON object');
  }
  if (Object.getOwnPropertySymbols(value).length || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => d.get || d.set)) {
    throw new ContractError('INVALID_INPUT', 'Expected data properties');
  }
  for (const child of Object.values(value)) checkJson(child, depth + 1, count, seen);
  seen.delete(value);
}
const unique = (values: string[]) => new Set(values).size === values.length;
function semantic(name: keyof ContractTypes, value: any): void {
  const bad = () => { throw new ContractError('INVALID_INPUT', 'Contract semantic constraint failed'); };
  if ((name === 'deviceConfig' || name === 'device') && !unique(value.agents.map((a: any) => a.agentId))) bad();
  if (name === 'projectConfig' || name === 'project') {
    const url = value.repository.canonicalUrl as string;
    if (url.endsWith('.git') || url.split('/').slice(-2).some(p => p === '.' || p === '..')) bad();
  }
  if (name === 'bindingReport' || name === 'bindingSummary') {
    if (value.state === 'ready' && (value.bindingRevision < 1 || value.reasonCode !== undefined)) bad();
    if (value.state !== 'ready' && value.reasonCode === undefined) bad();
  }
  if (name === 'event') {
    const p = value.payload;
    const kind = value.type === 'device.changed' ? 'device' : value.type === 'project.changed' ? 'project' : 'bindingSummary';
    semantic(kind, p);
    if (value.revision !== p.revision || value.streamId !== streamId(value)) bad();
  }
  if (name === 'snapshot') {
    for (const [kind, records, key] of [
      ['device', value.devices, (v: any) => v.deviceId],
      ['project', value.projects, (v: any) => v.projectId],
      ['bindingSummary', value.bindings, (v: any) => v.projectId + ':' + v.deviceId],
    ] as const) {
      if (!unique(records.map(key))) bad();
      for (const record of records) semantic(kind, record);
    }
    const devices = new Set(value.devices.map((d: any) => d.deviceId));
    const projects = new Set(value.projects.map((p: any) => p.projectId));
    if (value.bindings.some((b: any) => !devices.has(b.deviceId) || !projects.has(b.projectId))) bad();
  }
}
export function streamId(event: Pick<ContractTypes['event'], 'type' | 'payload'>): string {
  const p: any = event.payload;
  return event.type === 'device.changed' ? 'device:' + p.deviceId
    : event.type === 'project.changed' ? 'project:' + p.projectId : 'binding:' + p.projectId + ':' + p.deviceId;
}
export function parseContract<K extends keyof ContractTypes>(name: K, input: unknown): ContractTypes[K] {
  checkJson(input);
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 262144) throw new ContractError('INVALID_INPUT', 'JSON byte limit exceeded');
  if (!validators[name]?.(input)) throw new ContractError('INVALID_INPUT', 'Invalid ' + name + ' contract');
  semantic(name, input);
  // Defensive copy: consumers cannot change producer state by mutating a returned object.
  return structuredClone(input) as ContractTypes[K];
}
export function validateContract<K extends keyof ContractTypes>(name: K, input: unknown): Result<ContractTypes[K]> {
  try { return { ok: true, value: parseContract(name, input) }; } catch (error) { return failure(error); }
}
