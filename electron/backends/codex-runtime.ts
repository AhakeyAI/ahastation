import { readFileSync } from 'node:fs';

export interface CodexRuntimeContract {
  schemaVersion: 1;
  bundled: string;
  min: string;
  maxExclusive: string;
}

function parseVersion(value: unknown): number[] | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compare(left: number[], right: number[]): number {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function validateCodexRuntimeContract(value: unknown): Readonly<CodexRuntimeContract> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Codex runtime contract');
  const contract = value as CodexRuntimeContract;
  const min = parseVersion(contract.min);
  const max = parseVersion(contract.maxExclusive);
  const bundled = parseVersion(contract.bundled);
  if (Object.keys(contract).sort().join(',') !== 'bundled,maxExclusive,min,schemaVersion'
    || contract.schemaVersion !== 1 || !min || !max || !bundled
    || compare(min, max) >= 0 || compare(bundled, min) < 0 || compare(bundled, max) >= 0) {
    throw new Error('Invalid Codex runtime contract');
  }
  return Object.freeze({ ...contract });
}

export function readCodexRuntimeContract(path: string | URL): Readonly<CodexRuntimeContract> {
  return validateCodexRuntimeContract(JSON.parse(readFileSync(path, 'utf8')));
}

// copy-preloads copies the authoritative contract into this build output.
// A missing or malformed contract disables the runtime; there is no fallback pin.
export const CODEX_RUNTIME = readCodexRuntimeContract(new URL('../runtime/codex.json', import.meta.url));

export function isSupportedCodexAppServerVersion(version: string | null): boolean {
  const parsed = parseVersion(version);
  return !!parsed && compare(parsed, parseVersion(CODEX_RUNTIME.min)!) >= 0
    && compare(parsed, parseVersion(CODEX_RUNTIME.maxExclusive)!) < 0;
}
