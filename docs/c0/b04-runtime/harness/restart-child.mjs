import { TASK, sleep } from './common.mjs';

const provider = process.env.B04_PROVIDER;
const ws = process.env.B04_WORKSPACE;
if (!provider || !ws) throw new Error('B04_PROVIDER and B04_WORKSPACE are required');
const driver = await import('./driver-ca.mjs');
const h = await driver.start({ provider, ws, task: TASK });
const deadline = Date.now() + 120_000;
while (Date.now() < deadline && !h.events.some((e) => e.kind === 'tool' || e.kind === 'permission-request')) {
  if (h.ended) throw new Error(`run ended before restart trigger: ${JSON.stringify(h.ended)}`);
  await sleep(250);
}
if (!h.events.some((e) => e.kind === 'tool' || e.kind === 'permission-request')) {
  throw new Error('timed out waiting for restart trigger');
}
process.stdout.write(`${JSON.stringify({ type: 'ready', sessionId: driver.sessionId(h), pid: process.pid })}\n`);
setInterval(() => {}, 60_000);
