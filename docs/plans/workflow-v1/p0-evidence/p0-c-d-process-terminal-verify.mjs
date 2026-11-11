import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const nodePty = require('@lydell/node-pty');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── P0-C helpers: Windows process tree sampling & termination ─────────────
async function sampleWin32Processes() {
  const fields = 'ProcessId,ParentProcessId,WorkingSetSize,CreationDate';
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    `$rows = @(Get-CimInstance -Query 'SELECT ${fields} FROM Win32_Process' | Select-Object ProcessId,ParentProcessId,WorkingSetSize,@{Name='CreationDate';Expression={if ($null -ne $_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')}}})`,
    'ConvertTo-Json -InputObject $rows -Compress',
  ].join('; ');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((r) => ({
    pid: Number(r.ProcessId),
    ppid: Number(r.ParentProcessId),
    rssBytes: Number(r.WorkingSetSize),
    startedAt: r.CreationDate ? String(r.CreationDate).trim() : undefined,
  }));
}

function getProcessTree(samples, rootPids) {
  const byPid = new Map(samples.map((s) => [s.pid, s]));
  const children = new Map();
  for (const s of samples) {
    const arr = children.get(s.ppid) ?? [];
    arr.push(s.pid);
    children.set(s.ppid, arr);
  }
  const pending = [...rootPids];
  const visited = new Set();
  const result = [];
  while (pending.length) {
    const pid = pending.pop();
    if (visited.has(pid)) continue;
    visited.add(pid);
    const sample = byPid.get(pid);
    if (!sample) continue;
    result.push(sample);
    for (const c of children.get(pid) ?? []) pending.push(c);
  }
  return result;
}

// ── P0-D helpers: UTF-8 & ANSI CSI/OSC safe boundary splitter ─────────────
/**
 * Finds the largest byte offset <= buf.length that does NOT split:
 * 1) an incomplete multi-byte UTF-8 sequence at the tail, or
 * 2) an incomplete ESC / CSI (\x1b[...) / OSC (\x1b]...) sequence at the tail.
 */
function findSafeCheckpointByteOffset(buf) {
  let end = buf.length;
  if (end === 0) return 0;

  // 1. Check trailing UTF-8 continuation bytes (10xxxxxx = 0x80..0xBF)
  let i = end - 1;
  while (i >= 0 && end - i <= 4 && (buf[i] & 0xc0) === 0x80) {
    i--;
  }
  if (i >= 0 && end - i <= 4) {
    const lead = buf[i];
    let expectedLen = 1;
    if ((lead & 0x80) === 0x00) expectedLen = 1;
    else if ((lead & 0xe0) === 0xc0) expectedLen = 2;
    else if ((lead & 0xf0) === 0xe0) expectedLen = 3;
    else if ((lead & 0xf8) === 0xf0) expectedLen = 4;
    if (i + expectedLen > end) {
      end = i; // Cut before incomplete UTF-8 lead byte
    }
  }

  // 2. Check trailing incomplete ESC / CSI / OSC sequence (within last 256 bytes)
  const scanStart = Math.max(0, end - 256);
  for (let pos = end - 1; pos >= scanStart; pos--) {
    if (buf[pos] === 0x1b) {
      const nextIdx = pos + 1;
      if (nextIdx >= end) {
        return pos; // Bare ESC at very end
      }
      const nextByte = buf[nextIdx];
      if (nextByte === 0x5b) {
        // CSI: ESC [ ... final byte in 0x40..0x7E
        let completed = false;
        for (let k = nextIdx + 1; k < end; k++) {
          if (buf[k] >= 0x40 && buf[k] <= 0x7e) {
            completed = true;
            break;
          }
        }
        if (!completed) return pos;
      } else if (nextByte === 0x5d) {
        // OSC: ESC ] ... terminated by BEL (0x07) or ST (ESC \)
        let completed = false;
        for (let k = nextIdx + 1; k < end; k++) {
          if (buf[k] === 0x07 || (buf[k] === 0x5c && buf[k - 1] === 0x1b)) {
            completed = true;
            break;
          }
        }
        if (!completed) return pos;
      }
      break;
    }
  }
  return end;
}

async function runP0C(workDir) {
  // Spawn a ConPTY worker script that spawns:
  // 1) a child "subagent" process
  // 2) a detached background writer process that writes heartbeats to a file every 80ms
  const workerScript = path.join(workDir, 'worker-with-children.cjs');
  const bgHeartbeatFile = path.join(workDir, 'bg-heartbeat.log');
  const pidsFile = path.join(workDir, 'spawned-pids.json');

  fs.writeFileSync(
    workerScript,
    `
const { spawn } = require('child_process');
const fs = require('fs');

const bgScript = \`
  const fs = require('fs');
  setInterval(() => {
    try { fs.appendFileSync(\${JSON.stringify(${JSON.stringify(bgHeartbeatFile)})}, Date.now() + '\\\\n'); } catch {}
  }, 60);
\`;

const subagent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'ignore',
});

// Spawn background writer inside the same process tree
const bgWriter = spawn(process.execPath, ['-e', bgScript], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'ignore',
});

fs.writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({
  workerPid: process.pid,
  subagentPid: subagent.pid,
  bgWriterPid: bgWriter.pid,
}));

console.log('WORKER_TREE_READY');

// On SIGINT / Ctrl+C (turn-level interrupt), worker catches it and stops current turn WITHOUT killing bgWriter
process.on('SIGINT', () => {
  console.log('TURN_INTERRUPTED_ONLY');
});

setInterval(() => {}, 1000);
`,
    'utf8',
  );

  let ptyOutput = '';
  const pty = nodePty.spawn(
    process.execPath,
    [workerScript],
    {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: workDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    },
  );
  const syncSpawnPid = pty.pid; // Check if 0 on Windows ConPTY before async connection completes!
  pty.onData((d) => {
    ptyOutput += d;
  });

  // Wait for WORKER_TREE_READY
  const readyDeadline = Date.now() + 8000;
  while (Date.now() < readyDeadline && !ptyOutput.includes('WORKER_TREE_READY')) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const connectedPid = pty.pid;
  const spawnedPids = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));

  // Sample OS process tree before turn stop
  const samplesBefore = await sampleWin32Processes();
  const treeBefore = getProcessTree(samplesBefore, [connectedPid]);

  // Step 1: Send turn-level interrupt (\x03 Ctrl+C)
  pty.write('\x03');
  await new Promise((r) => setTimeout(r, 300));

  // Verify background writer is STILL writing after turn-level stop!
  const sizeAtTurnStop = fs.existsSync(bgHeartbeatFile) ? fs.statSync(bgHeartbeatFile).size : 0;
  await new Promise((r) => setTimeout(r, 250));
  const sizeAfterTurnStopWait = fs.existsSync(bgHeartbeatFile) ? fs.statSync(bgHeartbeatFile).size : 0;
  const bgWriterStillAliveAfterTurnStop = sizeAfterTurnStopWait > sizeAtTurnStop;

  // Step 2: Escalate to process-tree stop (`taskkill /pid <pid> /t /f`) as required by P0-C / RV-04
  await execFileAsync(
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
    ['/pid', String(connectedPid), '/t', '/f'],
    { windowsHide: true, timeout: 10000 },
  );
  try { pty.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 250));

  // Sample OS process tree after `taskkill /t /f`
  const samplesAfter = await sampleWin32Processes();
  const trackedSet = new Set([connectedPid, spawnedPids.workerPid, spawnedPids.subagentPid, spawnedPids.bgWriterPid]);
  const survivorsAfterTreeKill = samplesAfter.filter((s) => trackedSet.has(s.pid));

  const sizeAfterKill1 = fs.existsSync(bgHeartbeatFile) ? fs.statSync(bgHeartbeatFile).size : 0;
  await new Promise((r) => setTimeout(r, 250));
  const sizeAfterKill2 = fs.existsSync(bgHeartbeatFile) ? fs.statSync(bgHeartbeatFile).size : 0;
  const bgWriterStoppedWriting = sizeAfterKill2 === sizeAfterKill1;

  return {
    syncSpawnPidAtCallTime: syncSpawnPid,
    connectedPidAfterStartup: connectedPid,
    spawnedPids,
    treeCountBeforeStop: treeBefore.length,
    treePidsBeforeStop: treeBefore.map((p) => p.pid),
    bgWriterStillAliveAfterTurnStop,
    survivorsAfterTreeKillCount: survivorsAfterTreeKill.length,
    bgWriterStoppedWritingAfterTreeKill: bgWriterStoppedWriting,
  };
}

async function runP0D(workDir) {
  const logPath = path.join(workDir, 'terminal-raw.log');
  const fd = fs.openSync(logPath, 'w');

  // Test 1: UTF-8 multi-byte + ANSI CSI/OSC boundary safety
  // Create a buffer with Chinese text ("你好世界") and ANSI color sequence ("\x1b[38;2;255;128;0m")
  const sampleText = 'Hello 你好世界 \x1b[38;2;255;128;0mColoredText\x1b[0m\r\n';
  const sampleBuf = Buffer.from(sampleText, 'utf8');

  // Cut right in the middle of "你" (bytes: E4 BD A0) and right in the middle of CSI "\x1b[38;2;"
  const idxChineseLead = sampleBuf.indexOf(Buffer.from('你', 'utf8'));
  const tornUtf8Slice = sampleBuf.subarray(0, idxChineseLead + 2); // 2 of 3 bytes of '你'
  const safeOffsetUtf8 = findSafeCheckpointByteOffset(tornUtf8Slice);

  const idxCsi = sampleBuf.indexOf(Buffer.from('\x1b[38;2;', 'utf8'));
  const tornCsiSlice = sampleBuf.subarray(0, idxCsi + 5); // "\x1b[38;" (incomplete CSI)
  const safeOffsetCsi = findSafeCheckpointByteOffset(tornCsiSlice);

  // Test 2: High-throughput batched flush benchmark (2,000 chunks)
  const flushLatenciesMs = [];
  let pendingChunks = [];
  let pendingBytes = 0;
  let totalBytesWritten = 0;

  const flushBatch = () => {
    if (pendingChunks.length === 0) return;
    const t0 = performance.now();
    const combined = Buffer.concat(pendingChunks);
    fs.writeSync(fd, combined);
    totalBytesWritten += combined.length;
    pendingChunks = [];
    pendingBytes = 0;
    flushLatenciesMs.push(performance.now() - t0);
  };

  const tStart = performance.now();
  for (let i = 0; i < 2000; i++) {
    pendingChunks.push(sampleBuf);
    pendingBytes += sampleBuf.length;
    if (pendingBytes >= 64 * 1024) {
      flushBatch();
    }
  }
  flushBatch();
  fs.closeSync(fd);
  const totalWriteDurationMs = Number((performance.now() - tStart).toFixed(3));

  // Test 3: Check package availability in node_modules for @xterm/headless and @xterm/addon-serialize
  let xtermHeadlessInstalledInRepo = false;
  let xtermSerializeInstalledInRepo = false;
  try {
    require.resolve('@xterm/headless');
    xtermHeadlessInstalledInRepo = true;
  } catch {}
  try {
    require.resolve('@xterm/addon-serialize');
    xtermSerializeInstalledInRepo = true;
  } catch {}

  // Test 4: Verify raw tail replay from safe checkpoint offset
  const fullLogBuf = fs.readFileSync(logPath);
  const arbitraryCut = Math.floor(fullLogBuf.length * 0.6) + 1;
  const safeCheckpointOffset = findSafeCheckpointByteOffset(fullLogBuf.subarray(0, arbitraryCut));
  const tailReplayBuf = fullLogBuf.subarray(safeCheckpointOffset);
  const tailReplayDecoded = tailReplayBuf.toString('utf8');
  const hasReplacementChar = tailReplayDecoded.includes('\uFFFD');

  return {
    boundarySafety: {
      idxChineseLead,
      safeOffsetUtf8MatchesLeadBoundary: safeOffsetUtf8 === idxChineseLead,
      idxCsi,
      safeOffsetCsiMatchesEscBoundary: safeOffsetCsi === idxCsi,
      tailReplayHasReplacementChar: hasReplacementChar,
    },
    batchFlushBenchmark: {
      chunks: 2000,
      totalBytesWritten,
      flushCalls: flushLatenciesMs.length,
      totalWriteDurationMs,
      maxFlushMs: Number(Math.max(...flushLatenciesMs).toFixed(3)),
    },
    packagesInRepoNodeModules: {
      xtermHeadlessInstalledInRepo,
      xtermSerializeInstalledInRepo,
      fallbackRequiredByP0D: !xtermHeadlessInstalledInRepo || !xtermSerializeInstalledInRepo,
      selectedRecoveryStrategy: 'checkpoint + raw tail replay (safe UTF-8/CSI boundary offset)',
    },
  };
}

async function main() {
  const workDir = path.join(__dirname, `p0-cd-data-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  const p0C = await runP0C(workDir);
  const p0D = await runP0D(workDir);

  const report = { p0C, p0D };
  const reportJson = JSON.stringify(report, null, 2);
  fs.writeFileSync(path.join(__dirname, 'p0-c-d-report.json'), reportJson, 'utf8');
  console.log(reportJson);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
