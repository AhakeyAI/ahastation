// Same production guard/channel/profile service; no fake guard, CLI login,
// global hooks, PTY or model. This is OS/broker evidence, not B04/engine proof.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync, existsSync, openSync, writeSync, fsyncSync, closeSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePrivateHookDirectory, createPrivateHookFile } from '../global-hooks/file-security.js';
import { compileTaskAuthority } from '../task-authority.js';
import { NativeWorkerProfileService } from './profile-service.js';
import type { NativeWorkerBrokerChannel } from './broker-channel.js';

export async function runNativeWorkerOfflineAcceptance(helperPath: string, helperSha256: string,
  cliProbes: Array<{ agent: 'claude' | 'codex'; path: string; sha256: string }> = []) {
  if (process.platform !== 'win32') return { status: 'skipped', reason: 'Windows AppContainer boundary only; CLI/platform admission stays closed' };
  const root = join(realpathSync.native(tmpdir()), `aha-native-acceptance-${randomUUID()}`);
  ensurePrivateHookDirectory(root);
  const profile = join(root, 'profile'), workspace = join(root, 'workspace');
  ensurePrivateHookDirectory(workspace);
  const authorityJournal = join(root, 'authority.jsonl'); createPrivateHookFile(authorityJournal, '');
  const sentinel = join(root, 'outside.txt'); createPrivateHookFile(sentinel, 'original');
  const service = new NativeWorkerProfileService(profile); service.initializeAcceptanceProfile();
  let connections = 0, reports = 0, asks = 0, journalHealthy = true;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const results: string[] = [], journal: unknown[] = [];
  const channels: NativeWorkerBrokerChannel[] = [];
  async function fixture(cliVersionProbe?: { agent: 'claude' | 'codex'; path: string; sha256: string }) {
    const taskId = randomUUID(), attemptId = randomUUID();
    const grant = compileTaskAuthority(taskId, 1, 1, `isolated-local-approval-${randomUUID()}`, workspace,
      { writePaths: [], toolKinds: ['write'], commands: [], workingDirectories: ['.'], environmentKeys: [], networkHosts: [], maxCommandTimeoutMs: 1000 }, Date.now());
    const c = service.createOfflineBroker({ agent: cliVersionProbe?.agent ?? 'claude', workerId: randomUUID(), taskId, attemptId, helperPath, helperSha256, cliVersionProbe,
      ports: { attempt: 1, workspaceRoot: workspace, getGrant: () => grant, isCurrentAttempt: () => true,
        askUser: async request => { asks++; return request.call.input.content === 'deny' ? 'deny' : 'allow'; },
        persistPermissionDecision: async value => {
          if (!journalHealthy) throw new Error('injected-durable-storage-failure');
          const fd = openSync(authorityJournal, 'a'); try { writeSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
          journal.push(value);
        },
        onReport: async () => { reports++; },
      } });
    const events: Record<string, unknown>[] = [];
    c.onDiagnostic = message => events.push(message);
    channels.push(c); await c.start();
    const wait = async (predicate: (event: Record<string, unknown>) => boolean) => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const at = events.findIndex(predicate); if (at >= 0) return events.splice(at, 1)[0];
        if (Date.now() >= deadline) throw new Error('protected-channel-timeout');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    const deadline = Date.now() + 5000;
    while (!c.sessionId) { if (Date.now() > deadline) throw new Error('binding-timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
    const request = async (op: string, payload: Record<string, unknown>) => {
      const id = randomUUID();
      assert.equal(c.input({ send: { op, id, ...payload } }), true);
      const event = await wait(e => e.op === 'response' && (e.value as { id?: string })?.id === id);
      return event.value as Record<string, any>;
    };
    const call = (file: string, content = 'approved') => ({ invocationId: randomUUID(), stage: 'PreToolUse',
      sessionId: c.sessionId!, toolName: 'Write', input: { file_path: file, content, cwd: workspace } });
    return { c, wait, request, call };
  }
  try {
    const f = await fixture();
    assert.equal(f.c.guard.verifyPeer({ pid: process.pid }, { pid: process.pid, startId: '1', bootId: '1' }, {} as never), false);
    assert.equal(f.c.input({ probePath: sentinel, port }), true);
    const probe = await f.wait(e => e.op === 'probe-result');
    assert.equal(probe.directWrite, false); assert.equal(probe.network, false); assert.equal(probe.descendantExit, 0);
    assert.equal(readFileSync(sentinel, 'utf8'), 'original'); assert.equal(existsSync(`${sentinel}.child`), false); assert.equal(connections, 0);
    results.push('real-AppContainer: direct/descendant external write and loopback network blocked');

    const allowed = f.call('allowed.txt');
    const approved = await f.request('ask', { call: allowed }); assert.ok(approved.permit);
    assert.ok(journal.length >= 2); assert.equal(existsSync(join(workspace, 'allowed.txt')), false);
    assert.equal((await f.request('execute', { call: allowed, permitId: approved.permit.id })).executed, true);
    assert.equal(readFileSync(join(workspace, 'allowed.txt'), 'utf8'), 'approved');
    assert.equal((await f.request('execute', { call: allowed, permitId: approved.permit.id })).executed, false);
    results.push('durable per-action approval -> one-shot broker consumption -> exact file bytes; replay rejected');

    const denied = await f.request('ask', { call: f.call('denied.txt', 'deny') }); assert.equal(denied.permit, null);
    assert.equal(existsSync(join(workspace, 'denied.txt')), false);
    journalHealthy = false;
    assert.equal((await f.request('ask', { call: f.call('journal-failure.txt') })).permit, null);
    journalHealthy = true;
    assert.equal(existsSync(join(workspace, 'journal-failure.txt')), false);
    results.push('deny and durable journal failure produce no permit/write');

    const original = f.call('immutable.txt'); const p = (await f.request('ask', { call: original })).permit;
    assert.equal((await f.request('execute', { call: { ...original, input: { ...original.input, content: 'changed' } }, permitId: p.id })).executed, false);
    assert.equal(existsSync(join(workspace, 'immutable.txt')), false);
    const expiring = f.call('expired.txt'); const ep = (await f.request('ask', { call: expiring })).permit;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, ep.expiresAt - Date.now() + 30)));
    assert.equal((await f.request('execute', { call: expiring, permitId: ep.id })).executed, false);
    results.push('changed action and expired permit rejected at actual side-effect boundary');

    const report = { status: 'partial', summary: 'offline broker candidate', files: [{ path: 'allowed.txt', action: 'created' }],
      tests: [{ command: 'real model/CLI', status: 'not-run' }], unresolved: [{ code: 'engine-unverified', message: 'not B04 evidence', blocking: true }] };
    const first = await f.request('report', { report }); const second = await f.request('report', { report });
    assert.equal(first.receipt, second.receipt); assert.equal(reports, 1);
    results.push('current-attempt report with real file hash; durable receipt idempotent; no EOF success');

    assert.equal((await f.request('ask', { call: f.call('after-report.txt') })).permit, null);
    await f.c.run.stop();
    const stopping = await fixture();
    const stopCall = stopping.call('stopped.txt'); assert.ok((await stopping.request('ask', { call: stopCall })).permit);
    assert.equal(stopping.c.input({ idleChild: true }), true); await stopping.wait(e => e.op === 'idle-child');
    const stopped = stopping.c.run.stop(); assert.equal(stopping.c.input({ send: { op: 'execute', call: stopCall } }), false);
    assert.equal(await stopped, true); assert.equal(existsSync(join(workspace, 'stopped.txt')), false);
    results.push('stop seals input/revokes pending allow before interruption; real non-breakaway descendant tree active=0');

    const forged = await fixture(); assert.equal(forged.c.input({ send: { op: 'report', id: randomUUID(), credential: 'forged', report } }), true);
    await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(await forged.c.run.stop(), true);
    results.push('untrusted credential closes protected channel and stops actual tree');
    const disconnected = await fixture();
    assert.equal(disconnected.c.input({ idleChild: true }), true); await disconnected.wait(e => e.op === 'idle-child');
    disconnected.c.guard.disconnectHostTransport();
    assert.equal(await disconnected.c.run.stop(), true);
    results.push('actual host transport EOF closes Job and confirms descendant tree exit');
    const cliVersions: unknown[] = [];
    for (const binary of cliProbes) {
      const probe = await fixture(binary);
      assert.equal(probe.c.input({ probeCli: true }), true);
      const actual = await probe.wait(e => e.op === 'cli-version');
      cliVersions.push({ agent: binary.agent, sha256: binary.sha256, version: actual.version, exitCode: actual.exitCode,
        evidence: 'actual native binary --version inside same AppContainer/Job; not a model/tool turn' });
      assert.equal(await probe.c.run.stop(), true);
    }
    const result = { status: 'passed', platform: `${process.platform}-${process.arch}`, node: process.version,
      boundary: 'windows-offline-broker-v1', root, helperSha256, asks, reportDeliveries: reports, results, cliVersions,
      cliEngine: 'unknown; only isolated native --version, no model/tool turn or PTY', defaultNativeAdmission: false };
    writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2)); return result;
  } finally { await Promise.all(channels.map(c => c.run.stop())); await service.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
