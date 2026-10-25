import { test, expect } from './fixtures';
import type { Page, Request } from '@playwright/test';

// Regression: 0d1e698d2.  GH #3126: the Port Status page (currentmonitor.php)
// stopped test mode every time it was left, so a port test started on Channel
// Outputs was gone after a visit to Port Status.  The stop is there to end the
// page's own Count Pixels test, and is now sent only once that has been
// started.  fppd's half of the fix - /api/fppd/ports/stop ends only a
// pixel-count test - needs output port pins, which the container has none of,
// so only the page's half is tested here.
//
// Coverage: 5db6365eb sends that stop as a keepalive fetch from pagehide,
// where it was an XHR from beforeunload that Firefox cancels as the page goes
// (#2826).  Chromium, which this suite runs, sends either, so the tests here
// pass with or without it.

async function stopsSentOnLeave(page: Page, countPixels: boolean): Promise<number> {
  let stops = 0;
  // Counted as the browser sends it, not where it is routed: the stop leaves
  // the page as it unloads, and a request from a page that is going away can
  // miss the route (seen in a nightly: sent, never handed to the handler).
  const onRequest = (request: Request) => {
    if (new URL(request.url()).pathname.endsWith('/ports/stop')) {
      stops++;
    }
  };
  page.context().on('request', onRequest);
  // Answered here, so a Count Pixels starts nothing in the player.
  await page.context().route('**/api/fppd/ports/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
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
    page.context().off('request', onRequest);
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
