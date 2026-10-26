import { sleep, writeResult } from './common.mjs';

const provider = process.argv[2];
if (!['claude-code', 'codex'].includes(provider)) throw new Error('usage: host-smoke.mjs <claude-code|codex>');
const driver = await import('./driver-ca.mjs');
let handle;
try {
  handle = await driver.start({
    provider,
    ws: process.cwd(),
    role: 'host',
    task: 'Reply with exactly HOST_OK and no other text. Do not use tools.',
  });
  const deadline = Date.now() + 120_000;
  const hasResult = () => handle.events.some((event) => event.type === 'result' || event.reason === 'completed' || event.status === 'completed');
  while (!handle.ended && !hasResult() && Date.now() < deadline) await sleep(250);
  const models = handle.backend.capabilities.models ?? [];
  const result = (handle.ended || hasResult()) && handle.events.some((event) => event.kind === 'message') ? 'pass' : 'fail';
  const record = {
    candidate: 'C-A',
    provider,
    scenario: 'HOST',
    versions: driver.versions(provider),
    at: new Date().toISOString(),
    result,
    observed: `ended=${JSON.stringify(handle.ended)} messageEvents=${handle.events.filter((event) => event.kind === 'message').length} discoveredModels=${models.length}`,
    models,
    events: handle.events,
    protocolUsage: handle.protocolUsage,
  };
  writeResult(record);
  console.log(`HOST ${record.result} — ${record.observed}`);
} catch (error) {
  writeResult({
    candidate: 'C-A', provider, scenario: 'HOST', versions: driver.versions(provider),
    at: new Date().toISOString(), result: 'fail',
    observed: `host smoke error: ${String(error?.message ?? error).slice(0, 300)}`,
  });
  console.log(`HOST fail — ${String(error?.message ?? error)}`);
} finally {
  if (handle) driver.end(handle);
}
