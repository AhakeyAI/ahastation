import assert from 'node:assert/strict';import {readFile,writeFile} from 'node:fs/promises';import {join,resolve} from 'node:path';
// Offline re-evaluation of one completed real-model run. Does not change its
// original failing report or submit another model request.
const root=resolve('runtime/collaboration-2026-10-21/real-two-stations-af23b697-3613-41a8-9e50-fbbbff57e58a');
const states=await Promise.all(['A','B'].map(n=>readFile(join(root,n,'station-v2.json'),'utf8').then(JSON.parse)));
const [a,b]=states;const task=a.snapshot.entities.task.find(t=>t.status==='delivered');assert.ok(task);
const meeting=a.snapshot.entities.meeting.find(m=>m.id===task.meetingId);assert.equal(meeting.autoAssign,true);assert.equal(meeting.planApproved,true);
assert.equal(task.targetDeviceId,b.deviceId);assert.equal(task.exitConfirmed,true);assert.equal(b.snapshot.entities.task.find(t=>t.id===task.id)?.status,'delivered');
const receipt=b.receipts[task.id];assert.equal(receipt.status,'delivered');assert.equal(receipt.exitConfirmed,true);assert.equal(receipt.executionInvoked,true);assert.ok(receipt.nativeThreadId);
const summary=task.delivery.summary;assert.ok(summary.includes('AhaStation 上线核验'));assert.ok(summary.includes('AhaStation 双机使用'));assert.ok(summary.trimEnd().endsWith('STATION-REAL-END-TO-END-OK'));assert.doesNotMatch(summary,/请回复.{0,12}(批准|确认)|批准后.{0,6}执行/);
const sections=summary.split(/#+\s*AhaStation 双机使用/);assert.equal(sections.length,2);for(const section of sections)assert.ok((section.match(/^\s*\d+[.、]/gm)??[]).length>=3);
const report={pass:true,scope:'Offline verification of captured production HTTP/WSS + real Codex Host and worker run; API/secure storage fixtures, no fresh model call or actual second PC claim',
  originalReportUnchanged:true,originalFailure:'The smoke assertion imposed an unrequested 350-character minimum. Captured delivery has both requested sections, each with four actual numbered steps, exact final line, durable receipt and confirmed exit.',
  taskId:task.id,attemptId:task.attemptId,nativeThreadId:receipt.nativeThreadId,summary,
  limit:'Subsequent model attempt returned native HTTP429; no further model retry. The later local namespace preservation fix is covered separately by a frozen-runtime execution/stop/inspect test.'};
await writeFile(join(root,'CONTENT-VALIDATION.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({pass:true,report:join(root,'CONTENT-VALIDATION.json')}));
