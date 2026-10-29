import assert from 'node:assert/strict';
import test from 'node:test';

import { selectAsrPolishModel } from '../dist-electron/asr-polish.js';

test('ASR polish keeps an explicit model override', () => {
  assert.equal(selectAsrPolishModel('custom-model', ['sonnet', 'opus']), 'custom-model');
});

test('ASR polish selects a current alias from the dynamic Claude model catalog', () => {
  assert.equal(selectAsrPolishModel(undefined, ['opus', 'sonnet', 'haiku']), 'sonnet');
  assert.equal(selectAsrPolishModel('', ['claude-opus-5', 'claude-sonnet-5']), 'claude-sonnet-5');
  assert.equal(selectAsrPolishModel(undefined, ['glm-5.2']), 'glm-5.2');
});

test('ASR polish has no hidden retired-model fallback', () => {
  assert.equal(selectAsrPolishModel(undefined, undefined), null);
  assert.equal(selectAsrPolishModel(undefined, []), null);
});
