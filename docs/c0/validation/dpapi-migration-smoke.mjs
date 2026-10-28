import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SENTINEL = 'ahastation-dpapi-smoke-not-a-real-key';
const args = process.argv.slice(2);
const mode = args[args.indexOf('--mode') + 1];
const userData = args[args.indexOf('--user-data') + 1];
const storePath = args[args.indexOf('--store') + 1];
if (!mode || !userData || (mode === 'decrypt' && !storePath)) {
  throw new Error('usage: --mode encrypt|decrypt --user-data <dir> [--store <store.js>]');
}
app.setPath('userData', userData);
mkdirSync(userData, { recursive: true });
const settingsPath = join(userData, 'settings.json');

console.log(JSON.stringify({ stage: 'before-ready', mode }));
await app.whenReady();
console.log(JSON.stringify({ stage: 'ready', mode }));
if (mode === 'encrypt') {
  const ciphertext = safeStorage.encryptString(SENTINEL).toString('base64');
  console.log(JSON.stringify({ stage: 'encrypted', mode }));
  writeFileSync(settingsPath, JSON.stringify({
    anthropicApiKeyEnc: ciphertext,
    backendAuth: [{ backendId: 'codex', authMode: 'apikey', apiKeyEnc: ciphertext }],
  }, null, 2));
  console.log(JSON.stringify({ mode, electron: process.versions.electron, encrypted: true }));
} else {
  const diskBefore = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const direct = await safeStorage.decryptStringAsync(Buffer.from(diskBefore.anthropicApiKeyEnc, 'base64'));
  const store = await import(pathToFileURL(storePath).href);
  await store.warmSecrets();
  const settings = store.getSettings();
  const codex = store.getBackendAuth('codex');
  const raw = readFileSync(settingsPath, 'utf8');
  console.log(JSON.stringify({
    mode,
    electron: process.versions.electron,
    directDecryptMatches: direct.result === SENTINEL,
    legacyFieldMatches: settings.anthropicApiKey === SENTINEL,
    backendFieldMatches: codex?.apiKey === SENTINEL,
    plaintextAbsent: !raw.includes(SENTINEL),
    ciphertextPreserved: Boolean(JSON.parse(raw).anthropicApiKeyEnc),
  }));
}
console.log(JSON.stringify({ stage: 'quit', mode }));
app.quit();
