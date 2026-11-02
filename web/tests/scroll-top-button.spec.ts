import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The red "Top" button floats at the top right of a page that has been scrolled
// and takes it back to the top.

async function openScrollable(page: Page, width: number) {
  await page.setViewportSize({ width, height: 400 });
  await page.goto('/settings.php');
  await page.waitForFunction(() => typeof (window as any).scrollToTop === 'function' && document.readyState === 'complete');
  // The page scrolls itself to the top once, shortly after it loads.
  await page.waitForTimeout(800);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeGreaterThan(200);
}

for (const [label, width] of [['wide', 1280], ['small', 800]] as const) {
  test(`the Top button shows once a ${label} window is scrolled and takes the page back to the top`, async ({ page }) => {
    // Regression: d316e1ee0.  A page scrolled down had no way back up but
    // dragging; the button is hidden at the top, shown past 40px and
    // scrollToTop() resets the scroll.
    // Regression: 70130e768.  The first version hid the button below the
    // 991px wide-menu breakpoint, so a phone or a narrow window never got it.
    // Also 1aab94a92: scrollToTop() sets document.scrollingElement as well,
    // for Safari (Chromium scrolls by documentElement, so this suite cannot
    // see that line).
    await openScrollable(page, width);
    const top = page.locator('#scrollTopButton');
    await expect(top).toBeHidden();

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(top).toBeVisible();

    await top.click();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(top).toBeHidden();
  });
}
