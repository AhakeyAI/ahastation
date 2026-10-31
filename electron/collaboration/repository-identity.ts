import { ContractError, parseContract } from './validation.js';
import type { RepositoryIdentity } from './types.js';

/** Identity normalization only. Does not grant filesystem or GitHub access. */
export function normalizeGithubRepository(input: string): RepositoryIdentity {
  const bad = () => new ContractError('INVALID_INPUT', 'Expected GitHub repository URL');
  if (typeof input !== 'string' || input.length > 512 || /[\s\u0000-\u001f%?#]/.test(input)) throw bad();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.-]+?)\/?$/i.exec(input);
  if (!match) throw bad();
  const owner = match[1].toLowerCase();
  const repo = match[2].replace(/\.git$/i, '').toLowerCase();
  if (!repo || [owner, repo].some(p => p === '.' || p === '..')) throw bad();
  return parseContract('projectConfig', { name: 'identity-check', repository: { provider: 'github', canonicalUrl: 'https://github.com/' + owner + '/' + repo } }).repository;
}
