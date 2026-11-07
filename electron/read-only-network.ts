/** Narrow command profile. Exact argv approval is still required. No shell,
 * aliases, API queries, templates, browser/editor launches or output files. */
export function isReadOnlyNetworkCommand(argv: readonly string[]): boolean {
  if (argv[0] !== 'gh' || !['issue', 'pr'].includes(argv[1] ?? '')
    || !['list', 'view'].includes(argv[2] ?? '')) return false;
  let repo = false;
  let positional = false;
  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i]!;
    if (['--repo', '-R'].includes(arg)) {
      if (repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(argv[++i] ?? '')) return false;
      repo = true;
    } else if (['--state', '--limit', '--json', '--search', '--label', '--author', '--assignee'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('-') || /[\x00-\x1f\x7f]/.test(value)) return false;
      if (arg === '--state' && !['open', 'closed', 'merged', 'all'].includes(value)) return false;
      if (arg === '--limit' && !/^[1-9]\d{0,2}$/.test(value)) return false;
      if (arg === '--json' && !/^[A-Za-z]+(?:,[A-Za-z]+)*$/.test(value)) return false;
    } else if (arg === '--comments') {
      if (argv[2] !== 'view') return false;
    } else if (argv[2] === 'view' && !positional && /^[1-9]\d*$/.test(arg)) {
      positional = true;
    } else return false;
  }
  return repo && (argv[2] === 'list' || positional);
}

export interface ReadOnlyNetworkEnvelope {
  writePaths: readonly string[]; toolKinds: readonly string[];
  commands: readonly (readonly string[])[]; environmentKeys: readonly string[];
  networkHosts: readonly string[];
}
export function isReadOnlyNetworkEnvelope(value: ReadOnlyNetworkEnvelope): boolean {
  return value.writePaths.length === 0 && value.environmentKeys.length === 0
    && value.toolKinds.every(k => ['read', 'search', 'git-read', 'command'].includes(k))
    && value.commands.every(isReadOnlyNetworkCommand)
    && value.networkHosts.length === 1 && value.networkHosts[0] === 'api.github.com';
}
