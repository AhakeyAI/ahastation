export type NativeAgent = 'claude' | 'codex';
/** Capability diagnosis, not an activation toggle. Version checks do not prove
 * hook coverage, protected peers, confinement or B04. No caller-supplied
 * evidence/setting can enable production admission in this revision. */
export function nativeWorkerAdmission(agent: string, version: string | null) {
  const blockers = ['protected-process-and-credential-channel', 'independent-execution-guard',
    'IF-2-production-owner-binding', 'B04-S1-S6-S8-S11', 'Shawn-Mac-Claude-WorkReport'];
  if (agent !== 'claude' && agent !== 'codex') blockers.unshift('unsupported-agent');
  else if (version !== (agent === 'claude' ? '2.1.150' : '0.156.1')) blockers.unshift('unverified-cli-version');
  if (agent === 'claude') blockers.unshift('target-version-lacks-onFailure-block');
  if (agent === 'codex') blockers.unshift('native-hook-trust-and-failure-open-paths');
  return { enabled: false as const, agent, version, blockers,
    requiredEvidence: 'guardian-enforced tool boundary plus real engine failure/revocation/tree-stop tests; a newer CLI alone is insufficient' };
}
