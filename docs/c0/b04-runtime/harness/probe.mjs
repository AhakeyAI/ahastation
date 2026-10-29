// Smoke one candidate/provider on the plain task, printing every event.
// node --import <stub> docs/c0/b04-runtime/harness/probe.mjs C-A codex
import { collectEvidence, makeWorkspace, sleep, TASK } from './common.mjs';

const [cand = 'C-A', provider = 'codex', limitSec = '240'] = process.argv.slice(2);
const driver = await import(cand === 'C-A' ? './driver-ca.mjs' : './driver-cp.mjs');
const { ws, parent } = makeWorkspace(`${cand}-${provider}-probe`);
console.log('workspace', ws);
const h = await driver.start({ provider, ws, task: TASK });
const deadline = Date.now() + Number(limitSec) * 1000;
let printed = 0;
while (Date.now() < deadline && !h.ended) {
  await sleep(1000);
  for (; printed < h.events.length; printed += 1) console.log(JSON.stringify(h.events[printed]));
}
for (; printed < h.events.length; printed += 1) console.log(JSON.stringify(h.events[printed]));
console.log('ended', JSON.stringify(h.ended), 'sessionId', driver.sessionId(h));
console.log('permissions', JSON.stringify(h.permissions.map((p) => [p.toolName, p.allow, p.why])));
const ev = collectEvidence(ws, parent);
console.log('evidence', JSON.stringify({ ...ev, diff: ev.diff.slice(0, 400) }));
if (h.raw?.length) {
  console.log('raw updates', h.raw.length);
  for (const r of h.raw.slice(0, 6)) console.log('raw', JSON.stringify(r).slice(0, 600));
}
if (h.agent) {
  const cur = h.agent.current?.();
  console.log('agent', JSON.stringify({ status: h.agent.status, mode: cur?.currentModeId, pending: cur?.pendingPermissions, lastUsage: cur?.lastUsage, runtime: cur?.runtimeInfo }).slice(0, 800));
}
driver.end(h);
await driver.closeAll?.();
process.exit(0);
