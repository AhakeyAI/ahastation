// S5 preparation only: an immutable backup plus a separate native-fork input.
// No IPC, CLI launch, ownership registration or execution grant is provided here.
import { constants, promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { canReadProject, type ScanAccessStore } from './scan-access.js';
import { readOwnership, ownershipKey } from './ownership.js';
import { clientRoots, readSessionIdentity } from './session-identity.js';
import { listClaudeTranscripts } from './statefiles/claude-projects.js';
import { listCodexRollouts } from './statefiles/codex-sessions.js';
import { sha1 } from './util.js';
import type { ObservedSession, ObservedSnapshot } from './types.js';

const MAX_BYTES = 64 * 1024 * 1024;
const ID = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export type SessionCopyErrorCode = 'session-unavailable' | 'scan-access-changed' | 'ownership-changed'
  | 'source-unavailable' | 'source-ambiguous' | 'source-changed' | 'source-too-large' | 'storage-unavailable' | 'busy';
export class SessionCopyError extends Error {
  constructor(readonly code: SessionCopyErrorCode) { super(code); this.name = 'SessionCopyError'; }
}
function fail(code: SessionCopyErrorCode): never { throw new SessionCopyError(code); }

export interface PreparedSessionCopy {
  schemaVersion: 1;
  state: 'prepared';
  preparationId: string;
  clientKind: 'claude-code' | 'codex';
  sourceObservedId: string;
  sha256: string;
  byteLength: number;
  createdAt: string;
  backupPath: string;
  copyPath: string;
  /** Contains only the copied history, never the user's config/auth/hooks. */
  isolatedHome: string;
}

export interface SessionCopyOptions {
  userData: string;
  homeDir: string;
  configRoots?: { claude: string; codex: string };
  access: Pick<ScanAccessStore, 'get' | 'revision'>;
  snapshot: () => ObservedSnapshot;
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Reject links in every component below the trusted canonical root. */
async function confinedFile(root: string, file: string): Promise<Stats> {
  const tail = relative(root, file);
  if (!tail || isAbsolute(tail) || tail === '..' || tail.startsWith(`..${sep}`)) fail('source-unavailable');
  let current = root;
  const parts = tail.split(sep);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) fail('source-unavailable');
  }
  if (await fs.realpath(file) !== file) fail('source-unavailable');
  const stat = await fs.lstat(file);
  if (stat.nlink !== 1) fail('source-unavailable');
  return stat;
}

async function openSource(root: string, path: string): Promise<{ handle: FileHandle; stat: Stats }> {
  const before = await confinedFile(root, path);
  if (before.size === 0) fail('source-unavailable');
  if (before.size > MAX_BYTES) fail('source-too-large');
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !sameFile(before, stat) || !sameFile(stat, await confinedFile(root, path))) fail('source-changed');
    return { handle, stat };
  } catch (error) { await handle.close(); throw error; }
}

async function hashHandle(handle: FileHandle, size: number, write?: (chunk: Buffer) => Promise<void>, current?: () => Promise<void>) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(256 * 1024);
  for (let position = 0; position < size;) {
    await current?.();
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (!bytesRead) fail('source-changed');
    const chunk = buffer.subarray(0, bytesRead); hash.update(chunk); await write?.(chunk); position += bytesRead;
  }
  return hash.digest('hex');
}

/** Explicitly called by a future confirmed adoption flow, never by the scanner.
 * Returning 'prepared' proves byte copies only; no new native session exists yet. */
export class SessionCopyPreparer {
  private busy = false;
  constructor(private readonly options: SessionCopyOptions) {}

  async prepare(observedId: string): Promise<PreparedSessionCopy> {
    if (this.busy) fail('busy');
    this.busy = true;
    try { return await this.prepareOnce(observedId); }
    catch (error) {
      if (error instanceof SessionCopyError) throw error;
      // Never return an OS error carrying history paths or content to a caller.
      fail('storage-unavailable');
    } finally { this.busy = false; }
  }

  private async prepareOnce(observedId: string): Promise<PreparedSessionCopy> {
    if (!ID.test(observedId)) fail('session-unavailable');
    const session = this.options.snapshot().sessions.find((row) => row.id === observedId);
    if (!session || !['claude-code', 'codex'].includes(session.clientKind) || !UUID.test(session.nativeSessionId)
      || !isAbsolute(session.cwd) || !['user', 'user-adopted'].includes(session.origin ?? '') || session.ownership === 'unresolved'
      || sha1(`${session.clientKind}:${session.nativeSessionId}`) !== observedId) fail('session-unavailable');
    const revision = this.options.access.revision;
    const owned = join(this.options.userData, 'sessions', 'owned.json');
    const ownership = await readOwnership(owned);
    const originKey = ownershipKey(session.clientKind === 'codex' ? 'codex' : 'claude', session.nativeSessionId);
    const verifyOwnership = (index: typeof ownership) => {
      const origin = index.origins.get(originKey) ?? (index.pending ? 'unknown' : 'user');
      if (!index.available || origin !== session.origin) fail('ownership-changed');
    };
    verifyOwnership(ownership);
    const visible = () => {
      const latest = this.options.snapshot().sessions.find((row) => row.id === observedId);
      if (!latest || latest.nativeSessionId !== session.nativeSessionId || latest.cwd !== session.cwd
        || latest.origin !== session.origin || latest.ownership === 'unresolved') fail('session-unavailable');
    };
    const current = async (full = false) => {
      visible();
      if (!await canReadProject(session.cwd, this.options.access.get()) || this.options.access.revision !== revision) fail('scan-access-changed');
      if (full) {
        const index = await readOwnership(owned); verifyOwnership(index);
        if (index.token !== ownership.token) fail('ownership-changed');
      }
      if (this.options.access.revision !== revision) fail('scan-access-changed');
      visible();
    };
    await current(true);
    const roots = this.options.configRoots ?? clientRoots(this.options.homeDir);
    const config = session.clientKind === 'codex' ? roots.codex : roots.claude;
    if (!isAbsolute(config) || (await fs.lstat(config)).isSymbolicLink()) fail('source-unavailable');
    const root = await fs.realpath(config);
    const refs = session.clientKind === 'codex'
      ? await listCodexRollouts(this.options.homeDir, 500, root)
      : await listClaudeTranscripts(this.options.homeDir, 500, root);
    const matches: Array<{ path: string; cwd: string }> = [];
    for (const ref of refs) {
      await current();
      try {
        await confinedFile(root, ref.filePath);
        const identity = await readSessionIdentity(ref.filePath, session.clientKind as 'claude-code' | 'codex');
        if (identity?.sessionId === session.nativeSessionId) matches.push({ path: ref.filePath, cwd: identity.cwd });
      } catch { /* A missing/link candidate cannot become a source. */ }
    }
    if (matches.length !== 1) fail(matches.length ? 'source-ambiguous' : 'source-unavailable');
    if (matches[0].cwd !== session.cwd) fail('source-unavailable');
    const source = matches[0].path;
    await current(true);
    return this.copy(session, observedId, root, source, current);
  }

  private async copy(session: ObservedSession, observedId: string, sourceRoot: string, source: string,
    current: (full?: boolean) => Promise<void>): Promise<PreparedSessionCopy> {
    // The parent is app-owned userData. Every new child is private and links are
    // rejected; no file is written into a project or the original CLI home.
    const userData = await fs.realpath(this.options.userData);
    let parent = userData;
    for (const part of ['sessions', 'adoption-preparations']) {
      parent = join(parent, part);
      await fs.mkdir(parent, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(parent) !== parent) fail('storage-unavailable');
    }
    const preparationId = randomUUID(), folder = join(parent, preparationId);
    await fs.mkdir(folder, { mode: 0o700 });
    const directories = new Map([[folder, await fs.lstat(folder)]]), files = new Map<string, Stats>();
    const parentStat = await fs.lstat(parent);
    const storage = async () => {
      for (const [path, before] of [[parent, parentStat], ...directories] as Array<[string, Stats]>) {
        const after = await fs.lstat(path);
        if (after.isSymbolicLink() || !after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino
          || await fs.realpath(path) !== path) fail('storage-unavailable');
      }
    };
    const backupPath = join(folder, 'backup.jsonl'), isolatedHome = join(folder, 'native-home');
    const copyPath = session.clientKind === 'codex' ? join(isolatedHome, 'sessions', `rollout-${session.nativeSessionId}.jsonl`)
      : join(isolatedHome, 'projects', 'source', `${session.nativeSessionId}.jsonl`);
    try {
      const { handle, stat } = await openSource(sourceRoot, source);
      let sha256: string;
      try {
        await storage();
        const backup = await fs.open(backupPath, 'wx', 0o600); files.set(backupPath, await backup.stat());
        try { sha256 = await hashHandle(handle, stat.size, (chunk) => backup.writeFile(chunk), () => current()); await backup.sync(); }
        finally { await backup.close(); }
        if (!sameFile(stat, await handle.stat()) || !sameFile(stat, await confinedFile(sourceRoot, source))) fail('source-changed');
        const identity = await readSessionIdentity(backupPath, session.clientKind as 'claude-code' | 'codex');
        if (identity?.sessionId !== session.nativeSessionId || identity.cwd !== session.cwd) fail('source-changed');
        // Keep the native input separate from the saved backup; neither is a hard link.
        let dir = folder;
        for (const part of relative(folder, dirname(copyPath)).split(sep)) {
          await storage(); dir = join(dir, part); await fs.mkdir(dir, { mode: 0o700 }); directories.set(dir, await fs.lstat(dir));
        }
        await storage();
        const saved = await openSource(folder, backupPath);
        try {
          const copy = await fs.open(copyPath, 'wx', 0o600); files.set(copyPath, await copy.stat());
          try {
            if (await hashHandle(saved.handle, saved.stat.size, (chunk) => copy.writeFile(chunk), () => current()) !== sha256) fail('source-changed');
            await copy.sync();
          } finally { await copy.close(); }
        } finally { await saved.handle.close(); }
        for (const path of [backupPath, copyPath]) {
          const opened = await openSource(folder, path);
          try { if (await hashHandle(opened.handle, opened.stat.size) !== sha256) fail('source-changed'); }
          finally { await opened.handle.close(); }
        }
        if (await hashHandle(handle, stat.size, undefined, () => current()) !== sha256
          || !sameFile(stat, await handle.stat()) || !sameFile(stat, await confinedFile(sourceRoot, source))) fail('source-changed');
      } finally { await handle.close(); }
      await current(true); await storage();
      const result: PreparedSessionCopy = { schemaVersion: 1, state: 'prepared', preparationId,
        clientKind: session.clientKind as 'claude-code' | 'codex', sourceObservedId: observedId,
        sha256, byteLength: stat.size, createdAt: new Date().toISOString(), backupPath, copyPath, isolatedHome };
      const manifest = join(folder, 'manifest.json');
      const output = await fs.open(manifest, 'wx', 0o600); files.set(manifest, await output.stat());
      try {
        // Store only audit metadata; paths and native IDs remain in the private history copies.
        const { backupPath: _backup, copyPath: _copy, isolatedHome: _home, ...audit } = result;
        await output.writeFile(JSON.stringify(audit)); await output.sync();
      } finally { await output.close(); }
      await current(true); await storage();
      const final = await openSource(sourceRoot, source);
      try {
        if (!sameFile(stat, final.stat) || await hashHandle(final.handle, final.stat.size, undefined, () => current()) !== sha256
          || !sameFile(stat, await final.handle.stat()) || !sameFile(stat, await confinedFile(sourceRoot, source))) fail('source-changed');
      } finally { await final.handle.close(); }
      await current(true);
      return result;
    } catch (error) {
      // Remove only files created by this attempt, never recursively delete an
      // unexpected directory or follow a replaced parent during cleanup.
      if (await fs.realpath(folder).catch(() => null) === folder && await fs.realpath(parent).catch(() => null) === parent) {
        for (const [file, before] of [...files].reverse()) {
          const after = await fs.lstat(file).catch(() => null);
          if (after && after.dev === before.dev && after.ino === before.ino
            && await fs.realpath(dirname(file)).catch(() => null) === dirname(file)) await fs.unlink(file).catch(() => {});
        }
        for (const [dir, before] of [...directories].reverse()) {
          const after = await fs.lstat(dir).catch(() => null);
          if (after && after.dev === before.dev && after.ino === before.ino) await fs.rmdir(dir).catch(() => {});
        }
      }
      throw error;
    }
  }
}
