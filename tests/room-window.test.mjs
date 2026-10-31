import assert from 'node:assert/strict';
import test from 'node:test';

import { roomWindowCwd } from '../src/lib/room-window.ts';
import { roomWindowUrl } from '../dist-electron/room-windows.js';
import { addRoomWindowSender, removeRoomWindowSender } from '../dist-electron/room-window-senders.js';
import { mainWindowSenderPolicy } from '../dist-electron/ipc/validators.js';

test('a room window url round-trips the project folder, spaces and CJK included', () => {
  const cwd = '/Users/me/项目 a&b';
  const url = new URL(roomWindowUrl(cwd));
  assert.equal(`${url.protocol}//${url.host}${url.pathname}`, 'app://bundle/index.html');
  assert.equal(roomWindowCwd(url.search), cwd);
  assert.equal(roomWindowCwd(new URL(roomWindowUrl(cwd, 'http://localhost:5173/')).search), cwd);
  assert.equal(roomWindowCwd('?view=settings'), null);
});

test('main-window IPC admits a room window only while it is open', () => {
  const policy = mainWindowSenderPolicy(() => 1);
  assert.equal(policy(1), true);
  assert.equal(policy(7), false);
  addRoomWindowSender(7);
  assert.equal(policy(7), true);
  removeRoomWindowSender(7);
  assert.equal(policy(7), false);
});
