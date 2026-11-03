import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const [executable, outDir, modulesRoot, appRoot] = process.argv.slice(2);
if (!executable || !outDir || !modulesRoot) throw new Error('usage: pr156-meeting-flow.mjs <exe> <out-dir> <node_modules>');
const require = createRequire(resolve(modulesRoot, 'package.json'));
const { _electron: electron } = require('playwright');
const output = resolve(outDir);
mkdirSync(output, { recursive: true });
const userData = resolve(output, 'user-data');
const repo = mkdtempSync(join(tmpdir(), 'pr156-empty-repo-'));
execFileSync('git', ['init', '-q'], { cwd: repo });
const result = { schemaVersion: 1, checks: {}, repo, screenshots: [] };
let app;
let window;

async function launch() {
  app = await electron.launch({
    executablePath: resolve(executable),
    args: [
      ...(appRoot ? [resolve(appRoot)] : []),
      `--user-data-dir=${userData}`,
      '--disable-gpu',
      '--no-sandbox',
    ],
    env: { ...process.env, TERM: 'xterm-256color', ELECTRON_ENABLE_LOGGING: '1' },
  });
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(8000);
}
async function screenshot(name) {
  const path = resolve(output, `${name}.png`);
  await window.screenshot({ path, fullPage: true });
  result.screenshots.push(path);
}
async function body() { return window.locator('body').innerText(); }
async function saveStage(name) {
  result.stages ??= {};
  result.stages[name] = {
    body: await body(),
    titles: await window.locator('[title]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title'))),
  };
  await screenshot(name);
}
async function clickButton(name, exact = true) {
  const target = window.getByRole('button', { name, exact });
  await target.waitFor({ state: 'visible', timeout: 30_000 });
  await target.click();
}
async function waitText(text, timeout = 60_000) {
  await window.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
}
async function waitForBody(predicate, timeout = 240_000) {
  const deadline = Date.now() + timeout;
  while (!predicate(await body())) {
    if (Date.now() > deadline) return false;
    await window.waitForTimeout(1000);
  }
  return true;
}
async function waitForNotes(timeout = 240_000) {
  const deadline = Date.now() + timeout;
  while (await window.locator('.meeting-notes-grid li').count() === 0) {
    if (Date.now() > deadline) return false;
    await window.waitForTimeout(1000);
  }
  return true;
}

try {
  await launch();
  await window.getByRole('button', { name: /Host CLI/ }).click();
  await window.locator('select.lobby-backend-select').first().selectOption('codex');
  await window.waitForTimeout(2000);
  await clickButton('新建项目室');
  await app.evaluate(({ dialog, ipcMain }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    ipcMain.removeHandler('dialog:list-dir');
    ipcMain.handle('dialog:list-dir', async () => ({ ok: true, path: selected, parent: null, entries: [] }));
    ipcMain.removeHandler('dialog:confirm-cwd');
    ipcMain.handle('dialog:confirm-cwd', async () => selected);
  }, repo);
  await window.getByText('打开本机文件夹', { exact: true }).click();
  await clickButton('选择此目录');
  await waitText('讨论脑暴', 60_000);
  await saveStage('M1');
  const m1Text = result.stages.M1.body;
  result.checks.M1 = { result: m1Text.includes(repo) ? 'pass' : 'fail', observed: `repo visible=${m1Text.includes(repo)}` };

  await clickButton('开始');
  await waitText('小禾', 240_000);
  await waitText('子 Agent', 240_000);
  await window.waitForTimeout(3000);
  if ((await body()).includes('Trust this folder?')) {
    result.codexTrustApproved = true;
    await window.locator('.xterm textarea').last().focus();
    await window.keyboard.press('Enter');
    await window.waitForTimeout(3000);
  }
  await window.getByRole('tab', { name: '工作区', exact: true }).click();
  const m2NotesReady = await waitForNotes();
  await saveStage('M2');
  const m2Text = await body();
  result.checks.M2 = {
    result: m2Text.includes('产品专家') && m2Text.includes('子 Agent') && m2NotesReady ? 'pass' : 'fail',
    observed: `expert=${m2Text.includes('产品专家')}; subagent=${m2Text.includes('子 Agent')}; notesReady=${m2NotesReady}`,
  };

  const trust = window.getByRole('button', { name: /信任这个工作树并继续/ });
  if (await trust.count()) {
    await trust.click();
    result.checks.M3 = { result: 'pass', observed: 'Clicked Claude trust button' };
  } else {
    result.checks.M3 = { result: 'not-applicable', observed: 'Codex-backed expert; no Claude trust prompt appeared' };
  }

  await app.close();
  app = null;
  await launch();
  await clickButton('继续会议');
  await waitText('小禾', 120_000);
  await window.getByRole('tab', { name: '工作区', exact: true }).click();
  const m4NotesReady = await waitForNotes(60_000);
  await saveStage('M4');
  const m4Text = await body();
  result.checks.M4 = {
    result: m4NotesReady && m4Text.includes('已停止') ? 'pass' : 'fail',
    observed: `notesReady=${m4NotesReady}; stopped=${m4Text.includes('已停止')}`,
  };

  const stoppedRestart = window.getByRole('button', { name: '重新开始…', exact: true });
  await stoppedRestart.waitFor({ state: 'visible', timeout: 60_000 });
  await stoppedRestart.click();
  const confirm = window.getByRole('button', { name: '重新开始', exact: true });
  await confirm.waitFor({ state: 'visible', timeout: 30_000 });
  await confirm.click();
  await window.waitForTimeout(3000);
  await saveStage('M5');
  const subagentTabs = await window.locator('[role="tab"]').filter({ hasText: /子 Agent ·/ }).count();
  result.checks.M5 = { result: subagentTabs === 1 ? 'pass' : 'fail', observed: `subagent tabs=${subagentTabs}` };

  const meetingClose = window.locator('.tab-strip-item[aria-selected="true"] .tab-strip-close');
  await meetingClose.waitFor({ state: 'visible', timeout: 30_000 });
  await meetingClose.click();
  await clickButton('新建项目室');
  await app.evaluate(({ dialog, ipcMain }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    ipcMain.removeHandler('dialog:list-dir');
    ipcMain.handle('dialog:list-dir', async () => ({ ok: true, path: selected, parent: null, entries: [] }));
    ipcMain.removeHandler('dialog:confirm-cwd');
    ipcMain.handle('dialog:confirm-cwd', async () => selected);
  }, repo);
  await window.getByText('打开本机文件夹', { exact: true }).click();
  await clickButton('选择此目录');
  await window.waitForFunction(() => !document.body.innerText.includes('会议正在启动'), null, { timeout: 60000 })
    .catch(() => {});
  const skip = window.getByRole('button', { name: '先不用，我自己说', exact: true });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await window.waitForTimeout(2000);
  await saveStage('M6');
  const m6Text = await body();
  const noExpert = !m6Text.includes('产品专家');
  const noSubagent = !m6Text.includes('子 Agent ·');
  const noNotes = await window.locator('.meeting-notes-grid li').count() === 0;
  const noOldConversation = !m6Text.includes('欢迎小禾');
  const blank = noExpert && noSubagent && noNotes && noOldConversation;
  result.checks.M6 = { result: blank ? 'pass' : 'fail', observed: JSON.stringify({ noExpert, noSubagent, noNotes, noOldConversation }) };
} catch (error) {
  result.error = String(error?.stack ?? error);
  if (window) {
    result.failureBody = await body().catch(() => '');
    await screenshot('failure').catch(() => {});
  }
} finally {
  writeFileSync(resolve(output, 'meeting-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (app) await app.close().catch(() => {});
}
console.log(JSON.stringify(result));
if (result.error || Object.values(result.checks).some((check) => check.result === 'fail')) process.exitCode = 1;
