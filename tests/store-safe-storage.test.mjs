import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import electron from 'electron';

// Fake OS encryptor: "v1:" is ciphertext from an older key (the OS asks for a
// re-encrypt), "v2:" is current. The deprecated sync API must never be used.
function installFakeSafeStorage({ available = true } = {}) {
  const calls = { encrypt: 0 };
  Object.assign(electron.safeStorage, {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (plain) => { calls.encrypt += 1; return Buffer.from(`v2:${plain}`); },
    decryptStringAsync: async (buf) => {
      const s = buf.toString();
      if (s.startsWith('v1:')) return { result: s.slice(3), shouldReEncrypt: true };
      if (s.startsWith('v2:')) return { result: s.slice(3), shouldReEncrypt: false };
      throw new Error('bad ciphertext');
    },
    encryptString: () => { throw new Error('sync encryptString used'); },
    decryptString: () => { throw new Error('sync decryptString used'); },
    isEncryptionAvailable: () => { throw new Error('sync isEncryptionAvailable used'); },
  });
  return calls;
}

const b64 = (s) => Buffer.from(s).toString('base64');
let seq = 0;

// Each case gets its own userData dir and a fresh store module instance.
async function freshStore(t, initial) {
  const dir = mkdtempSync(join(tmpdir(), 'aha-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  electron.app.getPath = () => dir;
  if (initial) writeFileSync(join(dir, 'settings.json'), JSON.stringify(initial));
  const store = await import(`../dist-electron/store.js?case=${++seq}`);
  const onDisk = () => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
  return { store, onDisk };
}

test('warmSecrets decrypts ciphertext written by the old sync API', async (t) => {
  installFakeSafeStorage();
  const { store } = await freshStore(t, {
    anthropicApiKeyEnc: b64('v2:sk-anthropic'),
    backendAuth: [{ backendId: 'codex', authMode: 'api-key', apiKeyEnc: b64('v2:sk-codex') }],
  });
  assert.equal(store.getSettings().anthropicApiKey, undefined, 'nothing is decrypted before warmSecrets');
  await store.warmSecrets();
  assert.equal(store.getSettings().anthropicApiKey, 'sk-anthropic');
  assert.equal(store.getBackendAuth('codex')?.apiKey, 'sk-codex');
  assert.equal(store.listBackendAuth()[0]?.apiKey, 'sk-codex');
});

test('writes keep keys encrypted on disk and readable in memory', async (t) => {
  installFakeSafeStorage();
  const { store, onDisk } = await freshStore(t);
  await store.warmSecrets();
  await store.setBackendAuth('claude-code', { authMode: 'api-key', apiKey: 'sk-new' });
  await store.updateSettings({ anthropicApiKey: 'sk-top' });
  const disk = onDisk();
  assert.equal(disk.anthropicApiKey, undefined);
  assert.equal(disk.anthropicApiKeyEnc, b64('v2:sk-top'));
  assert.equal(disk.backendAuth[0].apiKey, undefined);
  assert.equal(disk.backendAuth[0].apiKeyEnc, b64('v2:sk-new'));
  assert.equal(store.getBackendAuth('claude-code')?.apiKey, 'sk-new');
  assert.equal(store.getSettings().anthropicApiKey, 'sk-top');
});

test('values flagged shouldReEncrypt are rewritten with the current key', async (t) => {
  installFakeSafeStorage();
  const { store, onDisk } = await freshStore(t, {
    anthropicApiKeyEnc: b64('v1:sk-old'),
    backendAuth: [{ backendId: 'codex', authMode: 'api-key', apiKeyEnc: b64('v1:sk-codex') }],
  });
  await store.warmSecrets();
  const disk = onDisk();
  assert.equal(disk.anthropicApiKeyEnc, b64('v2:sk-old'));
  assert.equal(disk.backendAuth[0].apiKeyEnc, b64('v2:sk-codex'));
  assert.equal(store.getBackendAuth('codex')?.apiKey, 'sk-codex');
});

test('a legacy plaintext key on disk is migrated to ciphertext', async (t) => {
  installFakeSafeStorage();
  const { store, onDisk } = await freshStore(t, {
    anthropicApiKey: 'sk-plain',
    backendAuth: [{ backendId: 'claude-code', authMode: 'api-key' }],
  });
  await store.warmSecrets();
  const disk = onDisk();
  assert.equal(disk.anthropicApiKey, undefined);
  assert.equal(disk.anthropicApiKeyEnc, b64('v2:sk-plain'));
  assert.equal(store.getSettings().anthropicApiKey, 'sk-plain');
});

test('undecryptable ciphertext survives unrelated writes', async (t) => {
  installFakeSafeStorage();
  const { store, onDisk } = await freshStore(t, {
    anthropicApiKeyEnc: b64('garbage'),
    backendAuth: [{ backendId: 'codex', authMode: 'api-key', apiKeyEnc: b64('garbage-codex') }],
  });
  await store.warmSecrets();
  assert.equal(store.getSettings().anthropicApiKey, undefined);
  assert.equal(store.getBackendAuth('codex')?.apiKey, undefined);
  await store.updateSettings({ voiceLockEnabled: true });
  const disk = onDisk();
  assert.equal(disk.anthropicApiKeyEnc, b64('garbage'));
  assert.equal(disk.backendAuth[0].apiKeyEnc, b64('garbage-codex'));
});

test('without OS encryption a key is never written as plaintext', async (t) => {
  installFakeSafeStorage({ available: false });
  const { store, onDisk } = await freshStore(t);
  await store.warmSecrets();
  await store.updateSettings({ anthropicApiKey: 'sk-memory-only' });
  await store.setBackendAuth('codex', { authMode: 'api-key', apiKey: 'sk-codex-memory' });
  const raw = JSON.stringify(onDisk());
  assert.ok(!raw.includes('sk-memory-only'));
  assert.ok(!raw.includes('sk-codex-memory'));
  assert.equal(store.getSettings().anthropicApiKey, 'sk-memory-only');
});
