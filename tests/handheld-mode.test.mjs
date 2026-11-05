import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HANDHELD_AUTO_MAX_SCREEN_WIDTH,
  HANDHELD_LAYOUT_ENABLED,
  resolveUiMode,
} from '../dist-electron/handheld-mode.js';

// ---------------------------------------------------------------------------
// resolveUiMode — three-way override + auto heuristic (§3.3)
// ---------------------------------------------------------------------------

test('handheld layout is parked: every setting and signal resolves to desktop', () => {
  assert.equal(HANDHELD_LAYOUT_ENABLED, false);
  for (const override of ['auto', 'handheld', 'desktop']) {
    for (const [coarse, width] of [[true, 576], [true, 1280], [true, 1300], [false, 700], [true, 1920]]) {
      assert.equal(resolveUiMode(override, coarse, width), 'desktop', `${override} ${coarse} ${width}`);
    }
  }
});

test('boundary constant is 1300', () => {
  assert.equal(HANDHELD_AUTO_MAX_SCREEN_WIDTH, 1300);
});
