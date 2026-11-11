import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GIT_EXE = 'C:\\Program Files\\Git\\cmd\\git.exe';

function createHardenedGitRunner({ emptyHooksDir, emptyConfigFile }) {
  return function runGitHardened(cwd, args, extraEnv = {}) {
    const cleanEnv = {
      SystemRoot: process.env.SystemRoot || 'C:\\Windows',
      PATH: `${path.dirname(GIT_EXE)};${process.env.SystemRoot || 'C:\\Windows'}\\System32`,
      HOME: emptyHooksDir,
      USERPROFILE: emptyHooksDir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: emptyConfigFile,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'echo',
      SSH_ASKPASS: 'echo',
      GIT_LFS_SKIP_SMUDGE: '1',
      ...extraEnv,
    };
    const fullArgs = [
      '-c', `core.hooksPath=${emptyHooksDir.replace(/\\/g, '/')}`,
      '-c', 'core.fsmonitor=false',
      '-c', 'protocol.file.allow=always',
      '-c', 'user.name=AhaStudio Workflow Engine',
      '-c', 'user.email=workflow@ahastudio.local',
      '-c', 'commit.gpgsign=false',
      ...args,
    ];
    try {
      const stdout = execFileSync(GIT_EXE, fullArgs, {
        cwd,
        env: cleanEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      return { ok: true, stdout: stdout.trim(), stderr: '' };
    } catch (err) {
      return {
        ok: false,
        code: err.status ?? 1,
        stdout: String(err.stdout ?? '').trim(),
        stderr: String(err.stderr ?? '').trim(),
      };
    }
  };
}

function parseWorktreeListPorcelain(porcelainOutput) {
  const entries = [];
  let current = {};
  for (const rawLine of porcelainOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (current.worktree) entries.push(current);
      current = {};
      continue;
    }
    if (line.startsWith('worktree ')) {
      current.worktree = line.slice('worktree '.length).trim();
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim(); // e.g. refs/heads/main
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'bare') {
      current.bare = true;
    }
  }
  if (current.worktree) entries.push(current);
  return entries;
}

function hasGitOperationInProgress(gitDir) {
  const markers = [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG',
    'rebase-merge',
    'rebase-apply',
    ' index.lock',
    'index.lock',
  ];
  for (const m of markers) {
    if (fs.existsSync(path.join(gitDir, m))) return m;
  }
  return null;
}

function freezeCandidate(runGit, workerWorktreePath, baseCommitSha, options = { autoCommitDirty: true }) {
  const statusRes = runGit(workerWorktreePath, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (!statusRes.ok) {
    return { ok: false, errorCode: 'CANDIDATE_STATUS_FAILED', detail: statusRes.stderr };
  }
  const isDirty = statusRes.stdout.length > 0;
  if (isDirty) {
    if (!options.autoCommitDirty) {
      return { ok: false, errorCode: 'CANDIDATE_FREEZE_DIRTY', detail: 'Working tree has uncommitted changes and autoCommitDirty=false' };
    }
    const addRes = runGit(workerWorktreePath, ['add', '-A']);
    if (!addRes.ok) return { ok: false, errorCode: 'CANDIDATE_STAGE_FAILED', detail: addRes.stderr };
    const commitRes = runGit(workerWorktreePath, ['commit', '-m', options.commitMessage || 'chore(workflow): freeze candidate']);
    if (!commitRes.ok) return { ok: false, errorCode: 'CANDIDATE_COMMIT_FAILED', detail: commitRes.stderr };
  }

  // Re-verify clean working tree
  const verifyClean = runGit(workerWorktreePath, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (!verifyClean.ok || verifyClean.stdout.length > 0) {
    return { ok: false, errorCode: 'CANDIDATE_NOT_CLEAN_AFTER_FREEZE' };
  }

  const headRes = runGit(workerWorktreePath, ['rev-parse', 'HEAD']);
  const treeRes = runGit(workerWorktreePath, ['rev-parse', 'HEAD^{tree}']);
  const parentsRes = runGit(workerWorktreePath, ['rev-list', '--parents', '-n', '1', 'HEAD']);
  const diffStatRes = runGit(workerWorktreePath, ['diff', '--numstat', `${baseCommitSha}..HEAD`]);
  const patchRes = runGit(workerWorktreePath, ['diff', '--binary', `${baseCommitSha}..HEAD`]);

  const parentParts = parentsRes.stdout.split(/\s+/).slice(1);
  const patchHash = crypto.createHash('sha256').update(patchRes.stdout).digest('hex');

  return {
    ok: true,
    wasDirtyBeforeFreeze: isDirty,
    candidate: {
      commitSha: headRes.stdout,
      baseCommitSha,
      parentShas: parentParts,
      treeSha: treeRes.stdout,
      diffStat: diffStatRes.stdout,
      patchHash,
    },
  };
}

function deliverToLocalBranch(runGit, workspacePath, {
  targetBranch, // e.g. 'main' or 'feature/x'
  commitSha,
  expectedTargetHeadSha, // 40-zeros if creating new branch
  allowUnownedBranch = false,
  workflowId = 'wf-1',
}) {
  const fullRef = targetBranch.startsWith('refs/heads/') ? targetBranch : `refs/heads/${targetBranch}`;
  const shortBranch = fullRef.replace(/^refs\/heads\//, '');

  // RV-27: Branch ownership check
  const isWorkflowOwned = shortBranch.startsWith(`aha/wf-${workflowId}/`);
  if (!isWorkflowOwned && !allowUnownedBranch) {
    return {
      ok: false,
      errorCode: 'BRANCH_OWNERSHIP_REJECTED',
      detail: `Branch '${shortBranch}' is outside workflow namespace 'aha/wf-${workflowId}/*' and lacks explicit user approval binding`,
    };
  }

  // Verify current ref OID matches expectedTargetHeadSha
  const currentRefRes = runGit(workspacePath, ['rev-parse', '--verify', '--quiet', fullRef]);
  const currentOid = currentRefRes.ok ? currentRefRes.stdout : '0000000000000000000000000000000000000000';
  if (currentOid !== expectedTargetHeadSha) {
    return {
      ok: false,
      errorCode: 'CAS_TARGET_HEAD_MISMATCH',
      expectedTargetHeadSha,
      actualTargetHeadSha: currentOid,
    };
  }

  // If branch already exists, verify fast-forward ancestry
  if (currentOid !== '0000000000000000000000000000000000000000') {
    const ancestorRes = runGit(workspacePath, ['merge-base', '--is-ancestor', currentOid, commitSha]);
    if (!ancestorRes.ok) {
      return {
        ok: false,
        errorCode: 'NON_FAST_FORWARD_REJECTED',
        expectedTargetHeadSha,
        commitSha,
      };
    }
  }

  // RV-12a/b/c: Check if targetBranch is checked out in any worktree
  const wtListRes = runGit(workspacePath, ['worktree', 'list', '--porcelain']);
  if (!wtListRes.ok) {
    return { ok: false, errorCode: 'WORKTREE_LIST_FAILED', detail: wtListRes.stderr };
  }
  const worktrees = parseWorktreeListPorcelain(wtListRes.stdout);
  const checkedOutWt = worktrees.find((wt) => wt.branch === fullRef);

  if (checkedOutWt) {
    // Resolve actual git dir for this worktree
    const gitDirRes = runGit(checkedOutWt.worktree, ['rev-parse', '--git-dir']);
    const resolvedGitDir = path.resolve(checkedOutWt.worktree, gitDirRes.stdout);
    const activeOp = hasGitOperationInProgress(resolvedGitDir);
    if (activeOp) {
      return {
        ok: false,
        errorCode: 'TARGET_WORKTREE_GIT_OP_IN_PROGRESS',
        marker: activeOp,
        worktree: checkedOutWt.worktree,
      };
    }
    const wtStatus = runGit(checkedOutWt.worktree, ['status', '--porcelain', '-z', '--untracked-files=all']);
    if (!wtStatus.ok || wtStatus.stdout.length > 0) {
      return {
        ok: false,
        errorCode: 'TARGET_WORKTREE_DIRTY',
        worktree: checkedOutWt.worktree,
      };
    }
    const wtHead = runGit(checkedOutWt.worktree, ['rev-parse', 'HEAD']);
    if (!wtHead.ok || wtHead.stdout !== expectedTargetHeadSha) {
      return {
        ok: false,
        errorCode: 'TARGET_WORKTREE_HEAD_MISMATCH',
        expectedTargetHeadSha,
        actualWorktreeHead: wtHead.stdout,
      };
    }
    const ffRes = runGit(checkedOutWt.worktree, ['merge', '--ff-only', commitSha]);
    if (!ffRes.ok) {
      return {
        ok: false,
        errorCode: 'TARGET_WORKTREE_FF_FAILED',
        detail: ffRes.stderr,
      };
    }
    const postHead = runGit(checkedOutWt.worktree, ['rev-parse', 'HEAD']);
    const postStatus = runGit(checkedOutWt.worktree, ['status', '--porcelain', '-z', '--untracked-files=all']);
    return {
      ok: true,
      mode: 'checked-out-worktree-ff-only',
      worktree: checkedOutWt.worktree,
      deliveredCommitSha: postHead.stdout,
      worktreeCleanAfterMerge: postStatus.stdout.length === 0,
    };
  }

  // Non-checked-out branch: atomic CAS update-ref
  const updateRes = runGit(workspacePath, ['update-ref', fullRef, commitSha, expectedTargetHeadSha]);
  if (!updateRes.ok) {
    return {
      ok: false,
      errorCode: 'UPDATE_REF_CAS_FAILED',
      detail: updateRes.stderr,
    };
  }
  const verifyRef = runGit(workspacePath, ['rev-parse', fullRef]);
  return {
    ok: true,
    mode: 'update-ref-cas',
    deliveredCommitSha: verifyRef.stdout,
  };
}

async function main() {
  const rootDir = path.join(__dirname, 'p0-f-i-git-data');
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.mkdirSync(rootDir, { recursive: true });

  const emptyHooksDir = path.join(rootDir, 'empty-hooks');
  const emptyConfigFile = path.join(rootDir, 'empty.gitconfig');
  fs.mkdirSync(emptyHooksDir, { recursive: true });
  fs.writeFileSync(emptyConfigFile, '', 'utf8');

  const runGit = createHardenedGitRunner({ emptyHooksDir, emptyConfigFile });

  const upstreamBare = path.join(rootDir, 'upstream.git');
  const serviceBare = path.join(rootDir, 'service-bare.git');
  const workspaceDir = path.join(rootDir, 'workspace');
  const workerWtClean = path.join(rootDir, 'worker-wt-clean');
  const workerWtDirty = path.join(rootDir, 'worker-wt-dirty');

  // 1. Initialize upstream bare & workspace
  runGit(rootDir, ['init', '--bare', '--initial-branch=main', upstreamBare]);
  runGit(rootDir, ['init', '--initial-branch=main', workspaceDir]);
  runGit(workspaceDir, ['remote', 'add', 'origin', upstreamBare]);

  fs.writeFileSync(path.join(workspaceDir, 'app.txt'), 'line 1\n', 'utf8');
  runGit(workspaceDir, ['add', 'app.txt']);
  runGit(workspaceDir, ['commit', '-m', 'initial commit']);
  runGit(workspaceDir, ['push', '-u', 'origin', 'main']);

  const baseCommitSha = runGit(workspaceDir, ['rev-parse', 'HEAD']).stdout;

  // 2. Plant malicious hooks and malicious config in workspace .git to test RV-25 / RV-26
  const pwnedMarker = path.join(rootDir, 'pwned-by-hook.txt');
  const hooksDir = path.join(workspaceDir, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const hookName of ['pre-commit', 'post-commit', 'pre-merge-commit', 'post-merge', 'pre-push', 'update']) {
    const hookPath = path.join(hooksDir, hookName);
    fs.writeFileSync(
      hookPath,
      `#!/bin/sh\necho "pwned by ${hookName}" > "${pwnedMarker.replace(/\\/g, '/')}"\nexit 1\n`,
      'utf8',
    );
  }
  // Also append malicious fsmonitor / hooksPath to workspace/.git/config
  const repoConfigPath = path.join(workspaceDir, '.git', 'config');
  fs.appendFileSync(
    repoConfigPath,
    `\n[core]\n\thooksPath = ${hooksDir.replace(/\\/g, '/')}\n\tfsmonitor = "cmd /c echo pwned > ${pwnedMarker.replace(/\\/g, '/')}"\n`,
    'utf8',
  );

  // 3. Initialize service private bare repo (RV-25)
  runGit(rootDir, ['init', '--bare', serviceBare]);

  // 4. Create worker worktrees on detached HEAD from baseCommitSha
  runGit(workspaceDir, ['worktree', 'add', '--detach', workerWtClean, baseCommitSha]);
  runGit(workspaceDir, ['worktree', 'add', '--detach', workerWtDirty, baseCommitSha]);

  // Test F1: Worker clean commit -> freezeCandidate
  fs.writeFileSync(path.join(workerWtClean, 'app.txt'), 'line 1\nline 2 from clean worker\n', 'utf8');
  runGit(workerWtClean, ['add', 'app.txt']);
  runGit(workerWtClean, ['commit', '-m', 'feat: clean worker change']);
  const freezeCleanResult = freezeCandidate(runGit, workerWtClean, baseCommitSha, { autoCommitDirty: false });

  // Test F2: Worker dirty tree -> freezeCandidate with autoCommitDirty=false (should reject) vs autoCommitDirty=true (should freeze)
  fs.writeFileSync(path.join(workerWtDirty, 'app.txt'), 'line 1\nline 2 from dirty worker\n', 'utf8');
  fs.writeFileSync(path.join(workerWtDirty, 'new-file.txt'), 'untracked file content\n', 'utf8');
  const freezeDirtyRejected = freezeCandidate(runGit, workerWtDirty, baseCommitSha, { autoCommitDirty: false });
  const freezeDirtyAutoCommitted = freezeCandidate(runGit, workerWtDirty, baseCommitSha, {
    autoCommitDirty: true,
    commitMessage: 'feat: auto-frozen dirty worker candidate',
  });

  // Test F3: Branch ownership check (RV-27)
  const unownedBranchRejected = deliverToLocalBranch(runGit, workspaceDir, {
    targetBranch: 'main',
    commitSha: freezeCleanResult.candidate.commitSha,
    expectedTargetHeadSha: baseCommitSha,
    allowUnownedBranch: false,
    workflowId: 'wf-1',
  });

  // Test F4: Deliver to non-checked-out workflow-owned branch via CAS update-ref
  const ownedBranch = 'aha/wf-wf-1/wi-1';
  const deliverNewOwnedBranch = deliverToLocalBranch(runGit, workspaceDir, {
    targetBranch: ownedBranch,
    commitSha: freezeCleanResult.candidate.commitSha,
    expectedTargetHeadSha: '0000000000000000000000000000000000000000',
    allowUnownedBranch: false,
    workflowId: 'wf-1',
  });

  // Test F5: CAS mismatch on non-checked-out branch (RV-19 / DL-18)
  const deliverCasMismatch = deliverToLocalBranch(runGit, workspaceDir, {
    targetBranch: ownedBranch,
    commitSha: freezeDirtyAutoCommitted.candidate.commitSha,
    expectedTargetHeadSha: '0000000000000000000000000000000000000000', // stale!
    allowUnownedBranch: false,
    workflowId: 'wf-1',
  });

  // Test F6: Non-fast-forward rejection on non-checked-out branch (diverged commits)
  const deliverNonFastForward = deliverToLocalBranch(runGit, workspaceDir, {
    targetBranch: ownedBranch,
    commitSha: freezeDirtyAutoCommitted.candidate.commitSha, // sibling commit off baseCommitSha, not descendant of freezeCleanResult
    expectedTargetHeadSha: freezeCleanResult.candidate.commitSha,
    allowUnownedBranch: false,
    workflowId: 'wf-1',
  });

  // Test F7: Checked-out target branch when worktree is DIRTY (RV-12b)
  fs.writeFileSync(path.join(workspaceDir, 'dirty-scratch.txt'), 'uncommitted user edit\n', 'utf8');
  const deliverCheckedOutDirtyRejected = deliverToLocalBranch(runGit, workspaceDir, {
    targetBranch: 'main',
    commitSha: freezeCleanResult.candidate.commitSha,
    expectedTargetHeadSha: baseCommitSha,
    allowUnownedBranch: true, // approved target
    workflowId: 'wf-1',
  });
  fs.rmSync(path.join(workspaceDir, 'dirty-scratch.txt'), { force: true });

  // Test F8: Checked-out target branch when MERGE_HEAD is present (RV-12b)
  const mergeHeadMarker = path.join(workspaceDir, '.git', 'MERGE_HEAD');
  fs.writeFileSync(mergeHeadMarker, baseCommitSha + '\n', 'utf8');
  const deliverCheckedOutMergeHeadRejected = deliverToLocalBranch(runGit, workspaceDir, {
    targetBranch: 'main',
    commitSha: freezeCleanResult.candidate.commitSha,
    expectedTargetHeadSha: baseCommitSha,
    allowUnownedBranch: true,
    workflowId: 'wf-1',
  });
  fs.rmSync(mergeHeadMarker, { force: true });

  // Test F9: Checked-out target branch when worktree is CLEAN (RV-12a / RV-12c)
  const deliverCheckedOutCleanSuccess = deliverToLocalBranch(runGit, workspaceDir, {
    targetBranch: 'main',
    commitSha: freezeCleanResult.candidate.commitSha,
    expectedTargetHeadSha: baseCommitSha,
    allowUnownedBranch: true,
    workflowId: 'wf-1',
  });
  const mainWorkingTreeFileContent = fs.readFileSync(path.join(workspaceDir, 'app.txt'), 'utf8');

  // Test F10: Service bare repo isolated fetch + push with empty lease for first push (RV-25, RV-29)
  // Fetch candidate commit from workerWtClean into serviceBare
  const fetchIntoServiceBare = runGit(serviceBare, [
    'fetch',
    '--no-tags',
    workerWtClean,
    `${freezeCleanResult.candidate.commitSha}:refs/candidates/cand-1`,
  ]);

  // First push of new PR branch `aha/wf-wf-1/pr-1` to upstreamBare using empty lease `--force-with-lease=refs/heads/aha/wf-wf-1/pr-1:`
  const firstPushEmptyLeaseSuccess = runGit(serviceBare, [
    'push',
    '--porcelain',
    '--force-with-lease=refs/heads/aha/wf-wf-1/pr-1:',
    upstreamBare,
    `${freezeCleanResult.candidate.commitSha}:refs/heads/aha/wf-wf-1/pr-1`,
  ]);

  // Repeat first-push empty lease when remote branch ALREADY exists -> must fail closed (RV-29)!
  const secondPushEmptyLeaseRejected = runGit(serviceBare, [
    'push',
    '--porcelain',
    '--force-with-lease=refs/heads/aha/wf-wf-1/pr-1:',
    upstreamBare,
    `${freezeDirtyAutoCommitted.candidate.commitSha}:refs/heads/aha/wf-wf-1/pr-1`,
  ]);

  // Verify malicious hook / fsmonitor marker was NEVER created
  const maliciousHookTriggered = fs.existsSync(pwnedMarker);

  // Test P0-I: Local HTTP GitHub API fixture server + PR diff snapshot verification (RV-28, RV-30)
  const recordedPrRequests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const auth = req.headers['authorization'] || '';
    recordedPrRequests.push({
      method: req.method,
      url: req.url,
      hasBearerToken: auth.startsWith('Bearer ghp_mock_'),
      body: rawBody ? JSON.parse(rawBody) : null,
    });

    if (!auth.startsWith('Bearer ghp_mock_')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Bad credentials' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/repos/ahastudio/demo/pulls') {
      const payload = JSON.parse(rawBody);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          number: 42,
          html_url: 'http://127.0.0.1/ahastudio/demo/pull/42',
          state: 'open',
          head: { ref: payload.head, sha: freezeCleanResult.candidate.commitSha },
          base: { ref: payload.base, sha: baseCommitSha },
          title: payload.title,
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // Compute PR diff snapshot from serviceBare using merge-base(baseCommitSha, commitSha)..commitSha
  const mergeBaseRes = runGit(serviceBare, ['merge-base', baseCommitSha, freezeCleanResult.candidate.commitSha]);
  const prDiffFilesRes = runGit(serviceBare, ['diff', '--name-status', `${mergeBaseRes.stdout}..${freezeCleanResult.candidate.commitSha}`]);
  const prDiffPatchRes = runGit(serviceBare, ['diff', '--binary', `${mergeBaseRes.stdout}..${freezeCleanResult.candidate.commitSha}`]);
  const prDiffHash = crypto.createHash('sha256').update(prDiffPatchRes.stdout).digest('hex');

  const approvalSnapshot = {
    commitSha: freezeCleanResult.candidate.commitSha,
    expectedTargetHeadSha: baseCommitSha,
    diffHash: prDiffHash,
    files: prDiffFilesRes.stdout.split(/\r?\n/).filter(Boolean),
  };

  // 1) Missing/invalid credentials -> fail closed
  const unauthResp = await fetch(`http://127.0.0.1:${port}/repos/ahastudio/demo/pulls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Unauthorized PR', head: 'aha/wf-wf-1/pr-1', base: 'main' }),
  });

  // 2) Authorized PR creation after verified push and matching ApprovalSnapshot
  const authResp = await fetch(`http://127.0.0.1:${port}/repos/ahastudio/demo/pulls`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ghp_mock_valid_token',
    },
    body: JSON.stringify({
      title: 'feat: clean worker change',
      body: `Candidate: ${approvalSnapshot.commitSha}\nDiffHash: ${approvalSnapshot.diffHash}`,
      head: 'aha/wf-wf-1/pr-1',
      base: 'main',
    }),
  });
  const createdPr = await authResp.json();
  server.close();

  const report = {
    p0F: {
      freezeCleanResult,
      freezeDirtyRejected,
      freezeDirtyAutoCommitted,
      unownedBranchRejected,
      deliverNewOwnedBranch,
      deliverCasMismatch,
      deliverNonFastForward,
      deliverCheckedOutDirtyRejected,
      deliverCheckedOutMergeHeadRejected,
      deliverCheckedOutCleanSuccess,
      mainWorkingTreeUpdatedCorrectly: mainWorkingTreeFileContent === 'line 1\nline 2 from clean worker\n',
      fetchIntoServiceBareOk: fetchIntoServiceBare.ok,
      firstPushEmptyLeaseSuccessOk: firstPushEmptyLeaseSuccess.ok,
      secondPushEmptyLeaseRejectedOk: !secondPushEmptyLeaseRejected.ok,
      secondPushEmptyLeaseStderr: secondPushEmptyLeaseRejected.stderr,
      maliciousHookTriggered,
    },
    p0I: {
      approvalSnapshot,
      unauthStatus: unauthResp.status,
      authStatus: authResp.status,
      createdPr,
      recordedPrRequestsCount: recordedPrRequests.length,
    },
  };

  const reportJson = JSON.stringify(report, null, 2);
  fs.writeFileSync(path.join(__dirname, 'p0-f-i-report.json'), reportJson, 'utf8');
  console.log(reportJson);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
