import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The Packages page's search and lookup: suggestions from the system's
// package names, a looked-up package's description and dependencies, and
// its Install (or, once installed, Reinstall) button, which streams
// packagesHelper.php for exactly that package.  The package list, the
// lookup and the helper are answered here, so apt is never run.

const NAMES = ['fpp-tests-tool', 'fpp-tests-tool-doc', 'fpp-tests-other', ...Array.from({ length: 80 }, (_, i) => `libfpptests${i}`)];

async function open(page: Page, info: Record<string, any>) {
  const helper: URLSearchParams[] = [];
  await page.route('**/api/system/packages', (r) => r.fulfill({ json: NAMES }));
  await page.route('**/api/system/packages/info/**', (r) => {
    const name = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop()!);
    return r.fulfill({ json: info[name] ?? { error: `Package '${name}' not found` } });
  });
  await page.route('**/packagesHelper.php**', (r) => {
    helper.push(new URL(r.request().url()).searchParams);
    return r.fulfill({ body: 'fpp-tests apt output\n' });
  });
  await page.goto('/packages.php');
  await expect(page.locator('#packageInput')).toBeVisible({ timeout: 15_000 });
  return helper;
}
const lookup = (page: Page) => page.locator('#packageInputContainer').locator('[onClick^="GetPackageInfo"], [onclick^="GetPackageInfo"]');

test('suggestions start at two letters and stop at fifty, and a pick fills the box', async ({ page }) => {
  await open(page, {});
  const box = page.locator('#packageInput');
  const menu = page.locator('ul.ui-autocomplete');
  await box.pressSequentially('f');
  await page.waitForTimeout(600);
  await expect(menu.locator('li:visible')).toHaveCount(0);
  await box.pressSequentially('pp-tests-t');
  await expect(menu.locator('li')).toHaveText(['fpp-tests-tool', 'fpp-tests-tool-doc']);
  await menu.locator('li', { hasText: /^fpp-tests-tool-doc$/ }).click();
  await expect(box).toHaveValue('fpp-tests-tool-doc');

  await box.fill('');
  await box.pressSequentially('lib');
  await expect(menu.locator('li')).toHaveCount(50);
});

test('a package that is not installed is described and installed by name', async ({ page }) => {
  const helper = await open(page, { 'fpp-tests-tool': { Installed: 'No', Description: 'A tool for fpp-tests',
    Depends: 'libfpptests1 (>= 1.2), libfpptests2' } });
  await page.fill('#packageInput', '  fpp-tests-tool  ');
  await lookup(page).click();
  const info = page.locator('#packageInfo');
  await expect(info).toContainText('Selected Package: fpp-tests-tool');
  await expect(info).not.toContainText('(Already Installed)');
  await expect(info).toContainText('Description: A tool for fpp-tests');
  // Version constraints are left out of the list.
  await expect(info).toContainText('Will also install these packages (if not already installed): libfpptests1 , libfpptests2');
  await info.getByText('Install Package').click();
  await expect.poll(() => helper.length).toBe(1);
  expect(Object.fromEntries(helper[0])).toEqual({ action: 'install', package: 'fpp-tests-tool' });
  await expect(page.locator('#packageProgressPopup')).toContainText('Installing Package: fpp-tests-tool');
  await expect(page.locator('#packageProgressPopupText')).toHaveValue(/fpp-tests apt output/);
});

test('an installed package offers Reinstall, and an unknown one says so with no button', async ({ page }) => {
  const helper = await open(page, { 'fpp-tests-other': { Installed: 'Yes', Description: 'Already here', Depends: '' } });
  await page.fill('#packageInput', 'fpp-tests-other');
  await lookup(page).click();
  const info = page.locator('#packageInfo');
  await expect(info).toContainText('Selected Package: fpp-tests-other (Already Installed)');
  await expect(info).toContainText('Dependencies: No dependencies.');
  await expect(info.getByText('Install Package', { exact: true })).toHaveCount(0);
  await info.getByText('Reinstall Package').click();
  await expect.poll(() => helper.length).toBe(1);
  expect(Object.fromEntries(helper[0])).toEqual({ action: 'reinstall', package: 'fpp-tests-other' });

  await page.fill('#packageInput', 'fpp-tests-missing');
  await lookup(page).click();
  await expect(info).toContainText("Error: Package 'fpp-tests-missing' not found");
  await expect(info.locator('.buttons')).toHaveCount(0);

  // Nothing typed: refused before any lookup.
  const alerts: string[] = [];
  page.on('dialog', (d) => { alerts.push(d.message()); return d.accept(); });
  await page.fill('#packageInput', '   ');
  await lookup(page).click();
  await expect.poll(() => alerts).toEqual(['Please enter a valid package name.']);
  expect(helper).toHaveLength(1);
});
