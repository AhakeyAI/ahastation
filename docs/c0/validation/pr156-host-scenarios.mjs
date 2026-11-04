import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const [executable, outDir, modulesRoot, appRoot] = process.argv.slice(2);
if (!executable || !outDir || !modulesRoot || !appRoot) throw new Error('exe/out/modules/appRoot required');
const require = createRequire(resolve(modulesRoot, 'package.json'));
const { _electron: electron } = require('playwright');
const output = resolve(outDir);
mkdirSync(output, { recursive: true });
const repo = mkdtempSync(join(tmpdir(), 'pr156-host-repo-'));
execFileSync('git', ['init', '-q'], { cwd: repo });
const decisions = resolve(homedir(), 'Documents', 'AhaStation', 'decisions');
const result = { schemaVersion: 1, checks: {}, screenshots: [], repo };
const app = await electron.launch({
  executablePath: resolve(executable),
  args: [resolve(appRoot), `--user-data-dir=${resolve(output, 'user-data')}`, '--no-sandbox'],
  env: { ...process.env, TERM: 'xterm-256color', ELECTRON_ENABLE_LOGGING: '1' },
});
const window = await app.firstWindow();
await window.waitForLoadState('domcontentloaded');
await window.waitForTimeout(8000);
result.display = await app.evaluate(({ screen }) => screen.getPrimaryDisplay());

async function snap(name, desktop = false) {
  const path = resolve(output, `${name}.png`);
  if (desktop) {
    const png = await app.evaluate(async ({ desktopCapturer, screen }) => {
      const display = screen.getPrimaryDisplay();
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: display.size.width * display.scaleFactor,
          height: display.size.height * display.scaleFactor,
        },
      });
      return sources[0]?.thumbnail.toPNG().toString('base64');
    });
    if (png) writeFileSync(path, Buffer.from(png, 'base64'));
  } else {
    await window.screenshot({ path, fullPage: true });
  }
  result.screenshots.push(path);
}

function processCount(name) {
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `@(Get-Process -Name '${name}' -ErrorAction SilentlyContinue).Count`], { encoding: 'utf8' });
    return Number(raw.trim()) || 0;
  } catch {
    return 0;
  }
}

async function send(text) {
  const input = window.locator('textarea.drawer-input').last();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.fill(text);
  await input.press('Enter');
  const approve = window.locator('button.plan-modal-submit');
  await approve.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  if (await approve.isVisible().catch(() => false)) {
    result.planApprovals ??= [];
    result.planApprovals.push(await approve.innerText());
    await approve.click();
  }
  await window.waitForTimeout(5000);
  if ((await window.locator('body').innerText()).includes('Trust this folder?')) {
    result.codexTrustApproved = true;
    await window.locator('.xterm textarea').last().focus();
    await window.keyboard.press('Enter');
    await window.waitForTimeout(2000);
  }
  if ((await window.locator('body').innerText()).includes('Update available')) {
    result.codexUpdateSkipped = true;
    await window.locator('.xterm textarea').last().focus();
    await window.keyboard.press('Escape');
  }
}

async function waitFor(predicate, seconds = 180) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await window.waitForTimeout(2000);
  }
  return false;
}

function activatePid(pid) {
  return execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `(New-Object -ComObject WScript.Shell).AppActivate(${pid})`], { encoding: 'utf8' }).trim().endsWith('True');
}
async function checkV3() {
  const foregroundAnimations = await window.evaluate(() => Array.from(document.querySelectorAll('*'))
    .filter((element) => getComputedStyle(element).animationName !== 'none').length);
  const terminalPid = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-Process WindowsTerminal -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id"], { encoding: 'utf8' }).trim());
  if (!terminalPid || !activatePid(terminalPid)) {
    result.checks.V3 = { result: 'not-applicable', observed: 'No switchable Windows Terminal foreground window' };
    return;
  }
  await window.waitForTimeout(1500);
  const background = await window.evaluate(() => ({
    active: document.documentElement.dataset.windowActive,
    paused: Array.from(document.querySelectorAll('*')).filter((element) => getComputedStyle(element).animationPlayState === 'paused').length,
  }));
  const restored = activatePid(app.process().pid);
  await window.waitForTimeout(1500);
  const foreground = await window.evaluate(() => ({
    active: document.documentElement.dataset.windowActive,
    running: Array.from(document.querySelectorAll('*')).filter((element) => getComputedStyle(element).animationPlayState === 'running').length,
  }));
  result.checks.V3 = {
    result: restored && background.active === 'false' && background.paused > 0
      && foreground.active === 'true' && foreground.running > 0 ? 'pass' : 'fail',
    observed: JSON.stringify({ foregroundAnimations, background, restored, foreground }),
  };
}

function cpuSnapshot() {
  const rootPid = app.process().pid;
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,KernelModeTime,UserModeTime | ConvertTo-Json -Compress'], { encoding: 'utf8' });
  const parsed = JSON.parse(raw || '[]');
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ParentProcessId) && !descendants.has(row.ProcessId)) {
        descendants.add(row.ProcessId);
        changed = true;
      }
    }
  }
  return {
    processes: rows.filter((row) => descendants.has(row.ProcessId)).map((row) => ({
      pid: row.ProcessId,
      role: String(row.CommandLine ?? '').includes('--type=renderer') ? 'renderer'
        : String(row.CommandLine ?? '').includes('--type=gpu-process') ? 'gpu'
        : String(row.CommandLine ?? '').includes('--type=utility') ? 'utility' : 'main',
      seconds: (Number(row.KernelModeTime ?? 0) + Number(row.UserModeTime ?? 0)) / 10_000_000,
    })),
    cpus: cpus(),
  };
}
async function sampleAgent() {
  const started = Date.now();
  const before = cpuSnapshot();
  await window.waitForTimeout(30000);
  const elapsed = (Date.now() - started) / 1000;
  const after = cpuSnapshot();
  const byRole = {};
  for (const row of after.processes) {
    const previous = before.processes.find((candidate) => candidate.pid === row.pid);
    if (!previous) continue;
    byRole[row.role] = (byRole[row.role] ?? 0) + Math.max(0, row.seconds - previous.seconds) / elapsed * 100;
  }
  let total = 0;
  let idle = 0;
  for (let i = 0; i < Math.min(before.cpus.length, after.cpus.length); i++) {
    total += Object.keys(after.cpus[i].times).reduce((sum, key) => sum + after.cpus[i].times[key] - before.cpus[i].times[key], 0);
    idle += after.cpus[i].times.idle - before.cpus[i].times.idle;
  }
  result.performance = { agentRunning: { seconds: elapsed, cpuPercentByRole: byRole, systemCpuPercent: total > 0 ? (1 - idle / total) * 100 : null } };
}

try {
  await window.getByRole('button', { name: /Host CLI/ }).click();
  await window.locator('select.lobby-backend-select').first().selectOption('codex');
  result.workerBackendSetting = await window.evaluate(() =>
    window.vibeMeet.backendAuth.setDefaultWorkerBackend('codex-terminal'));
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
  await window.waitForTimeout(5000);

  if (process.env.PR156_SKIP_D1 !== '1') {
    mkdirSync(decisions, { recursive: true });
    const beforeDecisions = new Set(readdirSync(decisions, { withFileTypes: true })
      .filter((entry) => entry.isFile()).map((entry) => entry.name));
    await send('这两个方案我拿不准，用决策单让我选。方案 A 是现在发布，方案 B 是修复后发布，截止时间是明天下午五点。请直接创建决策单和日历提醒。');
    const decisionReady = await waitFor(() => readdirSync(decisions).some((name) =>
      name.endsWith('.ics') && !beforeDecisions.has(name)
      && beforeDecisions.has(name.replace(/\.ics$/, '.md')) === false
      && readdirSync(decisions).includes(name.replace(/\.ics$/, '.md'))), 180);
    const created = readdirSync(decisions).filter((name) => !beforeDecisions.has(name));
    const icsName = created.find((name) => name.endsWith('.ics'));
    const ics = icsName ? readFileSync(join(decisions, icsName), 'utf8') : '';
    result.checks.D1 = {
      result: decisionReady && /BEGIN:VALARM/.test(ics) && /TRIGGER:-PT15M/.test(ics)
        && /DTSTART:/.test(ics) ? 'pending-visual-review' : 'fail',
      observed: `newFiles=${created.join(',') || 'none'}; alarm15=${ics.includes('TRIGGER:-PT15M')}; calendarLaunchRequiresVisualReview=true`,
    };
    await snap('D1-decision', true);
  }

  await send('帮我用鼠标打开记事本，输入：你好 AhaStudio。请派出 Computer Use Worker 实际执行，不要只给操作步骤。');
  await checkV3().catch((error) => {
    result.checks.V3 = { result: 'not-run', observed: String(error) };
  });
  await sampleAgent();
  const notepadOpened = await waitFor(() => processCount('notepad') > 0, 240);
  await window.waitForTimeout(15000);
  await snap('C1-notepad', true);
  const c1Body = await window.locator('body').innerText();
  result.checks.C1 = {
    result: notepadOpened ? 'pending-visual-review' : 'fail',
    observed: `notepad=${notepadOpened}; computerUseLabel=${/Computer Use/i.test(c1Body)}; nativeError=${/libnut.*failed|input module failed/i.test(c1Body)}`,
  };

  if (notepadOpened) {
    await send('让刚才的 Computer Use Worker 在刚打开的记事本里按 cmd+a、cmd+c，然后按右箭头、回车、cmd+v。这样可用重复文本验证全选和复制，不要只解释。');
    await window.waitForTimeout(90000);
    await snap('C3-shortcuts', true);
    result.checks.C3 = { result: 'pending-visual-review', observed: 'Requested cmd+a/cmd+c and duplicate-by-paste; inspect desktop screenshot' };

    const longPage = resolve(output, 'long-page.html');
    writeFileSync(longPage, `<!doctype html><meta charset="utf-8"><title>PR156 scroll</title><body>${Array.from({ length: 30 }, (_, i) => `<h1 style="height:180px">Section ${i + 1}</h1>`).join('')}</body>`);
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath '${longPage.replaceAll("'", "''")}'`]);
    await window.waitForTimeout(5000);
    await snap('C4-before', true);
    await send('让 Computer Use Worker 在当前打开的长网页上向下滚动 3 格。用鼠标和滚动工具实际执行，不要只告诉我怎么做。');
    await window.waitForTimeout(90000);
    await snap('C4-after', true);
    result.checks.C4 = { result: 'pending-visual-review', observed: 'Long page opened and scroll down 3 requested; compare before/after screenshots' };
  } else {
    result.checks.C3 = { result: 'not-run', observed: 'C1 did not open Notepad' };
    result.checks.C4 = { result: 'not-run', observed: 'C1 did not create a usable Computer Use Worker' };
  }
  result.finalBody = await window.locator('body').innerText();
} catch (error) {
  result.error = String(error?.stack ?? error);
  result.failureBody = await window.locator('body').innerText().catch(() => '');
  await snap('failure').catch(() => {});
} finally {
  writeFileSync(resolve(output, 'host-scenarios-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  await app.close().catch(() => {});
}
console.log(JSON.stringify(result));
if (result.error) process.exitCode = 1;
