/** Keep genuine fixture failures visible, with script/network evidence. No retries. */
export async function openFixtureConversation(browser, origin, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  page.on('requestfailed', (request) => {
    errors.push(`${request.failure()?.errorText} ${new URL(request.url()).pathname}`);
  });
  try {
    await page.goto(`${origin}/?ui-fixture=unified`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByRole('button', { name: '对话', exact: true }).first().click({ timeout: 60000 });
    return page;
  } catch (error) {
    const body = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '(body unavailable)');
    await page.close();
    throw new Error(`${error.message}\nFixture load errors: ${JSON.stringify(errors)}\nFixture body: ${body.slice(0, 1200)}`, { cause: error });
  }
}
