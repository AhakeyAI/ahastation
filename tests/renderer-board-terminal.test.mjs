import assert from 'node:assert/strict';
import test from 'node:test';

import { roomCwdForFolder } from '../src/lib/board-terminal.ts';

const keyOf = (cwd) => (cwd.startsWith('/repo/') ? '/repo' : cwd);

test('a board card opens in the meeting already open for its repository', () => {
  assert.equal(roomCwdForFolder('/repo/wt-a', ['/other', '/repo'], keyOf), '/repo');
  assert.equal(roomCwdForFolder('/repo/wt-a', ['/repo/wt-b'], keyOf), '/repo/wt-b');
});

test('an exact meeting wins; no meeting falls back to the repository root', () => {
  assert.equal(roomCwdForFolder('/repo/wt-a', ['/repo', '/repo/wt-a'], keyOf), '/repo/wt-a');
  assert.equal(roomCwdForFolder('/repo/wt-a', [], keyOf), '/repo');
});
