import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMockCollaborationHub, createMockProjectAccess } from '../dist-electron/collaboration/testing/mock-hub.js';
import { CollaborationProjection } from '../dist-electron/collaboration/events.js';
import { assertExecutableWorkspace } from '../dist-electron/collaboration/local-project-access.js';

const examples = JSON.parse(readFileSync(new URL('../contracts/collaboration/examples.json', import.meta.url)));
const value = result => {
  if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message);
  return result.value;
};
const hub = createMockCollaborationHub();
const principalA = { ownerId: 'demo-account', deviceId: 'device-a' };
const principalB = { ownerId: 'demo-account', deviceId: 'device-b' };
const a = hub.forPrincipal(principalA); const b = hub.forPrincipal(principalB);
const projection = new CollaborationProjection();
const snapshot = value(await a.getSnapshot()); projection.loadSnapshot(snapshot);
const unsubscribe = a.subscribe(event => projection.apply(event));
value(await a.registerSelf({ ...examples.deviceConfig, name: 'Linux A', platform: 'linux' }));
value(await b.registerSelf({ ...examples.deviceConfig, name: 'Windows B' }));
value(await hub.connect(principalA)); value(await hub.connect(principalB));
const project = value(await a.createProject(examples.projectConfig, 'demo-project-creation-1'));
for (const deviceId of ['device-a', 'device-b']) {
  value(await (deviceId === 'device-a' ? a : b).reportBinding({ ...examples.bindingReport, projectId: project.projectId, deviceId }));
}
console.log('Registered two simulated devices under one account; each reports the same logical project.');
console.table(value(await a.listDevices()).map(d => ({
  device: d.name, online: d.online, acceptingTasks: d.acceptingTasks, maxConcurrency: d.maxConcurrency,
})));
// Paths exist only inside each simulated receiver. They are not published to the mock Hub.
const receiver = createMockProjectAccess({ ...examples.localBinding, projectId: project.projectId });
const grant = value(await receiver.resolveAuthorizedWorkspace({ ...examples.authorizationRequest, projectId: project.projectId }));
const workspace = value(await receiver.validateWorkspaceForExecution({ ...examples.workspaceRequest, authorizationRef: grant.authorizationRef }));
assert.throws(() => assertExecutableWorkspace(workspace), { code: 'SIMULATION_ONLY' });
console.log('Simulated task/attempt authorization works. Real execution guard correctly rejected simulation.');
assert.deepEqual(projection.getSnapshot(), value(await b.getSnapshot()));
assert.ok(!JSON.stringify(value(await a.getSnapshot())).includes('D:/'));
unsubscribe();
console.log('Event projection equals the account snapshot. No cloud, model, filesystem task, or GitHub write occurred.');
