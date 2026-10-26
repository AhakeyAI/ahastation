import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { terminateProcessTree } from '../dist-electron/backends/process-tree.js';

test('Windows teardown kills the complete child process tree', { skip: process.platform !== 'win32' }, () => {
  const calls = [];
  const killer = new EventEmitter();
  killer.unref = () => { calls.push(['unref']); };
  const child = { pid: 1234, kill: (...args) => calls.push(['kill', ...args]) };
  terminateProcessTree(child, (...args) => {
    calls.push(args);
    return killer;
  });
  assert.deepEqual(calls, [
    ['taskkill.exe', ['/PID', '1234', '/T', '/F'], { stdio: 'ignore', windowsHide: true }],
    ['unref'],
  ]);
});

test('a process without a pid still receives direct termination', () => {
  const calls = [];
  terminateProcessTree({ kill: (...args) => calls.push(args) });
  assert.deepEqual(calls, [['SIGTERM']]);
});
