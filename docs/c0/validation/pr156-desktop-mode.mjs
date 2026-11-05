import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const [executable, outDir, modulesRoot, appRoot] = process.argv.slice(2);
if (!executable || !outDir || !modulesRoot || !appRoot) throw new Error('exe/out/modules/appRoot required');
const require = createRequire(resolve(modulesRoot, 'package.json'));
const { _electron: electron } = require('playwright');
const output = resolve(outDir);
mkdirSync(output, { recursive: true });
const repo = mkdtempSync(join(tmpdir(), 'pr156-desktop-repo-'));
execFileSync('git', ['init', '-q'], { cwd: repo });
const result = { schemaVersion: 1, checks: {}, screenshots: [] };
const app = await electron.launch({
  executablePath: resolve(executable),
  args: [resolve(appRoot), `--user-data-dir=${resolve(output, 'user-data')}`, '--no-sandbox'],
  env: { ...process.env, TERM: 'xterm-256color' },
});
const window = await app.firstWindow();
async function snap(name) {
  const path = resolve(output, `${name}.png`);
  await window.screenshot({ path, fullPage: true });
  result.screenshots.push(path);
}
async function setMode(handheldMode) {
  const response = await window.evaluate((mode) => window.vibeMeet.setVoicePref({ handheldMode: mode }), handheldMode);
  if (!response.ok) throw new Error(`Failed to set ${handheldMode}: ${response.error}`);
  await window.waitForTimeout(1500);
}
try {
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(8000);
  await setMode('desktop');
  await window.reload();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(8000);
  await window.getByRole('button', { name: /Host CLI/ }).click();
  await window.locator('select.lobby-backend-select').first().selectOption('codex');
  await window.getByRole('button', { name: '新建项目室', exact: true }).click();
  await app.evaluate(({ dialog, ipcMain }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    ipcMain.removeHandler('dialog:list-dir');
    ipcMain.handle('dialog:list-dir', async () => ({ ok: true, path: selected, parent: null, entries: [] }));
    ipcMain.removeHandler('dialog:confirm-cwd');
    ipcMain.handle('dialog:confirm-cwd', async () => selected);
  }, repo);
  await window.getByText('打开本机文件夹', { exact: true }).click();
  await window.getByRole('button', { name: '选择此目录', exact: true }).click();
  await window.getByText('讨论脑暴', { exact: false }).waitFor({ state: 'visible', timeout: 60000 });
  await window.getByRole('button', { name: '先不用，我自己说', exact: true }).click();
  await window.waitForTimeout(3000);
  result.desktop = await window.evaluate(async () => ({
    preference: (await window.vibeMeet.getVoicePref()).handheldMode,
    navigation: document.querySelectorAll('.meeting-navigation').length,
    taskBoardVisible: Boolean(document.querySelector('.task-board, [class*="task-board"]')),
    width: window.innerWidth,
  }));
  result.checks.desktop = {
    result: result.desktop.preference === 'desktop' && result.desktop.navigation === 0 ? 'pass' : 'fail',
    observed: JSON.stringify(result.desktop),
  };
  await snap('desktop-mode');

  await setMode('auto');
  await window.reload();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(8000);
  result.auto = await window.evaluate(async () => ({
    preference: (await window.vibeMeet.getVoicePref()).handheldMode,
    navigation: document.querySelectorAll('.meeting-navigation').length,
    width: window.innerWidth,
  }));
  result.checks.autoRestored = {
    result: result.auto.preference === 'auto' ? 'pass' : 'fail',
    observed: JSON.stringify(result.auto),
  };
  await snap('auto-mode-restored');
} catch (error) {
  result.error = String(error?.stack ?? error);
  result.failureBody = await window.locator('body').innerText().catch(() => '');
} finally {
  try { await setMode('auto'); } catch (error) { result.restoreError = String(error); }
  writeFileSync(resolve(output, 'desktop-mode-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  await app.close().catch(() => {});
}
console.log(JSON.stringify(result));
if (result.error || Object.values(result.checks).some((check) => check.result === 'fail')) process.exitCode = 1;
