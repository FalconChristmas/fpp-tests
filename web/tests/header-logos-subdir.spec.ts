import { test, expect } from './fixtures';

// The header bar's logos come from config.php's $themeInfo, and the header
// is drawn by pages outside the site root too: the API page is /api/.

test('the header logos load on a page in a subdirectory (/api/)', async ({ page }) => {
  // Regression: bbda19803.  HEADER_LOGO1/2 were relative paths
  // (images/redesign/...), which the API page asked for under /api/, where
  // nothing serves them: its header showed two broken images.
  const failed: string[] = [];
  page.on('response', (r) => {
    if (/\/images\/redesign\//.test(r.url()) && r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  await page.goto('/api/');
  for (const sel of ['.header img[src*="falconlogo"]', '.header img.fpp-logo']) {
    const img = page.locator(sel).first();
    await expect(img, sel).toHaveCount(1);
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0), { message: sel }).toBe(true);
  }
  expect(failed).toEqual([]);
  // The control: the same logos on a page at the root.
  await page.goto('/index.php');
  await expect.poll(() => page.locator('img.fpp-logo').first().evaluate((i: HTMLImageElement) => i.naturalWidth > 0)).toBe(true);
});
