import { test, expect } from './fixtures';
import { routePluginsPage } from './plugins-page';
import { container } from './container';

// The Installed Plugins tab's heading and its action buttons (Check for
// Updates, Reinstall All, ...): beside each other on a wide window, and on a
// phone-width one the buttons above the heading.

test.skip(!container, 'serves the plugin list from the test, in the run-web.sh container');

test('Installed Plugins heading sits beside the buttons on a wide window and under them on a phone', async ({ page, baseURL }) => {
  // Regression: f441216d5.  The heading and the buttons were side by side at
  // every width; on a phone the button row wrapped and crowded the heading.
  await routePluginsPage(page, baseURL!, []);
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto('/plugins.php');
  await page.locator('#pluginTopTabs .nav-link[data-top-tab="installed"]').click();
  const heading = page.locator('#manageHeading');
  const button = page.locator('#checkAllUpdatesBtn');
  await expect(heading).toBeVisible({ timeout: 30_000 });
  const wideH = (await heading.boundingBox())!;
  const wideB = (await button.boundingBox())!;
  // The control: wide, the button is on the heading's row, to its right.
  expect(wideB.x).toBeGreaterThan(wideH.x + wideH.width - 1);
  expect(Math.abs(wideB.y - wideH.y)).toBeLessThan(wideH.height);

  await page.setViewportSize({ width: 400, height: 900 });
  await expect.poll(async () => {
    const h = (await heading.boundingBox())!;
    const b = (await button.boundingBox())!;
    return b.y + b.height <= h.y + 1;
  }, { message: 'buttons end above the heading', timeout: 10_000 }).toBe(true);
});
