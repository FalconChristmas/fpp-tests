import { test, expect } from './fixtures';

// The API page (Help > REST API, /api/) frames the Scalar viewer, /api/api.html.
// The frame is the page: it fills the window under the title, with no footer
// bar of Reboot / Restart buttons below it, and the title links to the viewer
// on its own to open in a tab.

test('the API page has the viewer fill the window, no footer, and a link to open it in its own tab', async ({ page }) => {
  // Regression: cc794cd9a.  The page kept the footer bar under the viewer and
  // sized the frame 25em short of the window to make room for it, leaving a
  // band of empty page; the viewer had no link out to a tab of its own.
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/api/');
  const frame = page.locator('#scalar-frame');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('src', '/api/api.html');

  const popOut = page.locator('h1.title a[href="/api/api.html"]');
  await expect(popOut).toHaveAttribute('target', '_blank');
  const [tab] = await Promise.all([page.context().waitForEvent('page'), popOut.click()]);
  await tab.waitForLoadState('domcontentloaded');
  expect(new URL(tab.url()).pathname).toBe('/api/api.html');
  await tab.close();

  expect(await page.locator('#footer').count(), 'the footer bar').toBe(0);
  // The frame ends close to the window's bottom edge, its height the window's
  // less 12em (the title and the menu above it take the rest), and the page does not scroll for it.
  const box = (await frame.boundingBox())!;
  const em = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
  const room = 900 - (box.y + box.height);
  expect(room, `frame ${JSON.stringify(box)}`).toBeLessThanOrEqual(2 * em);
  expect(box.height, `frame ${JSON.stringify(box)}`).toBeGreaterThanOrEqual(900 - 12 * em - 1);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(1);
});
