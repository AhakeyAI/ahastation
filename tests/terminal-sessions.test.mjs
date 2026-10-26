import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalSessions } from '../dist-electron/terminal-sessions.js';

test('root exit cannot turn failed tree cleanup into a successful repeated stop', async () => {
  let onExit;
  let stops = 0;
  const host = {
    spawn: () => 1234, onData: () => () => {}, onExit: (_, cb) => { onExit = cb; return () => {}; },
    replayBuffer: () => Buffer.alloc(0),
    terminateTree: async () => { stops++; onExit(1); throw new Error('partial tree failure'); },
  };
  const sessions = new TerminalSessions(host, { data: () => {}, exit: () => {} });
  sessions.create('example', { file: 'unused', args: [], cwd: '/', env: {} });
  await assert.rejects(sessions.terminate('example'), /partial tree failure/);
  assert.equal(sessions.list()[0].exited, true);
  assert.match(sessions.list()[0].terminationError, /partial tree failure/);
  await assert.rejects(sessions.terminate('example'), /cleanup not confirmed/);
  assert.equal(stops, 1);
});
