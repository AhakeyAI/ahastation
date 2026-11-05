import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveCodexRuntime } from '../dist-electron/backends/codex-adapter.js';

test('resolveCodexRuntime prefers an executable unpacked native binary', async (t) => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    t.skip('fixture currently targets the macOS ARM64 release build');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'ahastation-codex-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(
    root,
    'app.asar.unpacked/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
  );
  await mkdir(join(binary, '..'), { recursive: true });
  await writeFile(binary, '#!/bin/sh\nexit 0\n');
  await chmod(binary, 0o755);

  assert.equal(resolveCodexRuntime(root, { systemBinary: null }), await realpath(binary));
  assert.equal(resolveCodexRuntime(root, { systemBinary: null }).includes('app.asar/'), false);
});

test('Host prefers the installed executable used by the native CLI', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ahastation-system-codex-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await writeFile(binary, '#!/bin/sh\nexit 0\n');
  await chmod(binary, 0o755);
  assert.equal(await realpath(resolveCodexRuntime(root, { systemBinary: binary })), await realpath(binary));
});

test('Windows npm launcher resolves to its native executable instead of an unrelated bundled CLI', async (t) => {
  if (process.platform !== 'win32') { t.skip('Windows launcher layout'); return; }
  const root = await mkdtemp(join(tmpdir(), 'ahastation-codex-shim-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const triple = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const binary = join(root, `node_modules/@openai/codex/node_modules/@openai/codex-win32-${arch}/vendor/${triple}-pc-windows-msvc/bin/codex.exe`);
  await mkdir(join(binary, '..'), { recursive: true });
  await writeFile(binary, 'fixture');
  const shim = join(root, 'codex.cmd');
  await writeFile(shim, '@echo off');
  assert.equal(await realpath(resolveCodexRuntime(undefined, { systemBinary: shim })), await realpath(binary));
});
