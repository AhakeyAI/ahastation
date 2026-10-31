import assert from 'node:assert/strict';
import test from 'node:test';

import { nativeCliForBackend } from '../src/lib/native-cli.ts';

test('every non-PTY meeting backend maps to its native local CLI', () => {
  assert.equal(nativeCliForBackend('claude-code'), 'claude');
  assert.equal(nativeCliForBackend('codex'), 'codex');
  assert.equal(nativeCliForBackend('opencode'), 'opencode');
  assert.equal(nativeCliForBackend('kimi'), 'kimi');
  assert.equal(nativeCliForBackend('qoder'), 'qoder');
});

test('backends without a local CLI fall back to a plain shell', () => {
  assert.equal(nativeCliForBackend('pocket-vibe'), null);
  assert.equal(nativeCliForBackend(undefined), null);
  assert.equal(nativeCliForBackend(''), null);
});
