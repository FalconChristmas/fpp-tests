import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The update-available icon in the header bar: every page asks
// api/system/updateStatus (checkForFppUpdate) and shows a download icon,
// linking to the About page, when the answer offers a newer commit or
// release.  The answer is the test's here; what the PHP answers is
// update-status-releases.spec.ts's.

function status(over: Record<string, unknown> = {}) {
  return {
    status: 'OK', checked: true, branchUpgradeAvailable: false, branchUpgradeTarget: '', branchUpgradeVersion: '',
    isMajorVersionUpgrade: false, commitUpdateAvailable: false, remoteCommit: 'c0ffee012', currentBranch: 'fpp-tests',
    localCommit: 'c0ffee012', versionUnknown: false, isEndOfLife: false, latestMajorVersion: 0,
    forceOsUpgradeAvailable: false, ...over,
  };
}

async function openWith(page: Page, answer: Record<string, unknown>, width = 1600) {
  let asked = 0;
  await page.route('**/api/system/updateStatus*', (route) => {
    asked++;
    return route.fulfill({ json: answer });
  });
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/index.php');
  await expect.poll(() => asked, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as any).FPP_UPDATE_STATE?.answered)).toBe(true);
}

const icon = (page: Page) => page.locator('.header #navbarUpdateAvail');

test('the header shows a download icon to the About page when an update is available', async ({ page }) => {
  // Feature: a7b58ba76 (#2150).  Nothing on the pages said an update was
  // out; it showed only on the About page.
  await openWith(page, status({ commitUpdateAvailable: true, remoteCommit: 'f00dfeed1' }));
  await expect(icon(page)).toBeVisible();
  await expect(page.locator('#navbarUpdateAvailIcon')).toHaveAttribute('title', 'Software update available');
  await expect(icon(page).locator('a')).toHaveAttribute('href', 'about.php');

  // And a release branch upgrade names its target.
  await openWith(page, status({ branchUpgradeAvailable: true, branchUpgradeTarget: 'v98.2', branchUpgradeVersion: '98.2' }));
  await expect(icon(page)).toBeVisible();
  await expect(page.locator('#navbarUpdateAvailIcon')).toHaveAttribute('title', 'Upgrade to v98.2 available');

  // The control: with nothing newer there is no icon.
  await openWith(page, status());
  await expect(icon(page)).toBeHidden();
});

test('the update icon sits in the header bar, in orange, and shows on a narrow screen too', async ({ page }) => {
  // Regression: c13ed4eee.  The icon was an item of the navigation menu,
  // in the menu's own colour, so on a narrow screen it was folded away
  // with the menu behind the toggler.
  // (Below 992 px the menu folds behind its toggler; below 450 px the
  // header's left column, logo and all, is dropped too.)
  await openWith(page, status({ commitUpdateAvailable: true }), 700);
  await expect(page.locator('.navbar-toggler')).toBeVisible();
  await expect(page.locator('.headerLeft #navbarUpdateAvail')).toBeVisible();
  await expect(icon(page).locator('a')).toHaveCSS('color', 'rgb(245, 136, 34)');
});

test('the update icon does not make the header taller', async ({ page }) => {
  // Regression: c224e3694.  Moved into the header, the icon kept the
  // navigation menu's nav-item/nav-link styling, whose padding made the
  // header bar taller whenever an update was available.
  const heights: Record<string, number> = {};
  for (const [name, answer] of [['without', status()], ['with', status({ commitUpdateAvailable: true })]] as const) {
    await openWith(page, answer);
    await expect(icon(page)).toBeVisible({ visible: name === 'with' });
    heights[name] = (await page.locator('.header').boundingBox())!.height;
  }
  expect(heights.with, JSON.stringify(heights)).toBeLessThanOrEqual(heights.without + 0.5);
});
