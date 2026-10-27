import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface CommandScopeViolation {
  path: string;
  change: 'added' | 'deleted' | 'modified';
}

export class ApprovedCommandScopeError extends Error {
  readonly code = 'approved-command-scope-violation';

  constructor(readonly violations: CommandScopeViolation[]) {
    const detail = violations.slice(0, 20)
      .map((entry) => `${entry.change}: ${entry.path}`)
      .join('; ');
    super(`Approved command changed files outside its authorized write scope: ${detail}`);
    this.name = 'ApprovedCommandScopeError';
  }
}

interface ApprovedCommandGuardOptions {
  workspaceRoot: string;
  writePaths: () => readonly string[];
  maxPendingCommands?: number;
}

type Snapshot = Map<string, string>;
interface Baseline {
  root: string;
  authorizedRoots: readonly string[];
  files: Snapshot;
}

export class ApprovedCommandGuard {
  private readonly workspaceRoot: string;
  private readonly writePaths: () => readonly string[];
  private readonly maxPendingCommands: number;
  private readonly pending = new Map<string, Baseline>();

  constructor(options: ApprovedCommandGuardOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.writePaths = options.writePaths;
    this.maxPendingCommands = options.maxPendingCommands ?? 32;
  }

  async before(commandId: string): Promise<void> {
    if (this.pending.has(commandId)) throw new Error(`Duplicate approved command id: ${commandId}`);
    if (this.pending.size >= this.maxPendingCommands) {
      throw new Error('Too many approved commands awaiting scope verification');
    }
    const root = await realpath(this.workspaceRoot);
    const authorizedRoots = this.writePaths().map((path) => resolve(root, path));
    const files = await this.snapshot(root, authorizedRoots);
    this.pending.set(commandId, { root, authorizedRoots, files });
  }

  async after(commandId: string): Promise<void> {
    const before = this.pending.get(commandId);
    this.pending.delete(commandId);
    if (!before) throw new Error(`No approved command baseline for: ${commandId}`);
    const after = await this.snapshot(before.root, before.authorizedRoots);
    const violations: CommandScopeViolation[] = [];
    for (const [path, hash] of before.files) {
      const next = after.get(path);
      if (next === undefined) violations.push({ path, change: 'deleted' });
      else if (next !== hash) violations.push({ path, change: 'modified' });
    }
    for (const path of after.keys()) {
      if (!before.files.has(path)) violations.push({ path, change: 'added' });
    }
    if (violations.length > 0) {
      violations.sort((left, right) => left.path.localeCompare(right.path));
      throw new ApprovedCommandScopeError(violations);
    }
  }

  cancel(commandId: string): void {
    this.pending.delete(commandId);
  }

  clear(): void {
    this.pending.clear();
  }

  private async snapshot(root: string, authorizedRoots: readonly string[]): Promise<Snapshot> {
    const snapshot: Snapshot = new Map();
    await this.visit(root, root, authorizedRoots, snapshot);
    return snapshot;
  }

  private async visit(
    root: string,
    current: string,
    authorizedRoots: readonly string[],
    snapshot: Snapshot,
  ): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = resolve(current, entry.name);
      if (isCovered(absolute, authorizedRoots)) continue;
      const stat = await lstat(absolute);
      if (stat.isDirectory()) {
        await this.visit(root, absolute, authorizedRoots, snapshot);
      } else if (stat.isSymbolicLink()) {
        snapshot.set(displayPath(root, absolute), hashValue(`symlink:${await readlink(absolute)}`));
      } else if (stat.isFile()) {
        snapshot.set(displayPath(root, absolute), await hashFile(absolute));
      } else {
        snapshot.set(displayPath(root, absolute), hashValue(`other:${stat.mode}:${stat.size}`));
      }
    }
  }
}

function isCovered(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const rel = relative(root, candidate);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
  });
}

function displayPath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
