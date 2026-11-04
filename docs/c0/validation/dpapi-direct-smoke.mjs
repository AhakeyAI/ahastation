import { app, BrowserWindow, safeStorage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SENTINEL = 'ahastation-dpapi-smoke-not-a-real-key';
const args = process.argv.slice(2);
const mode = args[args.indexOf('--mode') + 1];
const userData = args[args.indexOf('--user-data') + 1];
const storePath = args[args.indexOf('--store') + 1];
app.setPath('userData', userData);
mkdirSync(userData, { recursive: true });
const settingsPath = join(userData, 'settings.json');
app.on('ready', async () => {
  const window = new BrowserWindow({ show: false });
  if (mode === 'encrypt') {
    const ciphertext = safeStorage.encryptString(SENTINEL).toString('base64');
    writeFileSync(settingsPath, JSON.stringify({
      anthropicApiKeyEnc: ciphertext,
      backendAuth: [{ backendId: 'codex', authMode: 'apikey', apiKeyEnc: ciphertext }],
    }, null, 2));
    console.log(JSON.stringify({ stage: 'dpapi-encrypted', electron: process.versions.electron }));
  } else {
    const disk = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const direct = await safeStorage.decryptStringAsync(Buffer.from(disk.anthropicApiKeyEnc, 'base64'));
    let legacyFieldMatches = null;
    let backendFieldMatches = null;
    if (storePath) {
      const store = await import(pathToFileURL(storePath).href);
      await store.warmSecrets();
      legacyFieldMatches = store.getSettings().anthropicApiKey === SENTINEL;
      backendFieldMatches = store.getBackendAuth('codex')?.apiKey === SENTINEL;
    }
    console.log(JSON.stringify({
      stage: 'dpapi-verified',
      electron: process.versions.electron,
      directDecryptMatches: direct.result === SENTINEL,
      legacyFieldMatches,
      backendFieldMatches,
      plaintextAbsent: !readFileSync(settingsPath, 'utf8').includes(SENTINEL),
    }));
  }
  window.destroy();
  app.quit();
});
