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
const repo = mkdtempSync(join(tmpdir(), 'pr156-opencode-repo-'));
execFileSync('git', ['init', '-q'], { cwd: repo });
const result = { schemaVersion: 1, checks: {}, screenshots: [] };
let app;
let window;

function opencodeProcesses() {
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-Process opencode -ErrorAction SilentlyContinue | Select-Object Id,StartTime,Path | ConvertTo-Json -Compress"], { encoding: 'utf8' });
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

try {
  result.before = opencodeProcesses();
  app = await electron.launch({
    executablePath: resolve(executable),
    args: [resolve(appRoot), `--user-data-dir=${resolve(output, 'user-data')}`, '--no-sandbox'],
    env: { ...process.env, TERM: 'xterm-256color', ELECTRON_ENABLE_LOGGING: '1' },
  });
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(8000);
  await window.getByRole('button', { name: /Host CLI/ }).click();
  await window.locator('select.lobby-backend-select').first().selectOption('opencode');
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
  await window.waitForTimeout(20000);
  result.during = opencodeProcesses();
  result.body = await window.locator('body').innerText();
  const screenshot = resolve(output, 'O1-before-quit.png');
  await window.screenshot({ path: screenshot, fullPage: true });
  result.screenshots.push(screenshot);
  await app.close();
  app = null;
  await new Promise((resolveWait) => setTimeout(resolveWait, 5000));
  result.after = opencodeProcesses();
  const started = result.during.some((row) => !result.before.some((old) => old.Id === row.Id));
  const leaked = result.after.some((row) => !result.before.some((old) => old.Id === row.Id));
  result.checks.O1 = {
    result: started && !leaked ? 'pass' : 'fail',
    observed: `started=${started}; newProcessesAfterQuit=${result.after.filter((row) => !result.before.some((old) => old.Id === row.Id)).length}`,
  };
} catch (error) {
  result.error = String(error?.stack ?? error);
  if (window) {
    result.failureBody = await window.locator('body').innerText().catch(() => '');
    const screenshot = resolve(output, 'O1-failure.png');
    await window.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    result.screenshots.push(screenshot);
  }
  if (app) result.checks.O1 = { result: 'fail', observed: result.error };
} finally {
  writeFileSync(resolve(output, 'opencode-quit-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (app) await app.close().catch(() => {});
}
console.log(JSON.stringify(result));
if (result.error || result.checks.O1?.result === 'fail') process.exitCode = 1;
