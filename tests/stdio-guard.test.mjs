import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import { test } from 'node:test';
import { guardDiagnosticStream } from '../dist-electron/stdio-guard.js';

test('console output survives synchronous broken pipes, including later writes', async () => {
  const pipe = Object.assign(new Error('closed reader'), { code: 'EPIPE' });
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  let writes = 0;
  sink.write = () => { writes++; throw pipe; };
  guardDiagnosticStream(sink);
  const logger = new Console({ stdout: sink, stderr: sink, ignoreErrors: false });
  assert.doesNotThrow(() => logger.log('create terminal'));
  assert.doesNotThrow(() => logger.error('later diagnostic'));
  assert.equal(writes, 1);
  await new Promise(resolve => sink.write('with callback', error => {
    assert.equal(error, pipe);
    resolve();
  }));
});

test('unrelated synchronous diagnostic errors still throw', () => {
  const error = Object.assign(new Error('disk failure'), { code: 'EIO' });
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  sink.write = () => { throw error; };
  guardDiagnosticStream(sink);
  assert.throws(() => sink.write('diagnostic'), error);
  assert.throws(() => sink.emit('error', error), error);
});

test('a real closed stdout pipe does not prevent application work', async () => {
  const guardUrl = new URL('../dist-electron/stdio-guard.js', import.meta.url).href;
  const script = `
    import ${JSON.stringify(guardUrl)};
    process.on('message', () => {
      console.log('terminal created');
      console.error('stderr remains usable');
      setTimeout(() => { console.log('later diagnostic'); process.send('alive'); }, 30);
    });
    process.send('ready');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  try {
    assert.deepEqual(await once(child, 'message'), ['ready', undefined]);
    child.stdout.destroy();
    child.stderr.destroy();
    child.send('write');
    assert.equal((await once(child, 'message'))[0], 'alive');
  } finally {
    child.kill();
    await once(child, 'close');
  }
});
