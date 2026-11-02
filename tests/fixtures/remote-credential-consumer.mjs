// Controlled OS crypto only: separate processes exercise the production store
// and remote-control consumer. This does not validate a real OS keychain.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';

const [profile, phase] = process.argv.slice(2);
app.getPath = () => profile;
safeStorage.isAsyncEncryptionAvailable = async () => true;
safeStorage.encryptStringAsync = async value => Buffer.from('controlled:' + value);
safeStorage.decryptStringAsync = async value => {
  assert.ok(value.toString().startsWith('controlled:'));
  return { result: value.toString().slice('controlled:'.length), shouldReEncrypt: false };
};
const { warmSecrets, flushSettingsWrites } = await import('../../dist-electron/store.js');
const { remoteControlAction, remoteControlView } = await import('../../dist-electron/remote-control.js');
const token = 'controlled-restart-token';
let requests = 0;
const fetchImpl = async (url, options) => {
  assert.ok(url.startsWith('http://127.0.0.1:43155/'));
  requests += 1;
  if (url.includes('/v2/auth/')) return Response.json({ owner_id: 'controlled-owner', login: 'fixture', control_token: token });
  assert.equal(options.headers.Authorization, 'Bearer ' + token);
  return Response.json({ devices: [] });
};
await warmSecrets();
if (phase === 'login') {
  assert.equal((await remoteControlAction('configure', {
    enabled: true, mode: 'public', serviceUrl: 'http://127.0.0.1:43155',
  })).ok, true);
  assert.equal((await remoteControlAction('login', {
    login: 'fixture', password: 'controlled-password',
  }, { fetchImpl })).ok, true);
} else if (phase === 'restart') {
  assert.equal(remoteControlView().loggedIn, true);
  assert.equal((await remoteControlAction('devices', {}, { fetchImpl })).ok, true);
  assert.equal(requests, 1);
  assert.equal((await remoteControlAction('logout', {}, { fetchImpl })).ok, true);
} else {
  assert.equal(phase, 'after-logout');
  assert.equal(remoteControlView().loggedIn, false);
  assert.equal((await remoteControlAction('devices', {}, { fetchImpl })).ok, false);
  assert.equal(requests, 0);
}
await flushSettingsWrites();
const disk = await readFile(join(profile, 'settings.json'), 'utf8');
assert.ok(!disk.includes(token));
assert.ok(!disk.includes('"controlToken":'));
assert.equal(Boolean(JSON.parse(disk).remoteControl.controlTokenEnc), phase === 'login');
console.log(JSON.stringify({ phase, passed: true, requests, plaintextOnDisk: false }));
