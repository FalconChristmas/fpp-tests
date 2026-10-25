import { test, expect } from './fixtures';
import { answerUpdateCheck } from './standin-http';

// Every page's <head> starts with common/htmlMeta.inc: the viewport and
// charset meta tags (and, since, the script applying the Theme setting).

test('System Stats carries the shared viewport and charset tags', async ({ page }) => {
  // Regression: 11ba118d8.  system-stats.php did not include htmlMeta.inc,
  // so it had no viewport tag: a phone drew it at desktop width, zoomed out.
  await answerUpdateCheck(page);
  await page.goto('/system-stats.php');
  await expect(page.locator('#uptime-days')).toBeVisible();
  const viewport = await page.locator('head meta[name="viewport"]').evaluateAll((ms) => ms.map((m) => m.getAttribute('content')));
  expect(viewport.length).toBeGreaterThan(0);
  expect(viewport.every((c) => /width=device-width/.test(c ?? ''))).toBe(true);
  expect(await page.locator('head meta[charset]').count()).toBeGreaterThan(0);
});
