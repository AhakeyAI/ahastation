import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS command_requests (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'completed', 'rejected')),
  result_seq INTEGER,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source, source_id)
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  workflow_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  causation_id TEXT,
  correlation_id TEXT,
  source TEXT,
  source_id TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_workflow_seq ON events(workflow_id, seq);

CREATE TABLE IF NOT EXISTS outbox (
  outbox_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  target_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'acknowledged', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_status_seq ON outbox(status, created_seq);

CREATE TABLE IF NOT EXISTS workflows (
  workflow_id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  host_agent_id TEXT,
  active_seq INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_instances (
  agent_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  role TEXT NOT NULL,
  backend TEXT NOT NULL,
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  backend_session_id TEXT,
  worktree_path TEXT,
  base_commit_sha TEXT,
  pid INTEGER,
  Generation INTEGER NOT NULL DEFAULT 1,
  capabilities_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS work_items (
  work_item_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  title TEXT NOT NULL,
  assigned_agent_id TEXT,
  state TEXT NOT NULL,
  base_commit_sha TEXT,
  latest_candidate_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

if (process.argv[2] === '--crash-child') {
  const dbPath = process.argv[3];
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
  // 1. Committed transaction
  db.exec('BEGIN IMMEDIATE;');
  db.prepare(`INSERT INTO events (event_id, workflow_id, type, actor_kind, actor_id, payload_json, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    'evt-crash-committed',
    'wf-1',
    'AgentTurnCompleted',
    'worker',
    'agent-1',
    JSON.stringify({ summary: 'committed before crash' }),
    Date.now(),
  );
  db.prepare(`UPDATE workflows SET active_seq = active_seq + 1, updated_at = ? WHERE workflow_id = ?`).run(
    Date.now(),
    'wf-1',
  );
  db.exec('COMMIT;');

  // 2. Uncommitted in-flight transaction interrupted by hard kill
  db.exec('BEGIN IMMEDIATE;');
  db.prepare(`INSERT INTO events (event_id, workflow_id, type, actor_kind, actor_id, payload_json, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    'evt-crash-uncommitted',
    'wf-1',
    'AgentTurnStarted',
    'worker',
    'agent-1',
    JSON.stringify({ summary: 'must roll back on crash' }),
    Date.now(),
  );
  db.prepare(`INSERT INTO outbox (outbox_id, workflow_id, effect_type, dedupe_key, target_id, payload_json, status, created_seq, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'pending', 999999, ?)`).run(
    'ob-crash-uncommitted',
    'wf-1',
    'dispatch_turn',
    'dedupe-crash-uncommitted',
    'agent-1',
    '{}',
    Date.now(),
  );
  // Abruptly terminate process without closing SQLite or committing
  process.kill(process.pid, 'SIGKILL');
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number(sorted[idx].toFixed(3));
}

function benchmarkMode(baseDir, syncMode, iterations = 200) {
  const dbPath = path.join(baseDir, `wf-${syncMode.toLowerCase()}.sqlite`);
  try { fs.rmSync(dbPath, { force: true }); } catch {}
  try { fs.rmSync(`${dbPath}-wal`, { force: true }); } catch {}
  try { fs.rmSync(`${dbPath}-shm`, { force: true }); } catch {}

  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = ${syncMode}; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`);
  db.exec(SCHEMA_SQL);

  const now = Date.now();
  db.prepare(`INSERT INTO workflows (workflow_id, project_path, title, state, host_agent_id, active_seq, config_json, created_at, updated_at)
              VALUES ('wf-1', 'C:/repo', 'Test Workflow', 'active', 'host-1', 0, '{}', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO agent_instances (agent_id, workflow_id, role, backend, mode, state, capabilities_json, created_at, updated_at)
              VALUES ('agent-1', 'wf-1', 'worker', 'claude', 'pty-interactive', 'idle', '{}', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO work_items (work_item_id, workflow_id, title, assigned_agent_id, state, created_at, updated_at)
              VALUES ('wi-1', 'wf-1', 'Implement feature', 'agent-1', 'in_progress', ?, ?)`).run(now, now);

  const insertReq = db.prepare(`
    INSERT INTO command_requests (source, source_id, workflow_id, command_type, payload_hash, status, created_at, updated_at)
    VALUES (?, ?, 'wf-1', 'DispatchInstruction', ?, 'accepted', ?, ?)
  `);
  const insertEvent = db.prepare(`
    INSERT INTO events (event_id, workflow_id, type, actor_kind, actor_id, source, source_id, payload_json, created_at)
    VALUES (?, 'wf-1', 'InstructionDispatched', 'host', 'host-1', ?, ?, ?, ?)
  `);
  const insertOutbox = db.prepare(`
    INSERT INTO outbox (outbox_id, workflow_id, effect_type, dedupe_key, target_id, payload_json, status, created_seq, updated_at)
    VALUES (?, 'wf-1', 'wake_agent', ?, 'agent-1', ?, 'pending', ?, ?)
  `);
  const updateWf = db.prepare(`UPDATE workflows SET active_seq = ?, updated_at = ? WHERE workflow_id = 'wf-1'`);
  const updateAgent = db.prepare(`UPDATE agent_instances SET state = 'running_turn', updated_at = ? WHERE agent_id = 'agent-1'`);
  const completeReq = db.prepare(`UPDATE command_requests SET status = 'completed', result_seq = ?, updated_at = ? WHERE source = ? AND source_id = ?`);

  const latenciesMs = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const ts = Date.now();
    const src = 'host_tool';
    const srcId = `call_${i}`;
    const payloadJson = JSON.stringify({ instruction: `Step ${i}`, workItemId: 'wi-1', turn: i });

    db.exec('BEGIN IMMEDIATE;');
    insertReq.run(src, srcId, `hash_${i}`, ts, ts);
    const evtRes = insertEvent.run(`evt_${i}`, src, srcId, payloadJson, ts);
    const seq = Number(evtRes.lastInsertRowid);
    insertOutbox.run(`ob_${i}`, `dedupe_${i}`, payloadJson, seq, ts);
    updateWf.run(seq, ts);
    updateAgent.run(ts);
    completeReq.run(seq, ts, src, srcId);
    db.exec('COMMIT;');

    const t1 = performance.now();
    latenciesMs.push(t1 - t0);
  }

  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const stats = {
    syncMode,
    iterations,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
    meanMs: Number((latenciesMs.reduce((a, b) => a + b, 0) / latenciesMs.length).toFixed(3)),
  };

  return { db, dbPath, stats };
}

async function main() {
  const workDir = path.join(__dirname, 'p0-e-sqlite-data');
  fs.mkdirSync(workDir, { recursive: true });

  const runtimeInfo = {
    electronVersion: process.versions.electron,
    nodeVersion: process.version,
    sqliteVersion: process.versions.sqlite,
    platform: process.platform,
    arch: process.arch,
  };

  const fullRun = benchmarkMode(workDir, 'FULL', 200);
  const normalRun = benchmarkMode(workDir, 'NORMAL', 200);
  normalRun.db.close();

  // Online backup verification via VACUUM INTO on the active FULL DB
  const backupPath = path.join(workDir, 'wf-full-backup.sqlite');
  try { fs.rmSync(backupPath, { force: true }); } catch {}
  const backupStart = performance.now();
  fullRun.db.prepare(`VACUUM INTO ?`).run(backupPath);
  const backupDurationMs = Number((performance.now() - backupStart).toFixed(3));

  const backupDb = new DatabaseSync(backupPath);
  const backupIntegrity = backupDb.prepare('PRAGMA integrity_check;').get();
  const backupEventCount = backupDb.prepare('SELECT COUNT(*) AS cnt FROM events;').get();
  backupDb.close();
  fullRun.db.close();

  // Crash recovery verification on the FULL DB
  const childRes = spawnSync(
    process.execPath,
    [__filename, '--crash-child', fullRun.dbPath],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'pipe',
    },
  );

  // Reopen after SIGKILL during open transaction
  const recoveredDb = new DatabaseSync(fullRun.dbPath);
  recoveredDb.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
  const integrityAfterCrash = recoveredDb.prepare('PRAGMA integrity_check;').get();
  const committedAfterCrash = recoveredDb
    .prepare(`SELECT event_id, seq FROM events WHERE event_id = 'evt-crash-committed'`)
    .get();
  const uncommittedEventAfterCrash = recoveredDb
    .prepare(`SELECT event_id, seq FROM events WHERE event_id = 'evt-crash-uncommitted'`)
    .get();
  const uncommittedOutboxAfterCrash = recoveredDb
    .prepare(`SELECT outbox_id FROM outbox WHERE outbox_id = 'ob-crash-uncommitted'`)
    .get();
  const totalEventsAfterCrash = recoveredDb.prepare('SELECT COUNT(*) AS cnt FROM events;').get();
  recoveredDb.close();

  const report = {
    runtimeInfo,
    benchmarks: {
      full: fullRun.stats,
      normal: normalRun.stats,
    },
    onlineBackup: {
      method: 'VACUUM INTO',
      backupDurationMs,
      integrityCheck: backupIntegrity,
      eventCount: backupEventCount.cnt,
    },
    crashRecovery: {
      childSignal: childRes.signal,
      childStatus: childRes.status,
      integrityCheck: integrityAfterCrash,
      committedSurvivor: committedAfterCrash ?? null,
      uncommittedEventRolledBack: uncommittedEventAfterCrash === undefined,
      uncommittedOutboxRolledBack: uncommittedOutboxAfterCrash === undefined,
      totalEventsAfterCrash: totalEventsAfterCrash.cnt,
    },
  };

  const reportJson = JSON.stringify(report, null, 2);
  fs.writeFileSync(path.join(__dirname, 'p0-e-report.json'), reportJson, 'utf8');
  console.log(reportJson);
}

main().catch((err) => {
  fs.writeFileSync(path.join(__dirname, 'p0-e-error.txt'), String(err?.stack ?? err), 'utf8');
  console.error(err);
  process.exit(1);
});
