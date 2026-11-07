import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Read consent is local to this profile. It grants neither execution nor sharing. */
export interface ScanAccess {
  enabled: boolean;
  roots: string[];
}

export const NO_SCAN_ACCESS: ScanAccess = { enabled: false, roots: [] };

export function withinDirectory(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`));
}

export async function canReadProject(
  cwd: string, access: ScanAccess, realpath: (path: string) => Promise<string> = (path) => fs.realpath(path),
): Promise<boolean> {
  if (!access.enabled || !isAbsolute(cwd)) return false;
  try {
    const actual = await realpath(cwd);
    for (const root of access.roots) {
      // A mount changed to a symlink must not inherit a previous read grant.
      try {
        if (isAbsolute(root) && await realpath(root) === root && withinDirectory(root, actual)) return true;
      } catch { /* One removed grant directory does not hide other valid grants. */ }
    }
  } catch { /* Missing/unreadable projects do not inherit access. */ }
  return false;
}

export class ScanAccessStore {
  private value: ScanAccess = NO_SCAN_ACCESS;
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private reviewed = false;
  constructor(private readonly filePath: string) {}
  get revision(): number { return this.generation; }
  get needsPrompt(): boolean { return !this.reviewed; }
  get(): ScanAccess { return { enabled: this.value.enabled, roots: [...this.value.roots] }; }
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (raw.schemaVersion !== 1 || typeof raw.enabled !== 'boolean'
        || !Array.isArray(raw.roots) || raw.roots.length > 100
        || !raw.roots.every((p: unknown) => typeof p === 'string' && isAbsolute(p))) return;
      this.value = { enabled: raw.enabled, roots: [...raw.roots] };
      this.reviewed = true;
    } catch { /* Missing/corrupt consent always defaults off. */ }
  }
  set(next: ScanAccess): Promise<void> {
    const generation = ++this.generation;
    // Revoke in memory immediately, even if persistence fails.
    if (!next.enabled) this.value = NO_SCAN_ACCESS;
    const work = this.tail.catch(() => {}).then(async () => {
      if (next.enabled && generation !== this.generation) return;
      const saved = { enabled: next.enabled, roots: [...next.roots] };
      await fs.mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(tmp, JSON.stringify({ schemaVersion: 1, ...saved }), { mode: 0o600 });
        await fs.rename(tmp, this.filePath);
        if (generation === this.generation) { this.value = saved; this.reviewed = true; }
      } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
    });
    this.tail = work;
    return work;
  }
}
