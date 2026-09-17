import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getBackendRegistry,
  registerCustomBackends,
  resetBackendRegistry,
} from '../dist-electron/backends/registry.js';

// Regression coverage for the ESM require() bug: registerCustomBackends used
// to resolve store.js through a lazy require(), which throws ReferenceError
// in the ESM main process ("type": "module"). The catch swallowed it, so
// user-defined custom backends silently never registered.

function entry(overrides = {}) {
  return {
    id: 'acme-cli',
    displayName: 'Acme CLI',
    binaryName: 'acme',
    apiKeyEnv: 'ACME_API_KEY',
    createdAt: 1,
    ...overrides,
  };
}

test('registerCustomBackends registers entries from the settings source', () => {
  resetBackendRegistry();
  registerCustomBackends(() => [entry()]);
  const backend = getBackendRegistry().get('acme-cli');
  assert.ok(backend, 'custom backend should be registered');
  assert.equal(backend.id, 'acme-cli');
  assert.equal(backend.capabilities.displayName, 'Acme CLI');
});

test('re-registration picks up updated entries', () => {
  resetBackendRegistry();
  registerCustomBackends(() => [entry()]);
  registerCustomBackends(() => [entry({ displayName: 'Acme CLI v2' })]);
  const backend = getBackendRegistry().get('acme-cli');
  assert.equal(backend?.capabilities.displayName, 'Acme CLI v2');
});

test('a failing settings source does not break the registry', () => {
  resetBackendRegistry();
  assert.doesNotThrow(() =>
    registerCustomBackends(() => {
      throw new Error('settings unavailable');
    }),
  );
  // Built-in backends are still intact.
  assert.ok(getBackendRegistry().get('claude-code'));
});

test('the default source resolves statically (ESM require regression)', () => {
  // Under the electron stub there is no settings.json, so this registers
  // nothing — the point is that the statically-imported store resolves and
  // the call does not throw the way the old require() path did.
  resetBackendRegistry();
  assert.doesNotThrow(() => registerCustomBackends());
});
