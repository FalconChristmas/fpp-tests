import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// Regression: 0d1e698d2.  GH #3126: the Port Status page (currentmonitor.php)
// stopped test mode every time it was left, so a port test started on Channel
// Outputs was gone after a visit to Port Status.  The stop is there to end the
// page's own Count Pixels test, and is now sent only once that has been
// started.  fppd's half of the fix - /api/fppd/ports/stop ends only a
// pixel-count test - needs output port pins, which the container has none of,
// so only the page's half is tested here.

async function stopsSentOnLeave(page: Page, countPixels: boolean): Promise<number> {
  let stops = 0;
  // Answered here, so a Count Pixels starts nothing in the player.
  await page.context().route('**/api/fppd/ports/**', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/ports/stop')) {
      stops++;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  try {
    await page.goto('/currentmonitor.php');
    await page.waitForFunction(() => typeof (window as any).StopPixelCount === 'function');
    if (countPixels) {
      // Called directly: the button is hidden on a player with no current
      // sensors, which the container is.
      await page.evaluate(() => (window as any).CountPixels());
    }
    await page.goto('/index.php');
    // The stop is a keepalive fetch from pagehide; give it time to arrive.
    await page.waitForTimeout(1000);
    return stops;
  } finally {
    await page.context().unrouteAll({ behavior: 'ignoreErrors' });
  }
}

test('leaving Port Status leaves a test it did not start running', async ({ page }) => {
  expect(await stopsSentOnLeave(page, false)).toBe(0);
});

test('leaving Port Status after Count Pixels stops the count', async ({ page }) => {
  // The control: shows the request above is one this spec can see.
  expect(await stopsSentOnLeave(page, true)).toBe(1);
});
