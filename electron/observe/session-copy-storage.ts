// Profile-local preparation lifecycle. Never follows links or recursively deletes.
import { constants, promises as fs, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export const SESSION_COPY_LIMITS = Object.freeze({ count: 20, bytes: 512 * 1024 * 1024 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_NODES = 16;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const active = new Set<string>();
export class SessionCopyStorageError extends Error {
  constructor(readonly code: 'busy' | 'storage-full' | 'storage-unavailable' | 'preparation-changed' | 'invalid-preparation') {
    super(code); this.name = 'SessionCopyStorageError';
  }
}
function fail(code: SessionCopyStorageError['code']): never { throw new SessionCopyStorageError(code); }
const auditSchema = z.object({ schemaVersion: z.literal(1), state: z.literal('prepared'),
  preparationId: z.string().regex(UUID), clientKind: z.enum(['claude-code', 'codex']),
  sourceObservedId: z.string().regex(/^[a-f0-9]{40}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().positive().max(MAX_FILE_BYTES), createdAt: z.iso.datetime(),
}).strict();

export interface SessionCopySummary {
  preparationId: string;
  state: 'prepared' | 'incomplete' | 'unavailable';
  clientKind?: 'claude-code' | 'codex';
  createdAt?: string;
  storedBytes: number;
  /** Identity/metadata receipt, not a content-integrity or execution credential. */
  revision?: string;
}
export interface SessionCopyInventory {
  entries: SessionCopySummary[];
  storedBytes: number;
  blocked: boolean;
  limits: { count: number; bytes: number };
}
type Node = { path: string; name: string; stat: Stats };
type Tree = { entries: Node[]; ancestors: Node[]; bytes: number; revision: string };
function identity(a: Stats, b: Stats) { return a.dev === b.dev && a.ino === b.ino; }
function unchanged(a: Stats, b: Stats) {
  return identity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
async function checked(path: string, directory: boolean): Promise<Stats> {
  const stat = await fs.lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    || await fs.realpath(path) !== path) fail('storage-unavailable');
  return stat;
}
function allowed(name: string, directory: boolean) {
  if (directory) return ['native-home', 'native-home/sessions', 'native-home/projects', 'native-home/projects/source'].includes(name);
  return name === 'manifest.json' || name === 'backup.jsonl'
    || /^native-home\/sessions\/rollout-[a-f0-9-]{36}\.jsonl$/i.test(name)
    || /^native-home\/projects\/source\/[a-f0-9-]{36}\.jsonl$/i.test(name);
}

/** All profile preparation consumers must share this gate, including a future
 * native importer. This is a main-process gate, not a cross-process file lock. */
export async function withSessionCopyStorage<T>(userData: string, operation: () => Promise<T>): Promise<T> {
  let key: string;
  try { key = await fs.realpath(resolve(userData)); } catch { fail('storage-unavailable'); }
  if (process.platform === 'win32') key = key.toLowerCase();
  if (active.has(key)) fail('busy');
  active.add(key);
  try { return await operation(); }
  finally { active.delete(key); }
}

export class SessionCopyStorage {
  constructor(private readonly userData: string) {}

  list(): Promise<SessionCopyInventory> {
    return this.run(() => this.inventory());
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await withSessionCopyStorage(this.userData, operation); }
    catch (error) { if (error instanceof SessionCopyStorageError) throw error; fail('storage-unavailable'); }
  }

  /** Called inside the preparation gate before creating any backup files. No
   * old backup is evicted automatically, including incomplete preparations. */
  async assertCapacity(bytes: number): Promise<void> {
    const inventory = await this.inventory();
    if (inventory.blocked) fail('storage-unavailable');
    if (!Number.isSafeInteger(bytes) || bytes < 1 || inventory.entries.length >= SESSION_COPY_LIMITS.count
      || inventory.storedBytes + bytes > SESSION_COPY_LIMITS.bytes) fail('storage-full');
  }

  async discard(preparationId: string, revision: string): Promise<void> {
    if (!UUID.test(preparationId) || !/^[a-f0-9]{64}$/.test(revision)) fail('invalid-preparation');
    return this.run(async () => {
      const ancestors = await this.ancestors();
      if (!ancestors) fail('preparation-changed');
      const tree = await this.tree(ancestors, preparationId);
      if (tree.revision !== revision) fail('preparation-changed');
      // Check the whole plan before the first destructive action. Recheck all
      // parent identities and each file again before its individual unlink.
      await this.recheck(tree, true);
      const files = tree.entries.filter(node => node.stat.isFile());
      // Preserve the audit until both private history files have been removed.
      const rank = (node: Node) => node.name === 'manifest.json' ? 2 : node.name === 'backup.jsonl' ? 1 : 0;
      files.sort((a, b) => rank(a) - rank(b));
      for (const file of files) {
        await this.recheck(tree, false);
        if (!unchanged(file.stat, await checked(file.path, false))) fail('preparation-changed');
        await fs.unlink(file.path);
      }
      for (const dir of tree.entries.filter(node => node.stat.isDirectory()).reverse()) {
        await this.recheck(tree, false);
        await fs.rmdir(dir.path);
        // Removed directories no longer take part in subsequent checks.
        tree.ancestors = tree.ancestors.filter(node => node.path !== dir.path);
      }
    });
  }

  private async ancestors(): Promise<Node[] | null> {
    const root = await fs.realpath(resolve(this.userData));
    const nodes: Node[] = [{ path: root, name: '', stat: await checked(root, true) }];
    let path = root;
    for (const name of ['sessions', 'adoption-preparations']) {
      path = join(path, name);
      try { nodes.push({ path, name, stat: await checked(path, true) }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    }
    return nodes;
  }

  private async tree(ancestors: Node[], id: string): Promise<Tree> {
    const path = join(ancestors.at(-1)!.path, id);
    const entries: Node[] = [{ path, name: '', stat: await checked(path, true) }];
    let bytes = 0;
    const walk = async (dir: string, prefix: string) => {
      const handle = await fs.opendir(dir);
      try {
        for await (const item of handle) {
          if (entries.length >= MAX_NODES) fail('storage-unavailable');
          const name = prefix ? `${prefix}/${item.name}` : item.name;
          if (!allowed(name, item.isDirectory())) fail('storage-unavailable');
          const child = join(dir, item.name), stat = await checked(child, item.isDirectory());
          if (stat.isFile() && stat.size > (name === 'manifest.json' ? 8192 : MAX_FILE_BYTES)) fail('storage-unavailable');
          entries.push({ path: child, name, stat });
          if (stat.isDirectory()) await walk(child, name); else bytes += stat.size;
        }
      } finally { await handle.close().catch(() => {}); }
    };
    await walk(path, '');
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const dirs = [...ancestors, ...entries.filter(node => node.stat.isDirectory())];
    const tree = { entries, ancestors: dirs, bytes, revision: '' };
    await this.recheck(tree, true);
    tree.revision = createHash('sha256').update(JSON.stringify([...ancestors, ...entries].map(node => [
      node.name, node.stat.dev, node.stat.ino, node.stat.size, node.stat.mtimeMs, node.stat.ctimeMs,
    ]))).digest('hex');
    return tree;
  }

  private async recheck(tree: Tree, all: boolean) {
    for (const node of all ? [...tree.ancestors, ...tree.entries] : tree.ancestors) {
      const stat = await checked(node.path, node.stat.isDirectory());
      if (!(all ? unchanged(node.stat, stat) : identity(node.stat, stat))) fail('preparation-changed');
    }
  }

  private async summary(id: string, tree: Tree): Promise<SessionCopySummary> {
    const base: SessionCopySummary = { preparationId: id, state: 'incomplete', storedBytes: tree.bytes, revision: tree.revision };
    const manifest = tree.entries.find(node => node.name === 'manifest.json');
    if (!manifest) return base;
    const handle = await fs.open(manifest.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!unchanged(manifest.stat, await handle.stat())) fail('preparation-changed');
      // Bound the read even if another writer appends after lstat.
      const buffer = Buffer.alloc(8193);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 8192) fail('storage-unavailable');
      let doc;
      try { doc = auditSchema.safeParse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))); }
      catch { return base; }
      await this.recheck(tree, true);
      if (!doc.success || doc.data.preparationId !== id) return base;
      const backup = tree.entries.find(node => node.name === 'backup.jsonl');
      const copies = tree.entries.filter(node => node.stat.isFile() && node.name.startsWith('native-home/'));
      const expectedPrefix = doc.data.clientKind === 'codex' ? 'native-home/sessions/' : 'native-home/projects/source/';
      if (!backup || backup.stat.size !== doc.data.byteLength || copies.length !== 1
        || !copies[0].name.startsWith(expectedPrefix) || copies[0].stat.size !== doc.data.byteLength) return base;
      // 'prepared' is a manifest/shape classification, not fresh hash verification.
      return { ...base, state: 'prepared', clientKind: doc.data.clientKind, createdAt: doc.data.createdAt };
    } finally { await handle.close(); }
  }

  private async inventory(): Promise<SessionCopyInventory> {
    const result: SessionCopyInventory = { entries: [], storedBytes: 0, blocked: false, limits: { ...SESSION_COPY_LIMITS } };
    const ancestors = await this.ancestors();
    if (!ancestors) return result;
    const handle = await fs.opendir(ancestors.at(-1)!.path);
    let visited = 0;
    try {
      for await (const entry of handle) {
        if (++visited > 100) fail('storage-unavailable');
        if (!UUID.test(entry.name)) { result.blocked = true; continue; }
        try {
          const tree = await this.tree(ancestors, entry.name);
          result.entries.push(await this.summary(entry.name, tree)); result.storedBytes += tree.bytes;
        } catch {
          result.entries.push({ preparationId: entry.name, state: 'unavailable', storedBytes: 0 }); result.blocked = true;
        }
      }
    } finally { await handle.close().catch(() => {}); }
    return result;
  }
}
