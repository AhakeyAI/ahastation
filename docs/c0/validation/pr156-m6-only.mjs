import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const [executable, outDir, modulesRoot, appRoot, existingUserData, repo] = process.argv.slice(2);
if (!executable || !outDir || !modulesRoot || !appRoot || !existingUserData || !repo) {
  throw new Error('exe/out/modules/appRoot/existingUserData/repo required');
}
const require = createRequire(resolve(modulesRoot, 'package.json'));
const { _electron: electron } = require('playwright');
const output = resolve(outDir);
mkdirSync(output, { recursive: true });
const result = { schemaVersion: 1, checks: {}, screenshots: [] };
const app = await electron.launch({
  executablePath: resolve(executable),
  args: [resolve(appRoot), `--user-data-dir=${resolve(existingUserData)}`, '--no-sandbox'],
  env: { ...process.env, TERM: 'xterm-256color', ELECTRON_ENABLE_LOGGING: '1' },
});
const window = await app.firstWindow();
try {
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(8000);
  await window.getByRole('button', { name: '继续会议', exact: true }).click();
  await window.waitForTimeout(8000);
  const meetingClose = window.locator('.tab-strip-item[aria-selected="true"] .tab-strip-close');
  await meetingClose.click();
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
  await window.waitForFunction(() => !document.body.innerText.includes('会议正在启动'), null, { timeout: 60000 })
    .catch(() => {});
  const skip = window.getByRole('button', { name: '先不用，我自己说', exact: true });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await window.waitForTimeout(2000);
  result.body = await window.locator('body').innerText();
  const noExpert = !result.body.includes('产品专家');
  const noSubagent = !result.body.includes('子 Agent ·');
  const noNotes = await window.locator('.meeting-notes-grid li').count() === 0;
  const noOldConversation = !result.body.includes('欢迎小禾');
  const blank = noExpert && noSubagent && noNotes && noOldConversation;
  result.checks.M6 = {
    result: blank ? 'pass' : 'fail',
    observed: JSON.stringify({ noExpert, noSubagent, noNotes, noOldConversation }),
  };
  const screenshot = resolve(output, 'M6.png');
  await window.screenshot({ path: screenshot, fullPage: true });
  result.screenshots.push(screenshot);
} catch (error) {
  result.error = String(error?.stack ?? error);
  result.failureBody = await window.locator('body').innerText().catch(() => '');
} finally {
  writeFileSync(resolve(output, 'm6-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  await app.close().catch(() => {});
}
console.log(JSON.stringify(result));
if (result.error || result.checks.M6?.result !== 'pass') process.exitCode = 1;
