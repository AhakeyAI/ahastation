import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as reserveSocket } from 'node:net';

/** Prepare a private module graph before navigation assertions begin. Servers
 * never share Vite's mutable optimizer cache, including under concurrent tests. */
export async function createReactBrowserFixture() {
  const folder = await mkdtemp(join(tmpdir(), 'station-react-browser-'));
  let server, browser;
  async function close() {
    await browser?.close();
    await server?.close();
    if (resolve(dirname(folder)) !== resolve(tmpdir()) || !basename(folder).startsWith('station-react-browser-')) {
      throw new Error('Unexpected browser fixture directory');
    }
    await rm(folder, { recursive: true, force: true });
  }
  try {
    const reservation = reserveSocket();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    server = await createServer({
      cacheDir: join(folder, 'vite-cache'),
      server: { watch: null, host: '127.0.0.1', port, strictPort: true, open: false },
      logLevel: 'error',
    });
    await server.listen();
    // A cold main.tsx transform waits for dependency discovery and optimization.
    // This is fixture preparation, not a retry or an increased page timeout.
    await server.transformRequest('/src/main.tsx');
    await server.waitForRequestsIdle();
    browser = await chromium.launch({
      executablePath: process.env.STATION_CHROME,
      headless: true,
      args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE [::1]'],
    });
    const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (...args) => {
      const page = await newPage(...args);
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin === origin ? route.continue() : route.abort();
      });
      return page;
    };
    return { browser, origin, close };
  } catch (error) {
    await close();
    throw error;
  }
}
