import { test, expect } from './fixtures';
import { answerUpdateCheck } from './standin-http';

// The top menu marks the section a page belongs to (menu.inc's "active" class
// on one top-level entry, chosen by the page's $activeParentMenuItem).  About
// and System Stats are reached from the Help menu, not Status/Control.

const activeEntries = (page: import('@playwright/test').Page) =>
  page.locator('#fppMenuList > li.nav-item.active > a.nav-link').evaluateAll((as) => as.map((a) => (a.textContent ?? '').trim()));

test('the About page marks Help, not Status/Control, as its menu section', async ({ page }) => {
  // Regression: 177eb4d62.  about.php set $activeParentMenuItem to "status", so
  // the menu highlighted Status/Control while the page sat under Help.
  await answerUpdateCheck(page);
  await page.goto('/about.php');
  await expect(page.locator('#fppMenuList')).toBeAttached();
  expect(await activeEntries(page)).toEqual(['Help']);
});

test('the System Stats page marks Help, not Status/Control, as its menu section', async ({ page }) => {
  // Regression: 7032f93f0.  Same mistake in system-stats.php.
  await answerUpdateCheck(page);
  await page.goto('/system-stats.php');
  await expect(page.locator('#uptime-days')).toBeVisible();
  expect(await activeEntries(page)).toEqual(['Help']);
});
