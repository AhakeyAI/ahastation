import type {SharedEntity} from './production-types.js';
import {hash} from 'fast-sha256';
export function canonicalJson(value:unknown):string{
  if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
  if(value&&typeof value==='object'){
    const fields=Object.entries(value)
      .filter(([,v])=>v!==undefined)
      .sort(([a],[b])=>a<b?-1:a>b?1:0)
      .map(([k,v])=>JSON.stringify(k)+':'+canonicalJson(v));
    return '{'+fields.join(',')+'}';
  }
  return JSON.stringify(value)??'null';
}
export function deliveryIdentity(task:SharedEntity):string{
  return canonicalJson({meetingId:task.meetingId,taskId:task.id,attemptId:task.attemptId,delivery:task.delivery});
}
export function deliveryHash(task:SharedEntity):string {
  return Array.from(hash(new TextEncoder().encode(deliveryIdentity(task))),n=>n.toString(16).padStart(2,'0')).join('');
}
export async function browserDeliveryHash(task:SharedEntity){return deliveryHash(task);}

/** Same contract as CollaborationStore.verified_delivery; never repairs history.
 * Unbound legacy acceptance remains history, and cannot authorize new work. */
export function verifiedDelivery(task:SharedEntity|undefined):boolean {
  if(!task||task.integration!=='verified'||!['delivered','accepted'].includes(String(task.status)))return false;
  const delivery=task.delivery as {scopeVersion?:number;report?:{taskId?:string;attemptId?:string;exitConfirmed?:boolean}}|undefined;
  const binding=task.verificationBinding as {attemptId?:string;deliveryHash?:string;reviewed?:boolean}|undefined;
  const completed=task.turnOutcome==='completed'||task.turnOutcome===undefined&&!task.stopRequested;
  return task.exitConfirmed===true&&completed
    &&Number(task.scopeVersion??0)===Number(delivery?.scopeVersion??0)
    &&delivery?.report?.taskId===task.id&&delivery.report.attemptId===task.attemptId&&delivery.report.exitConfirmed===true
    &&binding?.reviewed===true&&binding.attemptId===task.attemptId&&binding.deliveryHash===deliveryHash(task);
}
