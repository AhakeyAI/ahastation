// Test entry only: real safeStorage and production store, no app window or login.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, safeStorage, net } from 'electron';

async function main() {
  const [outputArg, phase] = process.argv.slice(2);
  const output = resolve(outputArg), profile = join(output, 'profile');
  assert.equal(profile, process.env.AHASTATION_USER_DATA_DIR);
  app.setName('AhaStation Credential Probe');
  app.setPath('userData', profile);
  app.setPath('sessionData', join(profile, 'session'));
  app.disableHardwareAcceleration();
  console.log(JSON.stringify({ phase, step: 'isolated-paths-configured' }));
  const marker = JSON.parse(await readFile(join(output, 'probe.json'), 'utf8'));
  const token = process.env.AHASTATION_CREDENTIAL_PROBE_TOKEN;
  assert.ok(token?.startsWith('generated-credential-probe-'));
  assert.equal(marker.nonce, process.env.AHASTATION_CREDENTIAL_PROBE_NONCE);
  assert.equal(createHash('sha256').update(token).digest('hex'), marker.tokenHash);
  assert.ok(['write', 'read'].includes(phase));
  await app.whenReady();
  console.log(JSON.stringify({ phase, step: 'electron-ready' }));
  app.dock?.hide();
  assert.equal(process.versions.electron.split('.')[0], '45', 'Use the candidate Electron 45 runtime');
  let networkRequests = 0;
  const rejectNetwork = () => {
    networkRequests += 1;
    throw new Error('The credential probe must not make network requests');
  };
  globalThis.fetch = rejectNetwork;
  net.fetch = rejectNetwork;
  const store = await import('../../dist-electron/store.js');
  const { getRemoteControlSettings } = await import('../../dist-electron/remote-control.js');
  assert.notEqual(process.env.AHASTATION_ENABLE_COLLABORATION, '1');
  assert.equal(store.getSettings().remoteControl?.enabled ?? false, false);
  assert.equal(getRemoteControlSettings().controlToken, undefined, 'No plaintext cache before warmSecrets');
  await store.warmSecrets();
  const secureStorage = store.remoteCredentialStorageAvailable();
  const available = await safeStorage.isAsyncEncryptionAvailable();
  if (phase === 'write') {
    await store.updateRemoteControlFields(() => ({ enabled: false, mode: 'public',
      ownerId: 'generated-probe-owner', serviceUrl: 'https://credential-probe.invalid', controlToken: token }));
    assert.ok(getRemoteControlSettings().controlToken === token, 'Production in-memory credential read');
  } else {
    assert.ok(getRemoteControlSettings().controlToken === (secureStorage ? token : undefined),
      'Fresh warmSecrets restores encrypted credentials only');
  }
  await store.flushSettingsWrites();
  const text = await readFile(join(profile, 'settings.json'), 'utf8');
  const disk = JSON.parse(text), cipher = disk.remoteControl?.controlTokenEnc;
  assert.equal(text.includes(token), false, 'Generated token must never be plaintext on disk');
  assert.equal(Object.hasOwn(disk.remoteControl, 'controlToken'), false);
  assert.equal(disk.remoteControl.enabled, false);
  if (secureStorage) {
    assert.ok(typeof cipher === 'string' && cipher.length > 0);
    const bytes = Buffer.from(cipher, 'base64');
    assert.equal(bytes.toString('base64'), cipher, 'Production base64 ciphertext format');
    const decrypted = await safeStorage.decryptStringAsync(bytes);
    assert.ok(decrypted.result === token, 'Actual OS decrypts the stored production ciphertext');
  } else assert.equal(cipher, undefined, 'Unavailable storage persists no reusable secret');
  assert.equal(networkRequests, 0);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  await writeFile(join(output, phase + '.json'), JSON.stringify({ phase, pid: process.pid,
    platform: process.platform, electron: process.versions.electron, node: process.versions.node,
    secureStorage, asyncEncryptionAvailable: available,
    storageBackend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os-protected',
    plaintextOnDisk: false, diskFormat: cipher ? 'base64-os-ciphertext' : 'no-secret',
    warmedRead: phase === 'read' && secureStorage, memoryOnlyFallback: !secureStorage,
    remoteControlEnabled: disk.remoteControl.enabled, networkRequests, windowsCreated: 0,
  }, null, 2));
}
// Do not await readiness during Electron's ESM main-module loading.
void main().then(() => app.quit()).catch(error => {
  console.error(error.stack);
  app.exit(1);
});
