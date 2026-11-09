import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

async function preview(t, query = '') {
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>
    <script type="module" src="/tests/fixtures/observe-scan-preview.jsx"></script></body></html>`;
  const server = await createServer({ server: { watch: null, host: '127.0.0.1', port: 0, open: false },
    logLevel: 'error', plugins: [{ name: 'scan-preview', configureServer(vite) {
      vite.middlewares.use('/__scan-preview', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml('/__scan-preview', html));
      });
    } }] });
  t.after(() => server.close()); await server.listen();
  const browser = await chromium.launch({ executablePath: process.env.STATION_CHROME, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__scan-preview${query}`);
  return { page, errors };
}

test('scan controls in real React: consent entry, adopted history, revoke and responsive layout', async (t) => {
  const { page, errors } = await preview(t);
  await page.getByRole('button', { name: '启用只读扫描' }).click();
  await page.getByText('本机会话与历史任务 · 4 项').click();
  assert.equal(await page.getByText('Read-only user session', { exact: false }).count(), 1);
  assert.equal(await page.getByText('已收编', { exact: false }).count(), 1);
  assert.equal(await page.getByText('C:/Projects/demo', { exact: true }).count(), 1);
  assert.ok(await page.getByRole('region', { name: 'example/team · 本机候选项目' }).isVisible());
  assert.equal(await page.getByText('工作树 · demo-feature · feature/project-discovery', { exact: true }).count(), 1);
  assert.ok(await page.getByText('会话归属尚未确认，暂不读取项目元数据。').isVisible());
  assert.ok(await page.getByRole('button', { name: '停用并清除授权' }).isVisible());
  if (process.env.STATION_UI_EVIDENCE_DIR) {
    await mkdir(process.env.STATION_UI_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.STATION_UI_EVIDENCE_DIR, 's4-directory-consent.png') });
  }
  await page.setViewportSize({ width: 800, height: 600 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: '停用并清除授权' }).click();
  await page.getByText('本机会话扫描未启用').waitFor();
  assert.equal(await page.getByText('Adopted session', { exact: false }).count(), 0);
  assert.equal(await page.getByRole('region', { name: 'example/team · 本机候选项目' }).count(), 0);
  assert.equal(await page.getByRole('region', { name: '待授权目录', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});

test('pending review handles cancel, errors and duplicate clicks; ignore/restore stays separate from grants', async (t) => {
  const { page, errors } = await preview(t);
  await page.getByRole('button', { name: '启用只读扫描' }).click();
  const pending = page.getByRole('region', { name: '待授权目录', exact: true });
  assert.ok(await pending.isVisible());
  assert.equal(await pending.getByText('pending-private · 2 个会话').count(), 1);
  assert.equal(await pending.getByText('Read-only user session', { exact: false }).count(), 0);
  await page.evaluate(() => { window.__scanTest.result = 'cancel'; });
  await page.getByRole('button', { name: '检查只读授权' }).click();
  assert.ok(await pending.isVisible());
  await page.evaluate(() => { window.__scanTest.result = 'error'; });
  await page.getByRole('button', { name: '检查只读授权' }).click();
  await page.getByRole('alert').getByText('授权暂不可用').waitFor();
  await page.evaluate(() => { window.__scanTest.result = 'deferred'; });
  await page.getByRole('button', { name: '检查只读授权' }).evaluate((button) => { button.click(); button.click(); });
  assert.equal(await page.evaluate(() => window.__scanTest.reviewCalls), 3);
  assert.ok(await page.getByRole('button', { name: '检查只读授权' }).isDisabled());
  await page.evaluate(() => { window.__scanTest.result = 'cancel'; window.__scanTest.release(); });
  await page.getByRole('button', { name: '忽略目录提醒' }).click();
  await page.getByRole('button', { name: '恢复已忽略项（1）' }).waitFor();
  assert.equal(await pending.count(), 0);
  await page.getByText('本机会话与历史任务 · 4 项').click();
  await page.getByRole('button', { name: '忽略会话：Read-only user session' }).click();
  assert.equal(await page.getByText('Read-only user session', { exact: false }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '忽略会话：Ownership unknown' }).count(), 0);
  await page.getByRole('button', { name: '恢复已忽略项（2）' }).click();
  await page.getByRole('button', { name: '忽略会话：Read-only user session' }).waitFor();
  assert.ok(await pending.isVisible());
  assert.ok(await page.getByText('只读扫描 · 已授权 1 个目录', { exact: true }).isVisible());
  await page.evaluate(() => { window.__scanTest.result = 'ok'; });
  await page.getByRole('button', { name: '检查只读授权' }).click();
  await page.getByText('只读扫描 · 已授权 2 个目录', { exact: true }).waitFor();
  assert.equal(await pending.count(), 0);
  assert.deepEqual(errors, []);
});

test('project-room onboarding uses consent, keeps cancellation pending and opens the real settings panel', async (t) => {
  const { page, errors } = await preview(t, '?rooms');
  const start = page.getByRole('button', { name: '选择只读扫描目录' });
  assert.equal(await page.getByText('不需要授权', { exact: false }).count(), 0);
  await page.evaluate(() => { window.__scanTest.result = 'cancel'; });
  await start.click();
  assert.equal(await page.evaluate(() => window.__scanTest.completed), 0);
  assert.ok(await start.isVisible());
  await page.evaluate(() => { window.__scanTest.result = 'error'; });
  await start.click(); await page.getByRole('alert').getByText('授权暂不可用').waitFor();
  assert.equal(await page.evaluate(() => window.__scanTest.completed), 0);
  await page.evaluate(() => { window.__scanTest.result = 'deferred'; });
  await start.evaluate((button) => { button.click(); button.click(); });
  assert.equal(await page.evaluate(() => window.__scanTest.allowCalls), 3);
  await page.evaluate(() => { window.__scanTest.result = 'ok'; window.__scanTest.release(); });
  await page.getByRole('button', { name: '查看扫描设置' }).click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'local-session-scan');
  assert.equal(await page.evaluate(() => window.__scanTest.completed), 1);
  assert.deepEqual(errors, []);
});
