import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, settingInFile, snapshotSettings } from './settings-file';

// Growing the filesystem (or adding a partition, or copying to new storage)
// from the Storage tab only takes effect after a reboot, so when its progress
// dialog finishes the page sets the reboot flag, and the "reboot needed"
// banner follows.  growsd.php is answered by the test: the container has no
// SD card to grow.
//
// Regression: a63c7f074 ("Make sure reboot flag is set").  StorageDialogDone()
// only re-enabled the dialog's Close button.

test.skip(!container, 'sets the settings file inside the run-web.sh container');

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('uiLevel', '3');
  setSettingInFile('rebootFlag', '0');
});
test.afterEach(() => restoreSettings());

test('a finished Grow Filesystem sets the reboot flag', async ({ page }) => {
  let grown = 0;
  await page.route('**/growsd.php*', (route) => { grown++; return route.fulfill({ contentType: 'text/plain', body: 'fpp-tests: grown\n' }); });
  await page.goto('/settings.php?tab=Storage');
  await page.waitForFunction(() => typeof (window as any).growSDCardFS === 'function');
  await page.evaluate(() => (window as any).growSDCardFS());
  await page.locator('.modal.show').getByRole('button', { name: 'Yes' }).click();
  // The control: the grow ran, through the page's own progress dialog.
  await expect(page.locator('#storageSettingsProgressText')).toHaveValue(/fpp-tests: grown/);
  await expect(page.locator('#storageSettingsProgressCloseButton')).toBeEnabled();
  expect(grown).toBe(1);
  await expect.poll(() => settingInFile('rebootFlag')).toBe('1');
});
