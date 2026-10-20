import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

// Warning 61 names a command that was asked for and not found, and whoever
// sends the request chooses that name: any HTTP request, MQTT message or
// MultiSync packet.  Its text was shown as markup in two places:
//   - the warnings banner on every page (innerHTML) and the warning's help
//     modal title (.html()).  Fixed in fpp 69b499d9f ("fix(security): escape
//     warning text where it's shown").
//   - the Health Check page, whose streamed status scripts put it inside
//     .html("...").  Fixed in fpp 8f713e7d1 ("fix(js): Render streamed output
//     as inert text; gate streamed-script eval (#3051)"), which escapes
//     scripts/healthCheck's status strings.
// A "command" named <img src=x onerror=...> ran its script wherever the
// warning appeared, for as long as it was up (15 minutes).

const PAYLOAD = '<img src=x onerror=window.__fppTestsWarning=1>';

async function raiseWarning(request: APIRequestContext) {
  await request.post('/api/command', { data: { command: PAYLOAD, args: [] } });
  await expect.poll(async () => {
    const status = await (await request.get('/api/system/status')).json();
    return (status.warningInfo ?? []).some((w: any) => w.id == 61 && String(w.message).includes(PAYLOAD));
  }, { timeout: 15_000 }).toBe(true);
}

test('the warnings banner and its help modal show a warning as text', async ({ page, request }) => {
  await raiseWarning(request);
  await page.goto('/index.php');
  const banner = page.locator('#warningsDiv');
  await expect(banner).toContainText('No command found', { timeout: 15_000 });
  await expect(banner).toContainText(PAYLOAD);
  await expect(banner.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__fppTestsWarning)).toBeUndefined();

  await banner.locator('a[data-warning-idx]', { hasText: 'No command found' }).click();
  const title = page.locator('#warningHelpDialog .modal-title');
  await expect(title).toContainText(PAYLOAD);
  await expect(title.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__fppTestsWarning)).toBeUndefined();
});

test('the Health Check page shows a warning as text', async ({ page, request }) => {
  test.setTimeout(120_000);
  await raiseWarning(request);
  // This page has the banner too, which is not what is under test here (and
  // was fixed later): the browser's status polls lose their warnings, and the
  // check reads them on the server, from fppd's warnings.json.
  await page.route(/\/api\/(system|fppd)\/status/, async (route) => {
    const response = await route.fetch();
    let json;
    try {
      json = await response.json();
    } catch {
      return route.fulfill({ response });
    }
    delete json.warnings;
    delete json.warningInfo;
    return route.fulfill({ response, json });
  });
  await page.goto('/healthCheck.php');
  // Starts itself on load; the button is enabled again once it is done.
  await expect(page.locator('#btnStartHealthCheck')).not.toHaveClass(/disabled/, { timeout: 90_000 });
  const cell = page.locator('.description', { hasText: 'FPPD Warnings' }).locator('xpath=../..');
  await expect(cell).not.toContainText('Running...');
  // The control: the warning reached the check, as a warning.
  await expect(cell.locator('.text-warning')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__fppTestsWarning)).toBeUndefined();
});
