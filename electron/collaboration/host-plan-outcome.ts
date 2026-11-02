import {CollaborationHttpError} from './connection.js';
import type {HostInputFailure} from './production-types.js';

// These errors originate inside the Hub command transaction, after its original
// request receipt lookup. They prove this exact proposal was not committed.
// Generation, protocol, identity conflicts and transport failures prove no such thing.
const rejectedPlanCodes = new Set([
  'PLAN_VERSION_CONFLICT', 'PLAN_APPROVAL_CONFLICT',
  'DISPATCHED_TASK_OMITTED', 'DISPATCHED_TASK_IMMUTABLE',
]);

export function rejectedHostPlan(error:unknown):HostInputFailure|undefined {
  if (!(error instanceof CollaborationHttpError))return;
  if(![400,403,409].includes(error.status)||['REQUEST_ID_CONTENT_CONFLICT','CONNECTION_GENERATION_CHANGED'].includes(error.code??''))return;
  if(!error.notApplied&&!(error.status===409&&rejectedPlanCodes.has(error.code??'')))return;
  const code=error.code??'PLAN_REJECTED';
  return {message:'提案未应用：'+code+' · '+error.message, notStarted:false, code, proposalRejected:true};
}
