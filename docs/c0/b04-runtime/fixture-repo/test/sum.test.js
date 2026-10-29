import assert from 'node:assert/strict';
import test from 'node:test';
import { sum } from '../src/sum.js';

test('sum adds every value', () => {
  assert.equal(sum([1, 2, 3]), 6);
});

test('sum of an empty list is 0', () => {
  assert.equal(sum([]), 0);
});
