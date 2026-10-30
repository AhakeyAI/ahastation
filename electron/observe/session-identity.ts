import { join } from 'node:path';
import { asRecord, asString, parseJsonLine, readWindowLines, HEAD_WINDOW_BYTES } from './util.js';

export function clientRoots(home: string, env: NodeJS.ProcessEnv = process.env) {
  return { claude: env.CLAUDE_CONFIG_DIR || join(home, '.claude'), codex: env.CODEX_HOME || join(home, '.codex') };
}

/** Only routing metadata escapes this pass. No title, messages or tail analysis. */
export async function readSessionIdentity(path: string, kind: 'claude-code' | 'codex') {
  const head = await readWindowLines(path, 'head', HEAD_WINDOW_BYTES);
  for (const line of head.lines.slice(0, 200)) {
    const row = asRecord(parseJsonLine(line));
    if (!row) continue;
    const meta = kind === 'codex' ? (row.type === 'session_meta' ? asRecord(row.payload) : null) : row;
    const sessionId = asString(kind === 'codex' ? meta?.id ?? meta?.session_id : meta?.sessionId);
    const cwd = asString(meta?.cwd);
    if (sessionId && cwd) return { sessionId, cwd };
  }
  return null;
}
