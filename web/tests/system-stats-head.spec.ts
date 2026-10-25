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

test.describe('in a dark colour scheme', () => {
  test.use({ colorScheme: 'dark' });

  test('System Stats carries the shared head once, and still follows the theme', async ({ page }) => {
    // Regression: 9c16f43a7 ("Health and Stats dark mode") included
    // htmlMeta.inc a second time, after config.php, so the page carried two
    // of each meta tag and ran the theme script twice.  Once is enough for
    // the theme: with no Theme setting it follows the browser's dark scheme.
    await answerUpdateCheck(page);
    await page.goto('/system-stats.php');
    await expect(page.locator('#uptime-days')).toBeVisible();
    for (const meta of ['meta[name="viewport"]', 'meta[charset]', 'meta[name="color-scheme"]']) {
      expect(await page.locator(`head ${meta}`).count(), meta).toBe(1);
    }
    await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
  });
});
