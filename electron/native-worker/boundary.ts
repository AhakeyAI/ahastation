import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** G4 evidence for explicitly selected local boundary roots. This detects
 * changes; it cannot prevent writes, cover the whole disk or monitor remotes.
 * Native admission separately requires an independent execution guard. */
export class OutsideWriteMonitor {
  private baseline?: string;
  constructor(private readonly roots: readonly string[], private readonly maxFiles = 10_000,
    private readonly maxBytes = 64 * 1024 * 1024) {
    if (roots.length === 0 || roots.length > 100) throw new Error('invalid-boundary-roots');
  }
  private snapshot(): string {
    let files = 0, bytes = 0;
    const hash = createHash('sha256');
    const visit = (path: string, depth: number) => {
      if (++files > this.maxFiles || depth > 64) throw new Error('boundary-limit');
      let stat;
      try { stat = lstatSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        hash.update(JSON.stringify([path, 'absent'])); return;
      }
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('boundary-unverifiable');
      hash.update(JSON.stringify([path, stat.isDirectory() ? 'directory' : 'file', stat.mode]));
      if (stat.isDirectory()) {
        for (const name of readdirSync(path).sort()) visit(join(path, name), depth + 1);
      } else {
        bytes += stat.size;
        if (bytes > this.maxBytes) throw new Error('boundary-limit');
        hash.update(readFileSync(path));
      }
    };
    for (const root of [...new Set(this.roots.map(p => resolve(p)))].sort()) visit(root, 0);
    return hash.digest('hex');
  }
  capture(): void { this.baseline = this.snapshot(); }
  check(): boolean {
    if (!this.baseline) return false;
    try { return this.snapshot() === this.baseline; } catch { return false; }
  }
}
