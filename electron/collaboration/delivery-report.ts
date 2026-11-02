import {workReportSchema,type WorkReport} from '../worker-protocol.js';
import {DeterministicDeliveryReviewer} from '../delivery-reviewer.js';
import type {SharedEntity} from './production-types.js';

export function sharedWorkReport(task:SharedEntity):WorkReport {
  const delivery=task.delivery as {summary?:string;files?:string[];report?:{taskId:string;attemptId:string;exitConfirmed:boolean;tests:Array<{argv:string[];exitCode:number|null;output:string;source:string}>;unresolved:string[]}}|undefined;
  const report=delivery?.report;
  if(!report||report.taskId!==task.id||report.attemptId!==task.attemptId||!report.exitConfirmed||!task.exitConfirmed)throw new Error('成果缺少当前任务／尝试的真实退出及结构化报告');
  return workReportSchema.parse({status:'completed',summary:(delivery?.summary||'完整交付，等待核验').slice(0,20000),files:(delivery?.files??[]).map(path=>({path,action:'modified'})),
    tests:report.tests.map(t=>({command:t.argv.join(' '),status:t.source==='station-verifier'&&t.exitCode===0?'passed':t.exitCode===null?'not-run':'failed',summary:t.output.slice(-4000)})),
    unresolved:report.unresolved.map((message,i)=>({code:'shared-'+i,message,blocking:false}))});
}
export async function reviewSharedReport(task:SharedEntity,verified:boolean){
  const report=sharedWorkReport(task);
  // Same deterministic review rules used by original DeliveryHarness; exact Git
  // integration and configured combination checks remain a separate authority.
  return new DeterministicDeliveryReviewer().review({} as Parameters<DeterministicDeliveryReviewer['review']>[0],report,{passed:verified,checks:[]} as Parameters<DeterministicDeliveryReviewer['review']>[2]);
}
