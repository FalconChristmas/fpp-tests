import { test, expect } from './fixtures';

// The Effects page polls api/fppd/effects once a second for the running
// effects.  When fppd isn't answering (here: the test fails the request),
// it says so once and stops polling until the page is reloaded.

test('with fppd not answering the Effects page asks once, says so, and stops', async ({ page }) => {
  // Regression: 5069c6452.  A failed request was retried at once, with no
  // delay, so the page spun at 100% CPU firing requests (and opening an
  // error dialog per failure) for as long as fppd was down.
  let asked = 0;
  await page.route('**/api/fppd/effects', (route) => {
    asked++;
    return route.fulfill({ status: 502, body: '' });
  });
  await page.goto('/effects.php');
  await expect.poll(() => asked, { timeout: 15_000 }).toBeGreaterThan(0);
  const dialog = page.locator('.modal.show');
  await expect(dialog).toContainText('Failed to refresh running effects, reload page to try again.');
  await page.waitForTimeout(3000);
  expect(asked).toBe(1);

  // The control: a reload tries again, and with fppd back the page keeps
  // polling as before, about once a second.
  await page.unroute('**/api/fppd/effects');
  let polled = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/api/fppd/effects')) polled++;
  });
  await page.reload();
  await page.waitForTimeout(3500);
  expect(polled).toBeGreaterThanOrEqual(3);
  expect(polled).toBeLessThanOrEqual(6);
});
