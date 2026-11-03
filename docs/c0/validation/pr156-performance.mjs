import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const [executable, outDir, modulesRoot, appRoot] = process.argv.slice(2);
if (!executable || !outDir || !modulesRoot || !appRoot) throw new Error('exe/out/modules/appRoot required');
const require = createRequire(resolve(modulesRoot, 'package.json'));
const { _electron: electron } = require('playwright');
const output = resolve(outDir);
mkdirSync(output, { recursive: true });
const userData = resolve(output, 'user-data');
const repo = mkdtempSync(join(tmpdir(), 'pr156-perf-repo-'));
execFileSync('git', ['init', '-q'], { cwd: repo });
const result = { schemaVersion: 1, checks: {}, performance: {}, screenshots: [] };
const app = await electron.launch({
  executablePath: resolve(executable),
  args: [resolve(appRoot), `--user-data-dir=${userData}`, '--no-sandbox'],
  env: { ...process.env, TERM: 'xterm-256color', ELECTRON_ENABLE_LOGGING: '1' },
});
const rootPid = app.process().pid;
const window = await app.firstWindow();
await window.waitForLoadState('domcontentloaded');
await window.waitForTimeout(8000);

function processes() {
  const marker = `pr156-${Date.now()}-${Math.random()}`;
  const script = `# ${marker}\nGet-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,KernelModeTime,UserModeTime | ConvertTo-Json -Compress`;
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 20000 });
  const rows = JSON.parse(raw || '[]');
  const all = (Array.isArray(rows) ? rows : [rows]).filter((row) => !String(row.CommandLine ?? '').includes(marker));
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of all) {
      if (descendants.has(row.ParentProcessId) && !descendants.has(row.ProcessId)) {
        descendants.add(row.ProcessId);
        changed = true;
      }
    }
  }
  return all.filter((row) => descendants.has(row.ProcessId)).map((row) => ({
    pid: row.ProcessId,
    role: String(row.CommandLine ?? '').includes('--type=renderer') ? 'renderer'
      : String(row.CommandLine ?? '').includes('--type=gpu-process') ? 'gpu'
      : String(row.CommandLine ?? '').includes('--type=utility') ? 'utility'
      : String(row.CommandLine ?? '').includes('--type=zygote') ? 'zygote' : 'main',
    seconds: (Number(row.KernelModeTime ?? 0) + Number(row.UserModeTime ?? 0)) / 10_000_000,
  }));
}

async function sample(name, seconds = 30) {
  const started = Date.now();
  const before = new Map(processes().map((row) => [row.pid, row]));
  const beforeCpus = cpus();
  await window.waitForTimeout(seconds * 1000);
  const elapsed = (Date.now() - started) / 1000;
  const after = processes();
  const afterCpus = cpus();
  const byRole = {};
  for (const row of after) {
    const previous = before.get(row.pid);
    if (!previous) continue;
    const percent = Math.max(0, row.seconds - previous.seconds) / elapsed * 100;
    byRole[row.role] = (byRole[row.role] ?? 0) + percent;
  }
  let totalDelta = 0;
  let idleDelta = 0;
  for (let i = 0; i < Math.min(beforeCpus.length, afterCpus.length); i++) {
    const beforeTimes = beforeCpus[i].times;
    const afterTimes = afterCpus[i].times;
    totalDelta += Object.keys(afterTimes).reduce((sum, key) => sum + afterTimes[key] - beforeTimes[key], 0);
    idleDelta += afterTimes.idle - beforeTimes.idle;
  }
  const systemCpuPercent = totalDelta > 0 ? Math.max(0, (1 - idleDelta / totalDelta) * 100) : null;
  result.performance[name] = { seconds: elapsed, cpuPercentByRole: byRole, systemCpuPercent, processCount: after.length };
}

async function snap(name) {
  const path = resolve(output, `${name}.png`);
  await window.screenshot({ path, fullPage: true });
  result.screenshots.push(path);
}

try {
  await sample('lobby', 30);
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

  const mic = window.getByRole('button', { name: /^(麦克风|取消静音|聆听中)/ });
  const micDisabled = await mic.isDisabled();
  if (!micDisabled && (await mic.innerText()).trim() !== '取消静音') await mic.click();
  await window.waitForTimeout(2000);
  const muted = (await mic.innerText()).trim() === '取消静音';
  result.checks.V1 = {
    result: micDisabled ? 'not-applicable' : muted ? 'pass' : 'fail',
    observed: `micDisabled=${micDisabled}; muted=${muted}; system mic icon not inspected`,
  };
  await sample(micDisabled ? 'meeting-idle-mic-unavailable' : 'meeting-muted', 30);
  await snap('V1-muted');

  const foregroundAnimations = await window.evaluate(() => Array.from(document.querySelectorAll('*'))
    .filter((element) => getComputedStyle(element).animationName !== 'none').length);
  await app.evaluate(async ({ BrowserWindow }) => {
    const probe = new BrowserWindow({ width: 320, height: 240, show: true });
    globalThis.__pr156SecondWindow = probe;
    await probe.loadURL('about:blank');
    probe.focus();
  });
  await window.waitForTimeout(1500);
  const background = await window.evaluate(() => ({
    windowActive: document.documentElement.dataset.windowActive,
    visibility: document.visibilityState,
    animations: Array.from(document.querySelectorAll('*'))
      .map((element) => getComputedStyle(element).animationPlayState)
      .filter((state) => state === 'paused').length,
  }));
  result.checks.V3 = {
    result: background.windowActive !== 'false' ? 'fail' : foregroundAnimations === 0 ? 'not-applicable' : 'pass',
    observed: JSON.stringify({ foregroundAnimations, ...background }),
  };
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__pr156SecondWindow?.close();
    globalThis.__pr156SecondWindow = null;
    BrowserWindow.getAllWindows()[0].focus();
  });
  await window.bringToFront();
  await window.waitForTimeout(500);

  await window.emulateMedia({ colorScheme: 'dark' });
  await window.waitForTimeout(1500);
  await snap('V4-dark');
  const dark = await window.evaluate(() => ({
    darkMedia: matchMedia('(prefers-color-scheme: dark)').matches,
    bodyColor: getComputedStyle(document.body).color,
    blurredElements: Array.from(document.querySelectorAll([
      '.mtg-header', '.toolbar', '.tab-strip', '.stage-share-pill',
      '.workspace-now-card', '.workspace-task-card', '.tiles--overlay .tile',
      '.tiles-bar', '.tiles-detail', '.dock-sidebar', '.dock-detail',
      '.participant-tabs', '.host-terminal-strip', '.stage-banner', '.tile-status',
      '.tiles-gallery-actions', '.worker-card-status-badge', '.worker-card-terminal-btn',
    ].join(','))).filter((element) => {
      const style = getComputedStyle(element);
      return style.backdropFilter && style.backdropFilter !== 'none';
    }).length,
  }));
  result.checks.V4 = {
    result: dark.darkMedia && dark.blurredElements === 0 ? 'pass' : 'fail',
    observed: JSON.stringify(dark),
  };

  if (!micDisabled) {
    await mic.click();
    await sample('meeting-mic-open', 30);
  }
} catch (error) {
  result.error = String(error?.stack ?? error);
  result.failureBody = await window.locator('body').innerText().catch(() => '');
} finally {
  writeFileSync(resolve(output, 'performance-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  await app.close().catch(() => {});
}
console.log(JSON.stringify(result));
if (result.error) process.exitCode = 1;
