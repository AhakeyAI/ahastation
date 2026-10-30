// Board 「待执行」 cards: work confirmed from the meeting notes but not yet
// dispatched (minimal U3b, #123). One JSON file in userData; cards are never
// started automatically — dispatch stays a separate, confirmed step.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { app } from 'electron';
import { createGithubIssue } from './projects.js';

export interface BacklogItem {
  id: string;
  cwd: string;
  projectName: string;
  title: string;
  kind: 'work-item' | 'todo';
  source?: string;
  createdAt: number;
  issueUrl?: string;
  issueError?: string;
}

function file(): string {
  return join(app.getPath('userData'), 'backlog.json');
}

let cached: BacklogItem[] | null = null;

export async function listBacklog(): Promise<BacklogItem[]> {
  if (cached) return cached;
  try {
    const parsed: unknown = JSON.parse(await readFile(file(), 'utf8'));
    cached = Array.isArray(parsed) ? (parsed as BacklogItem[]) : [];
  } catch {
    cached = [];
  }
  return cached;
}

async function save(items: BacklogItem[]): Promise<void> {
  cached = items;
  const target = file();
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(items, null, 1));
  await rename(tmp, target);
}

export async function addBacklog(input: {
  cwd: string;
  items: { title: string; kind: 'work-item' | 'todo'; source?: string }[];
  createIssues: boolean;
}): Promise<BacklogItem[]> {
  const created: BacklogItem[] = [];
  for (const entry of input.items) {
    const item: BacklogItem = {
      id: randomUUID(),
      cwd: input.cwd,
      projectName: basename(input.cwd),
      title: entry.title,
      kind: entry.kind,
      ...(entry.source ? { source: entry.source } : {}),
      createdAt: Date.now(),
    };
    if (input.createIssues && entry.kind === 'work-item') {
      const body = [
        '来自 AhaStudio 会议纪要，已由用户确认。',
        entry.source ? `\n来源：${entry.source}` : '',
      ].join('');
      const res = await createGithubIssue(input.cwd, entry.title, body);
      if (res.ok) item.issueUrl = res.url;
      else item.issueError = res.error;
    }
    created.push(item);
  }
  await save([...(await listBacklog()), ...created]);
  return created;
}

export async function removeBacklog(id: string): Promise<void> {
  await save((await listBacklog()).filter((item) => item.id !== id));
}
