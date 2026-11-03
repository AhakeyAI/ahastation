import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ensureMicrophoneAccess } from '../dist-electron/microphone-access.js';

function deps(status, askResult = true) {
  const calls = { ask: 0, help: 0, settings: 0 };
  return {
    calls,
    value: {
      platform: 'darwin',
      getStatus: () => status,
      askForAccess: async () => { calls.ask += 1; return askResult; },
      showDeniedHelp: async () => { calls.help += 1; return true; },
      openSettings: async () => { calls.settings += 1; },
    },
  };
}

test('first macOS launch asks for native microphone access', async () => {
  const { calls, value } = deps('not-determined', true);
  assert.equal(await ensureMicrophoneAccess(value, false), true);
  assert.deepEqual(calls, { ask: 1, help: 0, settings: 0 });
});

test('previous denial shows native recovery help and opens Microphone settings', async () => {
  const { calls, value } = deps('denied');
  assert.equal(await ensureMicrophoneAccess(value, true), false);
  assert.deepEqual(calls, { ask: 0, help: 1, settings: 1 });
});

test('non-macOS does not invoke macOS permission APIs', async () => {
  const { calls, value } = deps('not-determined');
  value.platform = 'linux';
  assert.equal(await ensureMicrophoneAccess(value, true), true);
  assert.deepEqual(calls, { ask: 0, help: 0, settings: 0 });
});

test('Windows never shows a consent sheet and only falls back to settings help when the privacy toggle is off', async () => {
  for (const status of ['granted', 'not-determined', 'unknown']) {
    const { calls, value } = deps(status);
    value.platform = 'win32';
    assert.equal(await ensureMicrophoneAccess(value, true), true, status);
    assert.deepEqual(calls, { ask: 0, help: 0, settings: 0 });
  }
  const { calls, value } = deps('denied');
  value.platform = 'win32';
  assert.equal(await ensureMicrophoneAccess(value, true), false);
  assert.deepEqual(calls, { ask: 0, help: 1, settings: 1 });
  const quiet = deps('denied');
  quiet.value.platform = 'win32';
  assert.equal(await ensureMicrophoneAccess(quiet.value, false), false);
  assert.deepEqual(quiet.calls, { ask: 0, help: 0, settings: 0 });
});

test('macOS package declares microphone privacy and audio-input entitlement', async () => {
  const [entitlements, builderConfig, packageJson] = await Promise.all([
    readFile(new URL('../build/entitlements.mac.plist', import.meta.url), 'utf8'),
    readFile(new URL('../electron-builder.json', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);

  assert.match(entitlements, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);
  assert.doesNotMatch(entitlements, /com\.apple\.security\.device\.microphone/);

  const config = JSON.parse(builderConfig);
  assert.equal(typeof config.mac.extendInfo.NSMicrophoneUsageDescription, 'string');
  assert.ok(config.mac.extendInfo.NSMicrophoneUsageDescription.length > 0);
  assert.equal(config.mac.identity, undefined, 'release config must allow certificate discovery');
  assert.match(JSON.parse(packageJson).scripts['dist:dmg'], /verify-macos-signing\.mjs/);
});
