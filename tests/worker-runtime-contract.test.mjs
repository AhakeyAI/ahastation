import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assessWorkerRelease,
  assessWorkerRuntime,
  assessConfiguredWorkerRuntime,
  extractRuntimeVersion,
  probeWorkerRuntimeVersion,
  probeWorkerRuntimeVersionAsync,
  resolveWorkerExpectedVersion,
  workerVersionProbeTimeoutMs,
} from '../dist-electron/backends/worker-runtime-contract.js';

const SLOW_VERSION_FIXTURE = fileURLToPath(new URL('./fixtures/worker-runtime/slow-version.mjs', import.meta.url));

test('runtime versions are extracted from common CLI output', () => {
  assert.equal(extractRuntimeVersion('codex-cli 0.156.1'), '0.156.1');
  assert.equal(extractRuntimeVersion('Claude Code v2.1.150 (stable)'), '2.1.150');
  assert.equal(extractRuntimeVersion('unknown'), null);
});

test('Worker runtime gate fails closed for missing, incompatible and unauthenticated runtimes', () => {
  assert.equal(assessWorkerRuntime({
    backendId: 'codex', installed: false, implementationEnabled: true,
    authenticated: false, version: null,
  }).state, 'needs-install');
  assert.equal(assessWorkerRuntime({
    backendId: 'codex', installed: true, implementationEnabled: true,
    authenticated: true, version: '0.145.0',
  }).state, 'version-incompatible');
  assert.equal(assessWorkerRuntime({
    backendId: 'codex', installed: true, implementationEnabled: true,
    authenticated: false, version: '0.156.1',
  }).state, 'needs-login');
});

test('Worker runtime becomes available at each backend verified version with authentication', () => {
  for (const [backendId, version] of [
    ['claude-code', '2.1.150'],
    ['opencode', '1.18.3'],
    ['codex', '0.156.1'],
    ['kimi', '0.24.1'],
  ]) {
    const result = assessWorkerRuntime({
      backendId,
      installed: true,
      implementationEnabled: true,
      authenticated: true,
      version,
    });
    assert.equal(result.state, 'available', backendId);
    assert.equal(
      result.expectedVersion,
      backendId === 'codex' ? '>=0.156.1 <0.157.0' : version,
      backendId,
    );
  }
});

test('system Claude Code CLI accepts the probed version instead of the bundled pin', () => {
  assert.equal(
    resolveWorkerExpectedVersion('claude-code', '2.1.215', { claudeCodeCliSource: 'system' }),
    '2.1.215',
  );
  assert.equal(
    resolveWorkerExpectedVersion('claude-code', '2.1.215', { claudeCodeCliSource: 'bundled' }),
    '2.1.150',
  );
  const result = assessWorkerRuntime({
    backendId: 'claude-code',
    installed: true,
    implementationEnabled: true,
    authenticated: true,
    version: '2.1.215',
    expectedVersionOverride: '2.1.215',
  });
  assert.equal(result.state, 'available');
  assert.equal(result.expectedVersion, '2.1.215');
});

test('assessConfiguredWorkerRuntime accepts system Claude versions at dispatch time', () => {
  const result = assessConfiguredWorkerRuntime({
    backendId: 'claude-code',
    installed: true,
    implementationEnabled: true,
    authenticated: true,
    version: '2.1.215',
    claudeCodeCliSource: 'system',
  });
  assert.equal(result.state, 'available');
  assert.equal(result.expectedVersion, '2.1.215');
});

test('Codex dispatch and real evidence accept the shared verified interval', () => {
  const expectedRuntimeVersion = resolveWorkerExpectedVersion('codex', '0.156.2');
  assert.equal(expectedRuntimeVersion, '>=0.156.1 <0.157.0');
  assert.equal(assessWorkerRuntime({
    backendId: 'codex', installed: true, implementationEnabled: true,
    authenticated: true, version: '0.156.2',
  }).state, 'available');
  assert.equal(assessWorkerRuntime({
    backendId: 'codex', installed: true, implementationEnabled: true,
    authenticated: true, version: '0.157.0',
  }).state, 'version-incompatible');
  const release = assessWorkerRelease({
    backendId: 'codex',
    implementationEnabled: true,
    expectedRuntimeVersion,
    evidence: {
      runtimeCompatible: true,
      authReady: true,
      profileCompilation: true,
      workReport: true,
      interrupt: true,
      resume: true,
      permissionBridge: true,
      canonicalPermissionNormalization: true,
      recovery: true,
      realVerticalSmoke: {
        schemaVersion: 1,
        kind: 'real-backend-smoke',
        backendId: 'codex',
        runtimeVersion: '0.156.2',
        runId: 'p9-interval',
        verifiedAt: '2026-10-27T00:00:00Z',
        checks: ['work-report', 'interrupt', 'resume', 'permission-bridge', 'canonical-permission-normalization', 'recovery'],
      },
    },
  });
  assert.equal(release.tier, 'stable');
});

test('Worker version probes allow slow runtimes by default and honor an explicit timeout', async () => {
  assert.equal(workerVersionProbeTimeoutMs(), 10_000);
  assert.equal(workerVersionProbeTimeoutMs(40_000), 30_000);
  assert.equal(probeWorkerRuntimeVersion('codex', SLOW_VERSION_FIXTURE), '0.156.2');
  assert.equal(await probeWorkerRuntimeVersionAsync('codex', SLOW_VERSION_FIXTURE), '0.156.2');
  assert.equal(probeWorkerRuntimeVersion('codex', SLOW_VERSION_FIXTURE, { timeoutMs: 25 }), null);
  assert.equal(await probeWorkerRuntimeVersionAsync('codex', SLOW_VERSION_FIXTURE, { timeoutMs: 25 }), null);
});
