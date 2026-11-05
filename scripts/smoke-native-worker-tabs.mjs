// Run against the local Vite server. All IPC/CLI output comes from an isolated
// renderer fixture; this never starts a real model or reads personal profiles.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.goto('http://127.0.0.1:5173/tests/fixtures/native-worker-tabs.html');
  await page.waitForFunction(() => !!window.workerTabsFixture);
  await page.evaluate(() => window.workerTabsFixture.spawn('worker-a', 'Inspect architecture'));
  const a = page.getByRole('tab', { name: /Codex · Inspect architecture/ });
  await a.waitFor();
  assert.equal(await a.getAttribute('aria-selected'), 'true');
  await page.getByText('原生 CLI 会话运行中', { exact: false }).waitFor();
  const terminal = page.locator('.real-terminal:visible');
  await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent?.includes('initial output worker-a'));
  await page.evaluate(() => window.workerTabsFixture.output('worker-a', 'LIVE_OUTPUT_A\r\n'));
  await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent?.includes('LIVE_OUTPUT_A'));
  await page.evaluate(() => window.workerTabsFixture.spawn('worker-b', 'Run verification'));
  const b = page.getByRole('tab', { name: /Codex · Run verification/ });
  await b.waitFor();
  assert.equal(await b.getAttribute('aria-selected'), 'true');
  assert.equal(await terminal.count(), 1);
  await page.evaluate(() => window.workerTabsFixture.output('worker-a', 'BACKGROUND_OUTPUT_A\r\n'));
  assert.equal((await terminal.textContent()).includes('BACKGROUND_OUTPUT_A'), false);
  await a.click();
  await page.waitForFunction(() => [...document.querySelectorAll('.real-terminal')].some(el => el.checkVisibility() && el.textContent?.includes('BACKGROUND_OUTPUT_A')));
  await page.evaluate(() => window.workerTabsFixture.finish('worker-a'));
  await a.getByText('已验收').waitFor();
  await b.click(); await a.click();
  assert.match(await terminal.textContent(), /BACKGROUND_OUTPUT_A/);
  await page.evaluate(() => window.workerTabsFixture.reopen('worker-a'));
  assert.equal(await page.getByRole('tab', { name: /Codex · Inspect architecture/ }).count(), 1);
  let ledger = await page.evaluate(() => window.workerTabsFixture.ledger());
  assert.equal(ledger.manualStarts, 0);
  assert.equal(ledger.attached.filter(id => id === 'worker-a').length, 1);
  await b.getByRole('button', { name: '关闭', exact: true }).click();
  await page.evaluate(() => window.workerTabsFixture.output('worker-a', 'AFTER_CLOSE\r\n'));
  assert.equal(await page.getByRole('tab', { name: /Codex · Run verification/ }).count(), 0);
  // A fast task may already be verifying when React receives its first frame.
  await page.evaluate(() => window.workerTabsFixture.spawn('worker-fast', 'Fast task', 'verifying'));
  await page.getByRole('tab', { name: /Codex · Fast task/ }).waitFor();
  const artifactDir = join(tmpdir(), 'ahastation-worker-tabs-smoke');
  await mkdir(artifactDir, { recursive: true });
  const screenshot = join(artifactDir, 'native-worker-tabs.png');
  await page.screenshot({ path: screenshot });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, screenshot, modelCalls: 0, manualCliStarts: 0 }));
} finally { await browser.close(); }
