import { test, expect } from './fixtures';
import { container } from './container';
import { settingInFile, snapshotSettings } from './settings-file';

// Regression: f4d88facd ("SetSetting is using PUT so should not encodeURI the
// value").  The change handler PrintSettingSelect draws ran the select's value
// through encodeURIComponent() before SetSetting() PUT it as the request body,
// which is stored as it arrives: picking "%m/%d/%Y" saved "%25m%2F%25d%2F%25Y".

test.skip(!container, 'reads the settings file inside the run-web.sh container');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

test('a select setting whose value has / and % is saved as it reads', async ({ page }) => {
  await page.goto('/settings.php?tab=Localization');
  const select = page.locator('select#DateFormat');
  await expect(select).toBeVisible({ timeout: 15_000 });
  for (const value of ['%m/%d/%Y', '%d/%m/%Y']) {
    await select.selectOption(value);
    await expect.poll(() => settingInFile('DateFormat'), { message: value }).toBe(value);
  }
});
