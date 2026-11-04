import { test, expect } from './fixtures';

// The footer's FPP Mode drop-up: Player or Remote.  It saves fppMode and
// restarts fppd; the restart request is answered here, so fppd keeps
// running as it was.

test.afterEach(async ({ request }) => {
  await request.put('/api/settings/fppMode', { data: 'player', headers: { 'Content-Type': 'text/plain' } });
});

test("the footer's FPP Mode drop-up switches the player to remote and restarts fppd", async ({ page, request }) => {
  // Regression: 4b5272e92 ("restore fpp mode selection into footer").  The
  // UI redesign had dropped the mode selection, leaving no way to make a
  // player a remote from the page.
  const restarts: string[] = [];
  await page.route('**/api/system/fppd/restart**', (r) => { restarts.push(r.request().url()); return r.fulfill({ json: { status: 'OK' } }); });
  await page.goto('/index.php');
  const button = page.locator('#fppModeDropdownButton');
  await expect(button).toContainText('FPP Mode: Player');
  await button.click();
  await page.locator('#fppModeDropdown .dropdown-menu button', { hasText: /^Remote$/ }).click();
  await expect.poll(async () => (await (await request.get('/api/settings/fppMode')).json()).value, { timeout: 10_000 }).toBe('remote');
  await expect.poll(() => restarts.length, { timeout: 10_000 }).toBeGreaterThan(0);
});
