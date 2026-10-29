import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, settingInFile, snapshotSettings } from './settings-file';

// Feature: 1ec5d2983 ("Improvements to initial setup page/process"), with the
// banner's test fixed in 320b23d90.  While the host name is still the
// default "FPP", the status page says that several players need different
// names and links to the Host Settings page, until the warning is dismissed;
// the dismissal is saved as hostnameConfirmed.

test.skip(!container, 'sets the host name in the settings file inside the run-web.sh container');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

const banner = (page) => page.locator('#bannerHostnameRow');

test('the status page warns about the default host name until the warning is dismissed', async ({ page }) => {
  setSettingInFile('HostName', 'FPP');
  setSettingInFile('hostnameConfirmed', undefined);
  await page.goto('/index.php');
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toContainText('set to FPP');
  await expect(banner(page).locator('a[href="networkconfig.php#tab-host-dns"]')).toHaveCount(1);

  const saved = page.waitForResponse((r) => /\/api\/settings\/hostnameConfirmed$/.test(r.url()) && r.request().method() === 'PUT');
  await banner(page).getByRole('button', { name: 'Dismiss Warning' }).click();
  expect((await saved).ok()).toBe(true);
  await expect(banner(page)).toBeHidden();
  expect(settingInFile('hostnameConfirmed')).toBe('True');
  // The receiving end: the next load reads the dismissal back.
  await page.goto(`/index.php?fpp-tests=${Date.now()}`);
  await expect(page.locator('#programControl')).toBeVisible();
  await expect(banner(page)).toBeHidden();
});

test('a player with its own host name gets no warning', async ({ page }) => {
  // Regression: 320b23d90.  The test was !(hostnameConfirmed && HostName ==
  // "FPP"), so every player that had not dismissed it got the banner.
  setSettingInFile('HostName', 'fpptestsplayer');
  setSettingInFile('hostnameConfirmed', undefined);
  await page.goto('/index.php');
  await expect(page.locator('#programControl')).toBeVisible();
  await expect(banner(page)).toBeHidden();
});
