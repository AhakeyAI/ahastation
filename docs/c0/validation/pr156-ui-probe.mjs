import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [executable, outDir, modulesRoot] = process.argv.slice(2);
if (!executable || !outDir || !modulesRoot) throw new Error('usage: pr156-ui-probe.mjs <exe> <out-dir> <node_modules>');
const require = createRequire(resolve(modulesRoot, 'package.json'));
const { _electron: electron } = require('playwright');
const output = resolve(outDir);
mkdirSync(output, { recursive: true });
const userData = resolve(output, 'user-data');
const app = await electron.launch({
  executablePath: resolve(executable),
  args: [`--user-data-dir=${userData}`, '--disable-gpu', '--no-sandbox'],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
});
const result = { schemaVersion: 1, checks: {}, screenshots: [] };
try {
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(15_000);
  result.title = await window.title();
  result.bodyText = await window.locator('body').innerText();
  result.buttons = await window.locator('button').allTextContents();
  result.dialogErrors = await window.locator('[role="dialog"] [role="alert"], .error, .error-banner').allTextContents();
  result.checks.B1 = {
    result: result.title.length > 0 && result.bodyText.trim().length > 0 ? 'pass' : 'fail',
    observed: `window title=${result.title}; body chars=${result.bodyText.trim().length}; dialogs=${result.dialogErrors.length}`,
  };
  const initialScreenshot = resolve(output, 'B1-initial.png');
  await window.screenshot({ path: initialScreenshot, fullPage: true });
  result.screenshots.push(initialScreenshot);
  const deviceButton = window.getByRole('button', { name: '设备就绪' });
  result.checks.B2 = { result: 'fail', observed: '设备就绪 button not found' };
  if (await deviceButton.count()) {
    await deviceButton.click();
    await window.waitForTimeout(5000);
    result.afterDeviceText = await window.locator('body').innerText();
    const authorized = result.afterDeviceText.includes('已授权');
    const rejected = result.afterDeviceText.includes('被拒绝');
    const stale = result.afterDeviceText.includes('进入会议后测试');
    result.checks.B2 = {
      result: (authorized || rejected) && !stale ? 'pass' : 'fail',
      observed: `authorized=${authorized}; rejected=${rejected}; stale=${stale}`,
    };
    const screenshot = resolve(output, 'B2-device-ready.png');
    await window.screenshot({ path: screenshot, fullPage: true });
    result.screenshots.push(screenshot);
  }
} finally {
  writeFileSync(resolve(output, 'probe-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  await app.close();
}
console.log(JSON.stringify(result));
