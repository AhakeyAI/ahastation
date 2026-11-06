/**
 * Approval mode for the whole Host -> Worker pipeline.
 *
 * AhaStation drives native coding CLIs: the Host assigns a task and the worker
 * only has to execute it and report back. In `auto` mode (the default) every
 * human/Coordinator gate is satisfied automatically:
 *   - plan approval            (removed: plan_meeting / delegate_task always install directly)
 *   - worker permission cards  (execution is owned by the native CLI)
 *   - Coordinator chunk review (chunks are auto-covered and completed)
 *   - task delivery accept     (a verified report is accepted and integrated)
 *   - final Meeting delivery   (published to the user base once ready)
 *
 * `manual` preserves parked delivery states for legacy recovery and tests;
 * it does not restore the removed approval UI.
 */
export type ApprovalMode = 'auto' | 'manual';

export function defaultApprovalMode(): ApprovalMode {
  return process.env.AHASTATION_APPROVAL_MODE === 'manual' ? 'manual' : 'auto';
}

/** Decision id recorded in the journal for gates that were auto-satisfied. */
export const AUTO_APPROVAL_DECISION_ID = 'auto-approval';
