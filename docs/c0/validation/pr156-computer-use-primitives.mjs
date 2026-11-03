import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [executable, outDir, modulesRoot, appRoot] = process.argv.slice(2);
if (!executable || !outDir || !modulesRoot || !appRoot) throw new Error('exe/out/modules/appRoot required');
const require = createRequire(resolve(modulesRoot, 'package.json'));
const { _electron: electron } = require('playwright');
const output = resolve(outDir);
mkdirSync(output, { recursive: true });
const moduleUrl = pathToFileURL(resolve(appRoot, 'dist-electron/computer-use.js')).href;
const result = { schemaVersion: 1, checks: {}, actions: {}, screenshots: [] };
const app = await electron.launch({
  executablePath: resolve(executable),
  args: [resolve(appRoot), `--user-data-dir=${resolve(output, 'user-data')}`, '--no-sandbox'],
  env: { ...process.env, TERM: 'xterm-256color' },
});
const window = await app.firstWindow();
await window.waitForLoadState('domcontentloaded');
await window.waitForTimeout(3000);
result.display = await app.evaluate(({ screen }) => screen.getPrimaryDisplay());

async function call(action, ...args) {
  const response = await app.evaluate(async (_electron, { moduleUrl: url, action: name, args: values }) => {
    const path = process.getBuiltinModule('url').fileURLToPath(url);
    const module = process.getBuiltinModule('module').createRequire(path)(path);
    return module[name](...values);
  }, { moduleUrl, action, args });
  (result.actions[action] ??= []).push(response);
  return response;
}
async function snap(name) {
  const response = await call('takeScreenshot');
  if (response.ok) {
    const path = resolve(output, `${name}.png`);
    writeFileSync(path, Buffer.from(response.data.pngBase64, 'base64'));
    result.screenshots.push(path);
  }
}
function start(path, argument) {
  const escaped = path.replaceAll("'", "''");
  const argumentPart = argument ? ` -ArgumentList '${argument.replaceAll("'", "''")}'` : '';
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `(Start-Process -FilePath '${escaped}'${argumentPart} -PassThru).Id`], { encoding: 'utf8' });
  return Number(raw.trim());
}
function activate(pid) {
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `(New-Object -ComObject WScript.Shell).AppActivate(${pid})`], { encoding: 'utf8' });
  if (!raw.trim().endsWith('True')) throw new Error(`Could not activate PID ${pid}`);
}

try {
  const notepad = start('notepad.exe');
  await window.waitForTimeout(3000);
  activate(notepad);
  await window.waitForTimeout(500);
  const typed = await call('keyboardType', '你好 AhaStudio');
  await window.waitForTimeout(1000);
  await snap('C1-native');
  result.checks.C1Native = { result: typed.ok ? 'pending-visual-review' : 'fail', observed: JSON.stringify(typed) };

  for (const [key, modifiers] of [['a', ['cmd']], ['c', ['cmd']], ['right', []], ['enter', []], ['v', ['cmd']]]) {
    await call('keyboardPress', key, modifiers);
  }
  await window.waitForTimeout(1000);
  await snap('C3-native');
  result.checks.C3Native = {
    result: result.actions.keyboardPress?.every((entry) => entry.ok) ? 'pending-visual-review' : 'fail',
    observed: 'cmd+a/cmd+c/right/enter/cmd+v invoked through libnut',
  };

  const longPage = resolve(output, 'long-page.html');
  writeFileSync(longPage, `<!doctype html><meta charset="utf-8"><title>PR156 native scroll</title><body>${Array.from({ length: 30 }, (_, i) => `<h1 style="height:180px">Section ${i + 1}</h1>`).join('')}</body>`);
  const chrome = start('C:/Program Files/Google/Chrome/Application/chrome.exe', longPage);
  await window.waitForTimeout(5000);
  activate(chrome);
  await window.waitForTimeout(500);
  await snap('C4-native-before');
  const scrolled = await call('scroll', 360, 640, 'down', 3);
  await window.waitForTimeout(1000);
  await snap('C4-native-after');
  result.checks.C4Native = { result: scrolled.ok ? 'pending-visual-review' : 'fail', observed: JSON.stringify(scrolled) };
} catch (error) {
  result.error = String(error?.stack ?? error);
} finally {
  writeFileSync(resolve(output, 'computer-use-primitives-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  await app.close().catch(() => {});
}
console.log(JSON.stringify(result));
if (result.error) process.exitCode = 1;
