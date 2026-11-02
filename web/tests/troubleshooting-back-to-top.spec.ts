import { test, expect } from './fixtures';

// Regression: b7203d6ea ("Add 'Back to top' button to troubleshooting page").
// The Troubleshooting page is long -- every command's output, one after the
// other -- and had no way back to the tab list but scrolling.  The button
// shows once the page is scrolled past 100px and takes it back to the top.

test('the Troubleshooting page\'s Back to top button returns the page to the top', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto('/troubleshooting.php');
  const button = page.locator('.back2top');
  await expect(button).toHaveCount(1);
  // The page has to be long enough to scroll; make sure it is, whatever the
  // commands' outputs come to.
  await page.evaluate(() => {
    const pad = document.createElement('div');
    pad.id = 'fpp-tests-pad';
    pad.style.height = '3000px';
    document.body.appendChild(pad);
  });
  await page.evaluate(() => window.scrollTo(0, 1500));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  await expect(button).toBeVisible();
  await button.click();
  await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5_000 }).toBe(0);
});
