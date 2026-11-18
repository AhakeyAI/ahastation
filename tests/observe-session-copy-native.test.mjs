import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { probeCodexSessionCopy } from '../scripts/probe-codex-session-copy.mjs';

function bundledBinary() {
  if (process.env.AHASTATION_S5_CODEX_BINARY) return process.env.AHASTATION_S5_CODEX_BINARY;
  const os = process.platform, arch = process.arch;
  if (!['win32', 'linux', 'darwin'].includes(os) || !['x64', 'arm64'].includes(arch)) return null;
  try {
    const root = dirname(createRequire(import.meta.url).resolve(`@openai/codex-${os}-${arch}/package.json`));
    const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64';
    const triple = os === 'win32' ? `${cpu}-pc-windows-msvc` : os === 'darwin' ? `${cpu}-apple-darwin` : `${cpu}-unknown-linux-musl`;
    const path = join(root, 'vendor', triple, 'bin', os === 'win32' ? 'codex.exe' : 'codex');
    return existsSync(path) ? path : null;
  } catch { return null; }
}
const binary = bundledBinary();
test('real verified Codex forks only a synthetic prepared copy with no model turn or user credentials', {
  timeout: 90_000, skip: binary ? false : 'bundled native Codex is absent; set AHASTATION_S5_CODEX_BINARY to a verified executable',
}, async () => {
  const evidence = await probeCodexSessionCopy(binary);
  assert.equal(evidence.sourceUnchanged, true); assert.equal(evidence.backupVerified, true);
  assert.equal(evidence.newSessionId, true); assert.equal(evidence.historyCopied, true); assert.equal(evidence.persistedThreadReadable, true);
  assert.equal(evidence.inputCopyUnchanged, true); assert.equal(evidence.modelTurns, 0);
  assert.equal(evidence.authenticatedRequests, 0); assert.equal(evidence.networkAccess, false);
  assert.deepEqual(evidence.requests, ['initialize', 'thread/fork', 'thread/read']);
});
