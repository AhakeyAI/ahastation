import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, safeStorage } from 'electron';
import { StationService } from '../dist-electron/collaboration/station-service.js';
import { encryptDeviceCredential, decryptDeviceCredential } from '../dist-electron/collaboration/device-credential.js';

const gate = () => {
  let release;
  const promise = new Promise((done) => { release = done; });
  return { promise, release };
};

async function fixture(settings, run) {
  const root = await mkdtemp(join(tmpdir(), 'async-credentials-'));
  const old = { getPath: app.getPath, isReady: app.isReady, ...safeStorage };
  app.getPath = () => root;
  app.isReady = () => true;
  safeStorage.isAsyncEncryptionAvailable = async () => true;
  safeStorage.encryptStringAsync = async (value) => Buffer.from('sealed:' + value);
  safeStorage.decryptStringAsync = async (value) => ({ result: value.toString().slice(7), shouldReEncrypt: false });
  try {
    if (settings) await writeFile(join(root, 'settings.json'), JSON.stringify(settings));
    const store = await import('../dist-electron/store.js?fixture=' + randomUUID());
    await run({ root, store, disk: async () => JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')) });
    await store.flushSettingsWrites();
  } finally {
    app.getPath = old.getPath;
    app.isReady = old.isReady;
    for (const key of Object.keys(safeStorage)) if (!(key in old)) delete safeStorage[key];
    const { getPath, isReady, ...storage } = old;
    Object.assign(safeStorage, storage);
    assert.equal(resolve(dirname(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('async-credentials-'));
    await rm(root, { recursive: true, force: true });
  }
}

test('startup warms API and remote credentials asynchronously before synchronous readers use them', async () => {
  await fixture({
    anthropicApiKeyEnc: Buffer.from('sealed:anthropic-secret').toString('base64'),
    backendAuth: [{ backendId: 'codex', authMode: 'apikey', apiKeyEnc: Buffer.from('sealed:codex-secret').toString('base64') }],
    remoteControl: { enabled: true, mode: 'public', ownerId: 'owner-A', serviceUrl: 'https://fixture.invalid', controlTokenEnc: Buffer.from('sealed:control-secret').toString('base64') },
  }, async ({ store, disk }) => {
    let decryptions = 0;
    safeStorage.decryptStringAsync = async (value) => {
      decryptions += 1;
      return { result: value.toString().slice(7), shouldReEncrypt: false };
    };
    assert.equal(store.getSettings().remoteControl.controlToken, undefined);
    assert.equal(store.remoteCredentialStorageAvailable(), false);
    assert.equal(decryptions, 0);
    await store.warmSecrets();
    assert.equal(store.getSettings().anthropicApiKey, 'anthropic-secret');
    assert.equal(store.getBackendAuth('codex').apiKey, 'codex-secret');
    assert.equal(store.getSettings().remoteControl.controlToken, 'control-secret');
    assert.equal(store.remoteCredentialStorageAvailable(), true);
    assert.equal(decryptions, 3);
    store.getSettings(); store.listBackendAuth();
    assert.equal(decryptions, 3, 'synchronous reads must never invoke the OS decryptor');
    await store.updateSettings({ reportModeEnabled: true });
    const saved = await disk();
    assert.equal(saved.remoteControl.controlToken, undefined);
    assert.equal(saved.anthropicApiKey, undefined);
    assert.equal(saved.backendAuth[0].apiKey, undefined);
    await store.setBackendAuth('codex', { apiKey: 'replacement-codex-secret' });
    assert.equal(store.getBackendAuth('codex').apiKey, 'replacement-codex-secret');
    await store.setBackendAuth('codex', { apiKey: undefined });
    assert.equal(store.getBackendAuth('codex').apiKey, undefined);
    assert.equal((await disk()).backendAuth[0].apiKeyEnc, undefined);
  });
});

test('failed OS decryption and encryption preserve existing ciphertext until an explicit clear', async () => {
  const cipher = Buffer.from('unreadable-original').toString('base64');
  await fixture({ remoteControl: { enabled: true, mode: 'public', ownerId: 'owner-A', serviceUrl: 'https://fixture.invalid', controlTokenEnc: cipher } }, async ({ store, disk }) => {
    safeStorage.decryptStringAsync = async () => { throw new Error('owned OS error'); };
    await store.warmSecrets();
    assert.equal(store.getSettings().remoteControl.controlToken, undefined);
    await store.updateSettings({ reportModeEnabled: true });
    assert.equal((await disk()).remoteControl.controlTokenEnc, cipher);
    safeStorage.encryptStringAsync = async () => { throw new Error('owned encryption failure'); };
    await store.updateRemoteControlFields((current) => ({ ...current, controlToken: 'new-memory-only-secret' }));
    const saved = await disk();
    assert.equal(saved.remoteControl.controlTokenEnc, cipher);
    assert.equal(saved.remoteControl.controlToken, undefined);
    await store.updateRemoteControlFields(({ controlToken, controlTokenEnc, ...rest }) => rest);
    assert.equal((await disk()).remoteControl.controlTokenEnc, undefined);
  });
});

test('legacy encrypted Anthropic settings migrate into backend auth after startup decryption', async () => {
  const cipher = Buffer.from('sealed:legacy-encrypted-key').toString('base64');
  await fixture({ authMode: 'apikey', anthropicApiKeyEnc: cipher }, async ({ store, disk }) => {
    await store.warmSecrets();
    await store.flushSettingsWrites();
    assert.equal(store.getBackendAuth('claude-code').apiKey, 'legacy-encrypted-key');
    assert.equal(store.getSettings().anthropicApiKey, 'legacy-encrypted-key');
    assert.equal((await disk()).backendAuth[0].apiKey, undefined);
    assert.ok((await disk()).backendAuth[0].apiKeyEnc);
  });
});

test('a later encryption outage retains the ciphertext written by a successful login', async () => {
  await fixture(null, async ({ store, disk }) => {
    await store.updateRemoteControlFields(() => ({ enabled: true, mode: 'public', ownerId: 'owner-A', serviceUrl: 'https://fixture.invalid', controlToken: 'login-secret' }));
    await store.setBackendAuth('codex', { authMode: 'apikey', apiKey: 'api-secret' });
    const before = await disk();
    safeStorage.isAsyncEncryptionAvailable = async () => false;
    await store.updateSettings({ reportModeEnabled: true });
    const after = await disk();
    assert.equal(after.remoteControl.controlTokenEnc, before.remoteControl.controlTokenEnc);
    assert.equal(after.backendAuth[0].apiKeyEnc, before.backendAuth[0].apiKeyEnc);
    assert.equal(after.remoteControl.controlToken, undefined);
    assert.equal(after.backendAuth[0].apiKey, undefined);
  });
});

test('repeated writes and logout release old decrypted ciphertexts instead of reviving them from cache', async () => {
  await fixture(null, async ({ store, disk }) => {
    let serial = 0;
    safeStorage.encryptStringAsync = async (token) => Buffer.from('sealed-' + (++serial) + ':' + token);
    await store.updateRemoteControlFields(() => ({ enabled: true, mode: 'public', ownerId: 'owner-A', serviceUrl: 'https://fixture.invalid', controlToken: 'login-secret' }));
    const original = (await disk()).remoteControl.controlTokenEnc;
    for (let index = 0; index < 4; index += 1) await store.updateSettings({ reportModeEnabled: index % 2 === 0 });
    const latest = (await disk()).remoteControl.controlTokenEnc;
    assert.notEqual(latest, original);
    let decryptions = 0;
    safeStorage.decryptStringAsync = async () => { decryptions += 1; throw new Error('OS refuses stale ciphertext'); };
    await store.updateRemoteControlFields(({ controlToken, ...current }) => ({ ...current, controlTokenEnc: original }));
    await store.warmSecrets();
    assert.equal(store.getSettings().remoteControl.controlToken, undefined, 'old write must not survive in the decrypt cache');
    assert.equal(decryptions, 1);
    await store.updateRemoteControlFields((current) => ({ ...current, controlToken: 'new-login-secret', controlTokenEnc: undefined }));
    const beforeLogout = (await disk()).remoteControl.controlTokenEnc;
    await store.updateRemoteControlFields(({ controlToken, controlTokenEnc, ...current }) => current);
    await store.updateRemoteControlFields((current) => ({ ...current, controlTokenEnc: beforeLogout }));
    await store.warmSecrets();
    assert.equal(store.getSettings().remoteControl.controlToken, undefined, 'logout must release the last decrypted token');
    assert.equal(decryptions, 2);
  });
});

test('startup re-encrypts rotated secrets and migrates legacy API keys without plaintext persistence', async () => {
  const cipher = Buffer.from('old:control-secret').toString('base64');
  await fixture({ anthropicApiKey: 'legacy-api-secret', remoteControl: { enabled: true, mode: 'public', ownerId: 'owner-A', serviceUrl: 'https://fixture.invalid', controlTokenEnc: cipher } }, async ({ store, disk }) => {
    safeStorage.decryptStringAsync = async () => ({ result: 'control-secret', shouldReEncrypt: true });
    await store.warmSecrets();
    await store.flushSettingsWrites();
    const saved = await disk();
    assert.notEqual(saved.remoteControl.controlTokenEnc, cipher);
    assert.equal(saved.remoteControl.controlToken, undefined);
    assert.equal(saved.anthropicApiKey, undefined);
    assert.ok(saved.anthropicApiKeyEnc);
    assert.equal(store.getSettings().remoteControl.controlToken, 'control-secret');
    assert.equal(store.getBackendAuth('claude-code').apiKey, 'legacy-api-secret');
  });
});

test('late startup decrypt cannot restore a previous account after a queued account change', async () => {
  const cipher = Buffer.from('sealed:old-control').toString('base64');
  await fixture({ remoteControl: { enabled: true, mode: 'public', ownerId: 'owner-A', serviceUrl: 'https://fixture.invalid', controlTokenEnc: cipher } }, async ({ store, disk }) => {
    const entered = gate(), release = gate();
    safeStorage.decryptStringAsync = async (value) => {
      entered.release(); await release.promise;
      return { result: value.toString().slice(7), shouldReEncrypt: false };
    };
    const warming = store.warmSecrets();
    await entered.promise;
    const switching = store.updateRemoteControlFields(() => ({ enabled: true, mode: 'public', ownerId: 'owner-B', serviceUrl: 'https://fixture.invalid', controlToken: 'new-control' }));
    release.release();
    await Promise.all([warming, switching]);
    assert.equal(store.getSettings().remoteControl.ownerId, 'owner-B');
    assert.equal(store.getSettings().remoteControl.controlToken, 'new-control');
    assert.equal((await disk()).remoteControl.ownerId, 'owner-B');
    assert.equal((await disk()).remoteControl.controlTokenEnc, Buffer.from('sealed:new-control').toString('base64'));
  });
});

test('async device credential encryption cannot overwrite a newly selected account', async () => {
  await fixture(null, async ({ root }) => {
    const service = new StationService(join(root, 'station'));
    await service.storage.load();
    await service.storage.update((state) => { state.ownerId = 'new-owner'; state.tokenEnc = 'new-owner-cipher'; });
    let current = true;
    const entered = gate(), release = gate();
    safeStorage.encryptStringAsync = async (token) => { entered.release(); await release.promise; return Buffer.from('sealed:' + token); };
    const saving = service.saveDeviceCredential('old-token', 'old-owner', 'https://fixture.invalid', () => current);
    await entered.promise; current = false; release.release();
    await assert.rejects(saving, /旧账号或连接/);
    assert.equal(service.storage.read().ownerId, 'new-owner');
    assert.equal(service.storage.read().tokenEnc, 'new-owner-cipher');
    const saved = JSON.parse(await readFile(service.storage.file, 'utf8'));
    assert.equal(saved.ownerId, 'new-owner');
    assert.equal(saved.tokenEnc, 'new-owner-cipher');
  });
});

test('device credential helpers reject an unavailable async keychain without sync fallback', async () => {
  await fixture(null, async () => {
    safeStorage.isAsyncEncryptionAvailable = async () => false;
    const binding = { ownerId: 'fixture-owner', deviceId: 'fixture-device', serviceUrl: 'https://fixture.invalid' };
    await assert.rejects(encryptDeviceCredential('fixture-secret', binding), /secure-storage-unavailable/);
    await assert.rejects(decryptDeviceCredential(Buffer.from('fixture').toString('base64'), binding), /secure-storage-unavailable/);
  });
});
