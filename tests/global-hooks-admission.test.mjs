import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeTerminalBackend } from '../dist-electron/backends/claude-terminal-adapter.js';
import { CodexTerminalBackend } from '../dist-electron/backends/codex-terminal-adapter.js';

test('controlled native tasks fail before binary resolution, file writes, PTY spawn or queued prompt injection', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aha85-admission-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const Backend of [ClaudeTerminalBackend, CodexTerminalBackend]) {
    for (const config of [{ executionRole: 'worker' }, { taskProfile: {} }]) {
      let sideEffects = 0;
      const backend = new Backend({ host: { spawn() { sideEffects++; throw new Error('must not spawn'); }, kill() {} },
        resolveBinary() { sideEffects++; throw new Error('must not resolve'); }, timersEnabled: false });
      const session = backend.createSession({ cwd: root, ...config }, () => {});
      session.sendUserText('must never be injected');
      await assert.rejects(session.start(), /unsupported-contract/);
      assert.equal(sideEffects, 0);
      assert.equal(existsSync(join(root, '.aha')), false);
      session.end();
    }
  }
});
