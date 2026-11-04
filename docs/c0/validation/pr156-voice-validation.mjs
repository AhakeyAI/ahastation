import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const [executable, outDir, modulesRoot, appRoot] = process.argv.slice(2);
if (!executable || !outDir || !modulesRoot || !appRoot) throw new Error('exe/out/modules/appRoot required');
const credentials = {
  appId: process.env.XFYUN_APPID,
  apiKey: process.env.XFYUN_APIKEY,
  apiSecret: process.env.XFYUN_APISECRET,
};
if (!credentials.appId || !credentials.apiKey || !credentials.apiSecret) throw new Error('XFYUN environment credentials required');
const require = createRequire(resolve(modulesRoot, 'package.json'));
const { _electron: electron } = require('playwright');
const output = resolve(outDir);
mkdirSync(output, { recursive: true });
const repo = mkdtempSync(join(tmpdir(), 'pr156-voice-repo-'));
execFileSync('git', ['init', '-q'], { cwd: repo });
const result = { schemaVersion: 1, checks: {}, performance: {}, screenshots: [] };
const privacyPath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\DeviceAccess\\Global\\{E5323777-F976-4f5b-9B55-B94699C46E44}';
let privacyExisted = false;
let app;
let window;
let rootPid;

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 20000 });
}
function readPrivacy() {
  const raw = ps(`$path = '${privacyPath}'; if ((Test-Path $path) -and ($null -ne (Get-ItemProperty -Path $path -Name Value -ErrorAction SilentlyContinue))) { (Get-ItemProperty -Path $path -Name Value).Value } else { '' }`);
  return raw.trim();
}
function setPrivacy(value) {
  ps(`$path = '${privacyPath}'; if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }; Set-ItemProperty -Path $path -Name Value -Value '${value}'`);
}
function restorePrivacy() {
  if (privacyExisted) setPrivacy('Allow');
  else ps(`$path = '${privacyPath}'; if (Test-Path $path) { Remove-ItemProperty -Path $path -Name Value -ErrorAction SilentlyContinue }`);
}
function speak(text) {
  ps(`Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft Huihui Desktop'); $s.Rate = -1; $s.Speak('${text}'); $s.Dispose()`);
}
function processes() {
  const marker = `pr156-${Date.now()}-${Math.random()}`;
  const raw = ps(`# ${marker}\nGet-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,KernelModeTime,UserModeTime | ConvertTo-Json -Compress`);
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
      : String(row.CommandLine ?? '').includes('--type=utility') ? 'utility' : 'main',
    seconds: (Number(row.KernelModeTime ?? 0) + Number(row.UserModeTime ?? 0)) / 10_000_000,
  }));
}
async function sample(name) {
  const started = Date.now();
  const before = new Map(processes().map((row) => [row.pid, row]));
  const beforeCpus = cpus();
  await window.waitForTimeout(30000);
  const elapsed = (Date.now() - started) / 1000;
  const after = processes();
  const afterCpus = cpus();
  const byRole = {};
  for (const row of after) {
    const previous = before.get(row.pid);
    if (!previous) continue;
    byRole[row.role] = (byRole[row.role] ?? 0) + Math.max(0, row.seconds - previous.seconds) / elapsed * 100;
  }
  let total = 0;
  let idle = 0;
  for (let i = 0; i < Math.min(beforeCpus.length, afterCpus.length); i++) {
    total += Object.keys(afterCpus[i].times).reduce((sum, key) => sum + afterCpus[i].times[key] - beforeCpus[i].times[key], 0);
    idle += afterCpus[i].times.idle - beforeCpus[i].times.idle;
  }
  result.performance[name] = { seconds: elapsed, cpuPercentByRole: byRole, systemCpuPercent: total > 0 ? (1 - idle / total) * 100 : null };
}
async function snap(name, desktop = false) {
  const path = resolve(output, `${name}.png`);
  if (desktop) {
    const png = await app.evaluate(async ({ desktopCapturer, screen }) => {
      const display = screen.getPrimaryDisplay();
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: {
        width: display.size.width * display.scaleFactor,
        height: display.size.height * display.scaleFactor,
      } });
      return sources[0]?.thumbnail.toPNG().toString('base64');
    });
    if (png) writeFileSync(path, Buffer.from(png, 'base64'));
  } else {
    await window.screenshot({ path, fullPage: true });
  }
  result.screenshots.push(path);
}

try {
  privacyExisted = readPrivacy() !== '';
  app = await electron.launch({
    executablePath: resolve(executable),
    args: [resolve(appRoot), `--user-data-dir=${resolve(output, 'user-data')}`, '--no-sandbox'],
    env: { ...process.env, TERM: 'xterm-256color', ELECTRON_ENABLE_LOGGING: '1' },
  });
  rootPid = app.process().pid;
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(8000);
  result.asrConfiguration = await window.evaluate(async (value) => {
    const response = await window.vibeMeet.setVoicePref({ xfyunAsr: value });
    return { ok: response.ok, error: response.error };
  }, credentials);
  if (!result.asrConfiguration.ok) throw new Error('ASR configuration rejected');

  await window.getByRole('button', { name: /Host CLI/ }).click();
  await window.locator('select.lobby-backend-select').first().selectOption('codex');
  await window.evaluate(() => window.vibeMeet.backendAuth.setDefaultWorkerBackend('codex-terminal'));
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

  const mic = window.getByRole('button', { name: /^(麦克风|取消静音|聆听中)/ });
  result.micInitiallyDisabled = await mic.isDisabled();
  if (result.micInitiallyDisabled) throw new Error('Microphone remained disabled after ASR configuration');
  if ((await mic.innerText()).trim() === '取消静音') await mic.click();
  await window.waitForTimeout(2000);
  await sample('meeting-muted');
  result.checks.V1 = {
    result: (await mic.innerText()).trim() === '取消静音' ? 'fail' : 'pending-visual-review',
    observed: 'Microphone muted for 30 seconds; inspect CPU and desktop microphone indicator',
  };
  await snap('V1-muted');

  await mic.click();
  await window.waitForTimeout(4000);
  await speak('你好 AhaStudio，这是第二轮语音验证。');
  await sample('meeting-mic-open');
  const v2Body = await window.locator('body').innerText();
  result.checks.V2 = {
    result: /第二轮|语音验证/.test(v2Body) ? 'pass' : 'fail',
    observed: `transcriptVisible=${/第二轮|语音验证/.test(v2Body)}; micLabel=${(await mic.innerText()).trim()}`,
  };
  await snap('V2-speech');

  if ((await mic.innerText()).trim() === '取消静音') await mic.click();
  setPrivacy('Deny');
  await window.waitForTimeout(1000);
  await mic.click();
  await window.waitForTimeout(3000);
  await snap('P1-denied', true);
  result.checks.P1 = { result: 'pending-visual-review', observed: 'Privacy value Deny; microphone clicked; native dialog screenshot captured' };
  ps("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')");
  await window.waitForTimeout(3000);
  await snap('P1-settings', true);

  restorePrivacy();
  await window.waitForTimeout(1000);
  const micAfter = window.getByRole('button', { name: /^(麦克风|取消静音|聆听中)/ });
  await micAfter.click();
  await window.waitForTimeout(4000);
  await speak('权限恢复验证');
  await window.waitForTimeout(5000);
  const p2Body = await window.locator('body').innerText();
  result.checks.P2 = {
    result: /权限恢复验证/.test(p2Body) ? 'pass' : 'pending-visual-review',
    observed: `transcriptVisible=${/权限恢复验证/.test(p2Body)}; micLabel=${(await micAfter.innerText()).trim()}`,
  };
  await snap('P2-restored');
} catch (error) {
  result.error = String(error?.stack ?? error);
  if (window) {
    result.failureBody = await window.locator('body').innerText().catch(() => '');
    await snap('failure').catch(() => {});
  }
} finally {
  try { restorePrivacy(); } catch (error) { result.privacyRestoreError = String(error); }
  writeFileSync(resolve(output, 'voice-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (app) await app.close().catch(() => {});
}
console.log(JSON.stringify(result));
if (result.error) process.exitCode = 1;
