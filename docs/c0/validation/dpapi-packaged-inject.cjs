const { app, safeStorage } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const SENTINEL = 'ahastation-dpapi-smoke-not-a-real-key';
app.whenReady().then(async () => {
  const settingsPath = join(app.getPath('userData'), 'settings.json');
  const diskBefore = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const direct = await safeStorage.decryptStringAsync(Buffer.from(diskBefore.anthropicApiKeyEnc, 'base64'));
  const storePath = join(process.resourcesPath, 'app.asar', 'dist-electron', 'store.js');
  const store = await import(pathToFileURL(storePath).href);
  await store.warmSecrets();
  const settings = store.getSettings();
  const codex = store.getBackendAuth('codex');
  const raw = readFileSync(settingsPath, 'utf8');
  console.log(JSON.stringify({
    stage: 'dpapi-verified',
    electron: process.versions.electron,
    directDecryptMatches: direct.result === SENTINEL,
    legacyFieldMatches: settings.anthropicApiKey === SENTINEL,
    backendFieldMatches: codex?.apiKey === SENTINEL,
    plaintextAbsent: !raw.includes(SENTINEL),
    ciphertextPreserved: Boolean(JSON.parse(raw).anthropicApiKeyEnc),
  }));
  app.quit();
}).catch((error) => {
  console.error(JSON.stringify({ stage: 'dpapi-failed', error: String(error) }));
  app.exit(1);
});
