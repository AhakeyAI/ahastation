import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { materializeFiles, safeRelative } from '../dist-electron/collaboration/git-files.js';
import { git } from '../dist-electron/collaboration/workspaces.js';

test('collaboration file references reject foreign-platform roots and alternate separators on every platform', () => {
  const unsafe = [
    '', '/private', 'C:/private', 'C:private', 'c:', '\\private', '\\\\server\\share',
    'a\\b', 'a/b:c', 'a/stream:$DATA', 'a\0b', '.', '..', '../private',
    'a/../private', './private', 'a/./b', 'a//b', 'a/', '.git/config', 'a/.GIT/config',
  ];
  for (const path of unsafe) {
    assert.throws(() => safeRelative(path), /安全的仓库内相对路径/, JSON.stringify(path));
  }
});

test('collaboration file references preserve canonical repository-relative paths', () => {
  for (const path of ['README.md', 'src/app.ts', '材料/中文 文件.txt', 'dir/.github/workflows/build.yml', 'a..b/file']) {
    assert.equal(safeRelative(path), path);
  }
});

test('materialized Git files accept an authorized root alias and reject an escaping child alias', { timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'station-materialize-alias-'));
  const repo = join(root, 'repo');
  const bare = join(root, 'remote.git');
  const authorized = join(root, 'authorized-real');
  const alias = join(root, 'authorized-alias');
  const outside = join(root, 'outside');
  const previousSSH = process.env.GIT_SSH_COMMAND;
  const previousVariant = process.env.GIT_SSH_VARIANT;
  try {
    await Promise.all([repo, bare, authorized, outside].map(path => mkdir(path)));
    await git(bare, ['init', '--bare']);
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['config', 'core.autocrlf', 'false']);
    await git(repo, ['config', 'user.name', 'Station Fixture']);
    await git(repo, ['config', 'user.email', 'fixture@example.invalid']);
    const bytes = Buffer.from([0, 255, 13, 10, 128, 1, 0]);
    await mkdir(join(repo, 'assets'));
    await writeFile(join(repo, 'assets', 'payload.bin'), bytes);
    await git(repo, ['add', '--', 'assets/payload.bin']);
    await git(repo, ['commit', '-m', 'Owned binary material fixture']);
    const commit = await git(repo, ['rev-parse', 'HEAD']);

    // Retain normal Git pack/ref checks while redirecting SSH to our local bare
    // repository; the canonical GitHub identity never causes a network call.
    const transport = join(root, 'local-ssh.mjs');
    await writeFile(transport, `import {spawn} from 'node:child_process';const mode=process.argv.some(a=>a.includes('git-receive-pack'))?'receive-pack':'upload-pack';const child=spawn('git',[mode,${JSON.stringify(bare)}],{stdio:'inherit'});child.on('exit',code=>process.exit(code??1));`);
    process.env.GIT_SSH_COMMAND = '"' + process.execPath.replaceAll('\\', '/') + '" "' + transport.replaceAll('\\', '/') + '"';
    process.env.GIT_SSH_VARIANT = 'ssh';
    await git(repo, ['remote', 'add', 'origin', 'git@github.com:station-fixture/materialize-alias.git']);
    await git(repo, ['push', 'origin', 'main']);
    const ref = { repository: 'https://github.com/station-fixture/materialize-alias', commit, paths: ['assets/payload.bin'] };

    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(authorized, alias, linkType);
    const destination = join(alias, 'inputs');
    const paths = await materializeFiles(repo, ref, destination, alias);
    assert.deepEqual(paths, [join(destination, 'assets', 'payload.bin')]);
    assert.deepEqual(await readFile(paths[0]), bytes);
    assert.deepEqual(await readFile(join(authorized, 'inputs', 'assets', 'payload.bin')), bytes);

    const sentinel = Buffer.from('owned external sentinel\r\n');
    await writeFile(join(outside, 'payload.bin'), sentinel);
    const blocked = join(alias, 'blocked');
    await mkdir(blocked);
    await symlink(outside, join(blocked, 'assets'), linkType);
    await assert.rejects(materializeFiles(repo, ref, blocked, alias), /输入文件的实际目录超出授权范围/);
    assert.deepEqual(await readFile(join(outside, 'payload.bin')), sentinel);
    assert.deepEqual(await readdir(outside), ['payload.bin']);
  } finally {
    if (previousSSH === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = previousSSH;
    if (previousVariant === undefined) delete process.env.GIT_SSH_VARIANT;
    else process.env.GIT_SSH_VARIANT = previousVariant;
    await rm(root, { recursive: true, force: true });
  }
});
