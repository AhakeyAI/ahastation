import assert from 'node:assert/strict';
import test from 'node:test';

import { partitionHiddenRooms, roomHideKey } from '../src/lib/hidden-rooms.ts';

function room(cwd, lastOpenedAt, other = false) {
  return { cwd, name: cwd, parent: '/', lastActiveAt: 0, seats: [], places: [], recoverableMeetingId: null,
    opened: lastOpenedAt > 0, lastOpenedAt, other };
}

test('a hidden room stays hidden until the folder is opened again', () => {
  const hidden = { '/p/opened': 2_000, '/p/scanned': 2_000, __other__: 2_000 };
  const before = partitionHiddenRooms([room('/p/opened', 1_000), room('/p/scanned', 0), room('', 0, true)], hidden);
  assert.deepEqual(before.shown, []);
  assert.equal(before.hidden.length, 3);

  const after = partitionHiddenRooms([room('/p/opened', 3_000), room('/p/scanned', 0), room('/p/new', 0)], hidden);
  assert.deepEqual(after.shown.map((r) => r.cwd), ['/p/opened', '/p/new']);
});

test('the catch-all room hides under its own key', () => {
  assert.equal(roomHideKey(room('', 0, true)), '__other__');
  assert.equal(roomHideKey(room('/p/a', 0)), '/p/a');
});
