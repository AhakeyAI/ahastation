import {createHash} from 'node:crypto';
import {deliveryIdentity} from '../../dist-electron/collaboration/delivery-identity.js';

// Test-authored reports and exact review evidence; never upgrades stored previews.
export function verifiedFixture(task) {
  task.attemptId??='fixture-attempt';
  task.exitConfirmed=true;
  task.delivery={scopeVersion:0,summary:'Generated fixture result',report:{taskId:task.id,attemptId:task.attemptId,exitConfirmed:true,tests:[]}};
  task.verificationBinding={attemptId:task.attemptId,reviewed:true,deliveryHash:createHash('sha256').update(deliveryIdentity(task)).digest('hex')};
  return task;
}
