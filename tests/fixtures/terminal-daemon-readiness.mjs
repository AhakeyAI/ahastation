import assert from 'node:assert/strict';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { startTerminalDaemon } from '../../dist-electron/terminal-daemon/entry.js';
import { TerminalClient } from '../../dist-electron/terminal-daemon/client.js';
import { prepareDataDir } from '../../dist-electron/terminal-daemon/storage.js';

const dataDir = process.argv[2];
await prepareDataDir(dataDir);
const rename = filesystem.rename;
let client;
let checkedMetadata = false;
let checkedDiscovery = false;
// Exercise the interval after a rename is visible to other processes but before
// its completion resumes the daemon. Keep this injection in an isolated child.
filesystem.rename = async (source, target) => {
  if (basename(target) === 'sessions.json') {
    await assert.rejects(filesystem.access(join(dataDir, 'daemon.json')), { code: 'ENOENT' });
    checkedMetadata = true;
  }
  await rename(source, target);
  if (basename(target) === 'daemon.json') {
    client = await TerminalClient.connect(dataDir);
    assert.deepEqual(await client.inventory(), []);
    assert(checkedMetadata, 'persist initial metadata before publishing discovery');
    const metadata = JSON.parse(await filesystem.readFile(join(dataDir, 'sessions.json'), 'utf8'));
    assert.equal(metadata.instanceId, client.descriptor.instanceId);
    checkedDiscovery = true;
  }
};
syncBuiltinESMExports();
try {
  // ACL timing and failure are covered separately; this probes publication.
  const { server } = await startTerminalDaemon(dataDir, async () => {});
  assert(checkedDiscovery);
  await filesystem.writeFile(join(dataDir, 'result.json'), JSON.stringify({ discoveryReady: true }));
  client.disconnect();
  server.close();
} finally {
  filesystem.rename = rename;
  syncBuiltinESMExports();
}
