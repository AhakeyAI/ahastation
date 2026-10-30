import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test('scan controls in real React: consent entry, adopted history, revoke and responsive layout', async (t) => {
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
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__scan-preview`);
  await page.getByRole('button', { name: '启用只读扫描' }).click();
  await page.getByText('本机会话与历史任务 · 3 项').click();
  assert.equal(await page.getByText('Read-only user session', { exact: false }).count(), 1);
  assert.equal(await page.getByText('已收编', { exact: true }).count(), 1);
  assert.equal(await page.getByText('C:/Projects/demo', { exact: false }).count(), 1);
  assert.ok(await page.getByRole('button', { name: '停用并清除授权' }).isVisible());
  if (process.env.STATION_UI_EVIDENCE_DIR) {
    await mkdir(process.env.STATION_UI_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.STATION_UI_EVIDENCE_DIR, 's2-scan-controls.png') });
  }
  await page.setViewportSize({ width: 800, height: 600 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: '停用并清除授权' }).click();
  await page.getByText('本机会话扫描未启用').waitFor();
  assert.equal(await page.getByText('Adopted session', { exact: false }).count(), 0);
  assert.deepEqual(errors, []);
});
