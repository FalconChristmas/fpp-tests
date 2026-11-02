import { test, expect } from './fixtures';

// A link to filemanager.php#tab-<name> opens that tab.
//
// Regression: 06d7f9e02.  The page opens the tab a URL names by finding the
// tab link whose data-bs-target is that hash; the tab links had only an href,
// so every link to a tab (the crash warning's "File Manager", a bookmark)
// landed on Sequences.

const TABS = ['audio', 'video', 'images', 'effects', 'scripts', 'logs', 'uploads', 'crashes', 'backups'];

for (const tab of TABS) {
  test(`#tab-${tab} opens the ${tab} tab`, async ({ page }) => {
    await page.goto(`/filemanager.php?fpp-tests=${Date.now()}#tab-${tab}`);
    await expect(page.locator(`#tab-${tab}-tab`)).toHaveClass(/active/);
    await expect(page.locator(`#tab-${tab}`)).toBeVisible();
    await expect(page.locator('#tab-sequence')).toBeHidden();
  });
}

test('clicking a tab puts it in the address, so a reload or a copied link opens it', async ({ page }) => {
  // Feature: 972a4d2d8.  The tab links changed the tab but not the URL, so
  // the address could not be copied and a reload went back to the first tab.
  await page.goto(`/filemanager.php?fpp-tests=${Date.now()}`);
  await expect(page.locator('#tab-sequence-tab')).toHaveClass(/active/);
  await page.locator('#tab-video-tab').click();
  await expect(page.locator('#tab-video')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#tab-video');
  await page.reload();
  await expect(page.locator('#tab-video-tab')).toHaveClass(/active/);
  await expect(page.locator('#tab-video')).toBeVisible();
});
