import { test, expect } from './fixtures';
import { container } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// The Package Manager (packages.php): the menu entry that leads to it, and
// what its package lookup says about a name apt does not know.

test.skip(!container, 'sets the UI level in the settings file inside the run-web.sh container');

const UNKNOWN = 'fpp-tests-no-such-package';

test('looking up a package apt does not know is reported as not found', async ({ page, request }) => {
  // Regression: 85dd7bd90 ("refine User installed OS packages part 1").
  // apt-cache prints "E: No packages found" for an unknown name, which is
  // output, so the lookup parsed it as a package with no description or
  // dependencies, not installed -- and the page offered to install it.
  const r = await request.get(`/api/system/packages/info/${UNKNOWN}`);
  expect(r.ok()).toBe(true);
  const info = await r.json();
  expect(info.error, JSON.stringify(info)).toContain(UNKNOWN);
  expect(info.Installed).toBeUndefined();

  // The receiving end: the page shows the error and no Install button.
  await page.goto('/packages.php');
  await page.waitForFunction(() => typeof (window as any).GetPackageInfo === 'function');
  await page.evaluate((name) => (window as any).GetPackageInfo(name), UNKNOWN);
  await expect(page.locator('#packageInfo')).toContainText('Error:');
  await expect(page.locator('#packageInfo')).toContainText(UNKNOWN);
  await expect(page.locator('#packageInfo')).not.toContainText('Install Package');

  // The control: a package apt does know is described.
  const bash = await (await request.get('/api/system/packages/info/bash')).json();
  expect(bash.error).toBeUndefined();
  expect(bash.Installed).toBe('Yes');
});

test('the Packages menu entry is there from the Advanced UI level', async ({ page }) => {
  // Regression: 8cf070a5c ("Fix User Packages so they are available in
  // Advanced UI mode").  The Content Setup menu offered Packages only from
  // the Experimental level.
  await keepingSettings(async () => {
    const entry = () => page.locator('a.dropdown-item[href="packages.php"]');
    setSettingInFile('uiLevel', '1');
    await page.goto(`/index.php?fpp-tests=${Date.now()}`);
    await expect(entry()).toHaveCount(1);
    // The receiving end: the entry leads to a working Package Manager.
    await page.goto('/packages.php');
    await expect(page.locator('#userPackagesTable')).toBeAttached();

    setSettingInFile('uiLevel', '0');
    await page.goto(`/index.php?fpp-tests=${Date.now()}`);
    await expect(page.locator('#programControl')).toBeVisible();
    await expect(entry()).toHaveCount(0);
  });
});
