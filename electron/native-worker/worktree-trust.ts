import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const created = new Map<string, string>();
function identity(directory: string): string {
  const s = lstatSync(directory);
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('unverified-worktree');
  const git = lstatSync(join(directory, '.git'));
  if (!git.isFile() || git.isSymbolicLink() || git.size > 4096) throw new Error('unverified-worktree');
  return createHash('sha256').update(JSON.stringify([realpathSync.native(directory), s.dev, s.ino, s.birthtimeMs,
    readFileSync(join(directory, '.git'), 'utf8')])).digest('hex');
}
/** Main-side creation receipt, called only after application-owned git worktree
 * add succeeds. Never reconstruct receipts from env, paths or CLI text. */
export function recordAppCreatedWorktree(directory: string): void {
  created.set(resolve(directory), identity(directory));
}
export function canAutoTrustAppWorktree(directory: string, enabled: boolean): boolean {
  if (!enabled) return false;
  try { return created.get(resolve(directory)) === identity(directory); } catch { return false; }
}
// Receipts do not survive host restart; a disk marker is not creation proof.
