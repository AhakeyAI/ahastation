import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SENTINEL = 'ahastation-dpapi-smoke-not-a-real-key';
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const mode = value('--mode');
const mainPath = value('--main');
const storePath = value('--store');
const userData = value('--user-data');
if (!mode || !mainPath || !userData) throw new Error('mode/main/user-data required');
console.log(JSON.stringify({ stage: 'entry-start', mode, electron: process.versions.electron }));
app.setPath('userData', userData);
mkdirSync(userData, { recursive: true });
const settingsPath = join(userData, 'settings.json');
const ready = app.whenReady();
await import(pathToFileURL(mainPath).href);
await ready;

if (mode === 'encrypt') {
  const ciphertext = safeStorage.encryptString(SENTINEL).toString('base64');
  writeFileSync(settingsPath, JSON.stringify({
    anthropicApiKeyEnc: ciphertext,
    backendAuth: [{ backendId: 'codex', authMode: 'apikey', apiKeyEnc: ciphertext }],
  }, null, 2));
  console.log(JSON.stringify({ stage: 'dpapi-encrypted', electron: process.versions.electron }));
} else {
  const diskBefore = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const direct = await safeStorage.decryptStringAsync(Buffer.from(diskBefore.anthropicApiKeyEnc, 'base64'));
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
}
app.quit();
