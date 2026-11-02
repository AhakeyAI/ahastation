// Regression coverage for the Codex session-model rule: a Codex session must
// receive ONLY the model configured in user settings. Without one, no model
// override reaches the CLI, so Codex falls back to ~/.codex/config.toml's own
// `model`. The talker's Claude-centric fallback ('claude-haiku-4-5') and
// compiled task profiles must never leak into a Codex session — a model the
// configured provider doesn't serve fails the turn with an empty error.
//
// Run after `npm run build:electron`:
//   node --test --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" tests/orchestrator-model-resolution.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { Orchestrator } from '../dist-electron/orchestrator.js';
import { getBackendRegistry } from '../dist-electron/backends/registry.js';
import { setBackendAuth, updateSettings } from '../dist-electron/store.js';
import { testSettingsPath } from './electron-stub-impl.mjs';

const SETTINGS_PATH = testSettingsPath();

function preserveSettingsFile(t) {
  const prior = existsSync(SETTINGS_PATH) ? readFileSync(SETTINGS_PATH) : null;
  t.after(() => {
    if (prior) writeFileSync(SETTINGS_PATH, prior);
    else rmSync(SETTINGS_PATH, { force: true });
  });
}

function makeFakeBackend(id, captured) {
  return {
    id,
    capabilities: {
      coordinate: true,
      executeTasks: true,
      mcp: false,
      permissions: true,
      systemPrompt: true,
      skills: false,
      interrupt: true,
      defaultModel: `${id}-default`,
      models: [],
    },
    resolveBinary: () => `/fake/${id}`,
    buildEnv: (_auth, extra) => ({ ...(extra ?? {}) }),
    async validateAuth() { return { ok: true }; },
    async checkAuthStatus() { return { loggedIn: true }; },
    compileTaskProfile(requested) { return requested; },
    createSession(config) {
      captured.push(config);
      return { start() {}, end() {} };
    },
  };
}

function effectiveProfile(model, backendId = 'codex') {
  return {
    schemaVersion: 1,
    backendId,
    runtimeVersion: '0.156.1',
    model,
    unsupported: [],
    downgraded: [],
    capabilityHash: 'a'.repeat(64),
  };
}

function installFakeBackends(t) {
  const registry = getBackendRegistry();
  const captured = { codex: [], 'claude-code': [] };
  const originals = new Map();
  for (const id of Object.keys(captured)) {
    originals.set(id, registry.get(id));
    registry.unregister(id);
    registry.register(makeFakeBackend(id, captured[id]));
  }
  t.after(() => {
    for (const [id, backend] of originals) {
      registry.unregister(id);
      registry.register(backend);
    }
  });
  return captured;
}

function sessionModelFor(orch, backendId, sessionOptions) {
  // buildSessionFactory is TS-private but a plain method at runtime.
  const factory = orch.buildSessionFactory(backendId);
  factory({ cwd: '/tmp', autoApproveScope: 'off', sessionOptions, emit: () => {} });
}

test('Codex gets no model override when settings have none (config.toml fallback)', async (t) => {
  preserveSettingsFile(t);
  const captured = installFakeBackends(t);
  await updateSettings({ backendAuth: [] });
  const orch = new Orchestrator({ emit: () => {}, cwd: '/tmp' });

  // The talker's Claude-centric fallback must not reach the Codex session.
  sessionModelFor(orch, 'codex', { model: 'claude-haiku-4-5' });
  assert.equal(captured.codex.length, 1);
  assert.equal(captured.codex[0].model, undefined);

  // Neither may a compiled task profile's model.
  sessionModelFor(orch, 'codex', {
    model: 'claude-haiku-4-5',
    taskProfile: effectiveProfile('gpt-5.4'),
  });
  assert.equal(captured.codex.length, 2);
  assert.equal(captured.codex[1].model, undefined);
});

test('Codex honors the settings model above every other source', async (t) => {
  preserveSettingsFile(t);
  const captured = installFakeBackends(t);
  await setBackendAuth('codex', { authMode: 'none', model: 'gpt-5.6-sol' });
  const orch = new Orchestrator({ emit: () => {}, cwd: '/tmp' });

  sessionModelFor(orch, 'codex', { model: 'claude-haiku-4-5' });
  assert.equal(captured.codex[0].model, 'gpt-5.6-sol');

  sessionModelFor(orch, 'codex', {
    model: 'claude-haiku-4-5',
    taskProfile: effectiveProfile('gpt-5.4'),
  });
  assert.equal(captured.codex[1].model, 'gpt-5.6-sol');
});

test('Other backends keep their existing model resolution', async (t) => {
  preserveSettingsFile(t);
  const captured = installFakeBackends(t);
  await updateSettings({ backendAuth: [] });
  const orch = new Orchestrator({ emit: () => {}, cwd: '/tmp' });

  // No settings model: the requested (talker) model passes through.
  sessionModelFor(orch, 'claude-code', { model: 'claude-haiku-4-5' });
  assert.equal(captured['claude-code'][0].model, 'claude-haiku-4-5');

  // A compiled task profile still wins for non-Codex backends.
  sessionModelFor(orch, 'claude-code', {
    model: 'claude-haiku-4-5',
    taskProfile: effectiveProfile('claude-sonnet-4-5', 'claude-code'),
  });
  assert.equal(captured['claude-code'][1].model, 'claude-sonnet-4-5');
});
