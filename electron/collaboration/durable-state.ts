import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
/** Serialized, fsynced replacement. A failed save never acknowledges receipt. */
export class DurableState<T> {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string, private value: T) {}
  async load(): Promise<void> {
    try { this.value = JSON.parse(await readFile(this.file,'utf8')) as T; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('本机协作记录无法读取，请保留原文件并修复后重试');
      }
      // Windows can report ENOENT when an ancestor is a regular file. Only
      // initialize missing state after proving its existing ancestor is a directory.
      let directory = dirname(this.file);
      for (;;) {
        try {
          if (!(await stat(directory)).isDirectory()) throw new Error('Invalid state directory');
          return;
        } catch (parentError) {
          const parent = dirname(directory);
          if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT' || parent === directory) {
            throw new Error('本机协作记录无法读取，请保留原文件并修复后重试');
          }
          directory = parent;
        }
      }
    }
  }
  read(): T { return structuredClone(this.value); }
  async flush(): Promise<void> { await this.queue; }
  update(change: (state: T) => void): Promise<void> {
    const job = this.queue.then(async () => {
      const next = structuredClone(this.value); change(next);
      await mkdir(dirname(this.file), { recursive: true });
      const temp = this.file + '.next'; const handle = await open(temp,'w',0o600);
      try { await handle.writeFile(JSON.stringify(next)); await handle.sync(); } finally { await handle.close(); }
      // Windows scanners/readers can briefly deny replacement even after the
      // new file is closed. Keep the original and retry the atomic rename;
      // never delete it or acknowledge the new state before replacement.
      for(let attempt=0;;attempt++){
        try{await rename(temp,this.file);break;}
        catch(error){
          if(process.platform!=='win32'||attempt>=9||!['EPERM','EACCES','EBUSY'].includes(String((error as NodeJS.ErrnoException).code)))throw error;
          await delay(Math.min(50*(attempt+1),250));
        }
      }
      this.value = next;
    });
    this.queue = job.catch(() => {}); return job;
  }
}
