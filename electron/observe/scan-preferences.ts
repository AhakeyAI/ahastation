import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const MAX_HIDDEN = 10_000;
const documentSchema = z.object({ schemaVersion: z.literal(1),
  sessions: z.array(z.string().regex(/^[a-f0-9]{40}$/)).max(MAX_HIDDEN),
  directories: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(MAX_HIDDEN),
}).strict();

/** Local presentation preferences, never IF-2 ownership or execution grants.
 * Persist only opaque keys, not native paths, prompts or session titles. */
export class ScanPreferences {
  private sessions = new Set<string>();
  private directories = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  available = true;
  constructor(private readonly file?: string) {}
  get revision(): number { return this.generation; }
  hiddenSession(id: string): boolean { return this.sessions.has(id); }
  hiddenDirectory(key: string): boolean { return this.directories.has(key); }
  summary() { return { sessions: this.sessions.size, directories: this.directories.size }; }

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('invalid-preferences');
      const doc = documentSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
      this.sessions = new Set(doc.sessions); this.directories = new Set(doc.directories);
      this.available = true;
    } catch (error) {
      this.available = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (this.available) { this.sessions.clear(); this.directories.clear(); }
    }
    this.generation++;
  }

  hide(kind: 'session' | 'directory', key: string): Promise<void> {
    if (!(kind === 'session' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(key)) return Promise.reject(new Error('无效的扫描项目'));
    return this.update(kind, key);
  }
  restore(): Promise<void> { return this.update(); }

  private update(kind?: 'session' | 'directory', key?: string): Promise<void> {
    const work = this.tail.catch(() => {}).then(async () => {
      if (!this.available && kind) throw new Error('忽略记录暂不可读，请先确认重置');
      const sessions = kind ? new Set(this.sessions) : new Set<string>();
      const directories = kind ? new Set(this.directories) : new Set<string>();
      if (kind === 'session') sessions.add(key!);
      if (kind === 'directory') directories.add(key!);
      if (sessions.size > MAX_HIDDEN || directories.size > MAX_HIDDEN) throw new Error('忽略记录已达上限，请先恢复记录');
      if (this.file) {
        await fs.mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(tmp, JSON.stringify({ schemaVersion: 1, sessions: [...sessions], directories: [...directories] }), { mode: 0o600 });
          await fs.rename(tmp, this.file);
        } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
      }
      this.sessions = sessions; this.directories = directories; this.available = true; this.generation++;
    });
    this.tail = work;
    return work;
  }
}
