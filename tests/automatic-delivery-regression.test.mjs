import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryHarness } from '../dist-electron/delivery-harness.js';
import { CommandDeliveryVerifier } from '../dist-electron/delivery-verifier.js';
import { DeterministicDeliveryReviewer } from '../dist-electron/delivery-reviewer.js';
import { CoordinatorReviewDriver } from '../dist-electron/coordinator-review-driver.js';
import { prepareFrozenDeliveryCandidate } from '../dist-electron/delivery-candidate.js';
import { GitDeliveryIntegrator } from '../dist-electron/delivery-integrator.js';
import { IntegrationQueue } from '../dist-electron/integration-queue.js';
import { Orchestrator } from '../dist-electron/orchestrator.js';

const manual = [{ id: 'manual', description: 'legacy human check', verification: { kind: 'manual' } }];
const report = (path) => ({ status: 'completed', summary: 'done', files: [{ path, action: 'created' }], tests: [], unresolved: [] });
const command = (path) => [{ id: 'syntax', description: 'check syntax', verification: { kind: 'command', argv: [process.execPath, '--check', path] } }];
const git = (cwd, args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'aha-auto-regression-'));
  const base = join(root, 'base'); mkdirSync(base);
  git(base, ['init']); git(base, ['config', 'user.name', 'Test']); git(base, ['config', 'user.email', 'test@example.invalid']);
  git(base, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(base, 'README.md'), 'base\n');
  git(base, ['add', '--', 'README.md']); git(base, ['commit', '-m', 'base']);
  return { root, base, revision: git(base, ['rev-parse', 'HEAD']) };
}
async function submit(harness, workspace, revision, criteria, workReport) {
  const proposal = await harness.propose({ meetingId: 'auto', objective: 'implement', taskId: workReport.files[0].path,
    workspace, sourceRevision: revision, acceptanceCriteria: criteria });
  await harness.decide(proposal.id, { kind: 'approve-spec', specVersion: 1 });
  return harness.submitExternalReport(proposal.id, workReport);
}

test('manual-only and unexecuted verification evidence cannot automatically accept code', async () => {
  const repo = repository();
  writeFileSync(join(repo.base, 'bad.js'), 'const = ;\n');
  let integrations = 0;
  const make = (verifier) => new DeliveryHarness({ executionMode: 'external', approvalMode: 'auto', verifier,
    reviewer: new DeterministicDeliveryReviewer(), integrator: { async integrate() { integrations++; return {}; } } });
  const view = await submit(make(new CommandDeliveryVerifier({ automatic: true })), repo.base, repo.revision, manual, report('bad.js'));
  assert.equal(view.status, 'reworking');
  assert.match(view.error, /No executable|executable checks/);
  const claimed = await submit(make({ verify: async () => ({ passed: true, checks: [] }) }), repo.base, repo.revision, command('bad.js'), report('bad.js'));
  assert.equal(claimed.status, 'reworking');
  const syntax = await submit(make(new CommandDeliveryVerifier({ automatic: true })), repo.base, repo.revision, command('bad.js'), report('bad.js'));
  assert.equal(syntax.status, 'reworking');
  assert.equal(integrations, 0);
});

test('freeze failures automatically enter bounded rework instead of removed human acceptance', async () => {
  const harness = new DeliveryHarness({ executionMode: 'external', approvalMode: 'auto',
    verifier: { verify: async () => ({ passed: true, checks: [{ criterionId: 'syntax', status: 'passed', exitCode: 0 }] }) },
    reviewer: new DeterministicDeliveryReviewer(),
    candidatePreparer: { prepare: async () => { throw new Error('unreported changes: extra.js'); } },
    reviewDriver: {}, integrator: { integrate: async () => { throw new Error('must not integrate'); } },
  });
  const view = await submit(harness, process.cwd(), 'abc123', command('result.js'), report('result.js'));
  assert.equal(view.status, 'reworking');
  assert.equal(view.candidate, undefined);
  assert.match(view.attempts.at(-1).feedback, /unreported changes/);
});

test('automatic verification discovers and actually runs the native project test command', async () => {
  const repo = repository();
  writeFileSync(join(repo.base, 'package.json'), JSON.stringify({ scripts: { test: 'node --check result.js' } }));
  writeFileSync(join(repo.base, 'result.js'), 'const = ;\n');
  const verifier = new CommandDeliveryVerifier({ automatic: true });
  const order = { deliveryId: 'discovered', attempt: 1, meetingId: 'auto', goal: 'verify',
    workspace: repo.base, sourceRevision: repo.revision, acceptanceCriteria: manual };
  const failed = await verifier.verify(order, report('result.js'));
  assert.equal(failed.passed, false);
  assert.equal(failed.checks[0].status, 'failed');
  writeFileSync(join(repo.base, 'result.js'), 'const result = 1;\n');
  const passed = await verifier.verify(order, report('result.js'));
  assert.equal(passed.passed, true, passed.error);
  assert.equal(passed.checks[0].exitCode, 0);
  assert.ok(passed.checks.every((check) => check.status !== 'manual-pending'));
});

test('a live meeting can automatically publish two rounds, then clean up only after closing', async () => {
  const repo = repository();
  const verifier = new CommandDeliveryVerifier({ automatic: true });
  const journal = [];
  const queue = new IntegrationQueue({ meetingId: 'auto', expectedUserBaseRevision: repo.revision,
    integrator: new GitDeliveryIntegrator(repo.base, 'auto', join(repo.root, 'integration')),
    verify: (view, candidate, workspace) => verifier.verify({ ...view.spec, deliveryId: view.id, attempt: view.attempt,
      meetingId: 'auto', goal: view.spec.objective, workspace, sourceRevision: view.sourceRevision }, candidate.report),
    append: async (type, payload) => { journal.push({ type, payload: { data: payload } }); }, flush: async () => {},
  });
  let harness;
  const driver = new CoordinatorReviewDriver({ append: async () => {}, flush: async () => {},
    onCompleted: (session) => harness.completeCoordinatorReview(session.deliveryId, session) });
  harness = new DeliveryHarness({ executionMode: 'external', approvalMode: 'auto', verifier,
    reviewer: new DeterministicDeliveryReviewer(), reviewDriver: driver,
    candidatePreparer: { prepare: (order, report, verification) => prepareFrozenDeliveryCandidate({ order, report, verification }) },
    integrator: { integrate: (view, candidate) => queue.enqueue(view, candidate) },
  });
  const tasks = []; let version = 1;
  const orchestrator = Object.assign(Object.create(Orchestrator.prototype), {
    approvalMode: 'auto', closed: false, autoPublishing: false, coordinatorTurnActive: false,
    finalMeetingDecision: null, finalMeetingDelivery: null, meetingId: 'auto', expectedUserBaseRevision: repo.revision,
    meetingScheduler: { snapshot: () => tasks, getPlanVersion: () => version },
    integrationQueue: queue, deliveryVerifier: verifier,
    repository: { append: async () => {}, flush: async () => {} }, safeEmit() {}, snapshotActiveMeeting: async () => {},
  });
  for (const id of ['one', 'two']) {
    const start = git(repo.base, ['rev-parse', 'HEAD']);
    const workspace = join(repo.root, id);
    git(repo.base, ['worktree', 'add', '-b', id, workspace, start]);
    writeFileSync(join(workspace, `${id}.js`), `const ${id} = 1;\n`);
    const view = await submit(harness, workspace, start, command(`${id}.js`), report(`${id}.js`));
    assert.equal(view.status, 'accepted', view.error);
    tasks.push({ id, title: id, status: 'accepted', attempt: 1, delivery: view }); version++;
    await orchestrator.maybeAutoPublishFinalDelivery();
    assert.equal(orchestrator.finalMeetingDelivery.publicationState, 'published');
    assert.equal(orchestrator.finalMeetingDelivery.expectedUserBaseRevision, start);
    assert.equal(git(repo.base, ['rev-parse', 'HEAD']), queue.currentHead());
    assert.ok(existsSync((await queue.inspectState()).workspace));
  }
  assert.ok(existsSync(join(repo.base, 'one.js')) && existsSync(join(repo.base, 'two.js')));
  const workspace = (await queue.inspectState()).workspace;
  await queue.cleanupPublishedIntegration(queue.currentHead());
  assert.equal(existsSync(workspace), false);
  const recovered = new IntegrationQueue({ meetingId: 'auto', expectedUserBaseRevision: repo.revision,
    integrator: new GitDeliveryIntegrator(repo.base, 'auto', join(repo.root, 'integration')),
    verify: async () => { throw new Error('read-only recovery must not verify'); },
    append: async () => {}, flush: async () => {},
  });
  recovered.restore(journal);
  assert.equal(recovered.currentHead(), queue.currentHead());
  assert.equal(recovered.publicationBaseRevision(), queue.currentHead());
  assert.ok(existsSync((await recovered.inspectState()).workspace));
  await recovered.cleanupPublishedIntegration(recovered.currentHead());
});
