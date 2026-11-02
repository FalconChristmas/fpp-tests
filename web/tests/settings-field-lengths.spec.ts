import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Text settings whose input was too short for the values people paste into
// them: a typed or pasted value longer than the input's maxlength is cut off
// by the browser without a word, and the cut value is what gets saved.

test.skip(!container, 'sets the UI level inside the run-web.sh container');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); setSettingInFile('uiLevel', '3'); });
test.afterEach(() => restoreSettings());

test('a latitude and longitude of 15 characters fit their fields', async ({ page }) => {
  // Regression: e4e79c88b ("Allow lat/long to be longer to hopefully fix
  // copy/paste issue").  Both had a maxlength of 11, so a coordinate copied
  // from a map (-33.868819765) lost its last digits.
  await page.goto('/settings.php?tab=Localization');
  for (const [id, value] of [['#Latitude', '-33.86881976543'], ['#Longitude', '151.20929550012']]) {
    const input = page.locator(id);
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.evaluate((el: HTMLInputElement) => { el.value = ''; });
    await input.pressSequentially(value);
    await expect(input, id).toHaveValue(value);
  }
});

test('an SMTP password of 100 characters fits its field', async ({ page }) => {
  // Regression: afef352a3 ("Increase the max size of an SMTP email
  // password").  The field's maxlength was 64; an app password or token
  // longer than that was cut off.
  await page.goto('/settings.php?tab=Email');
  const input = page.locator('#emailpass');
  await expect(input).toBeVisible({ timeout: 15_000 });
  const value = 'p'.repeat(90) + '0123456789';
  await input.evaluate((el: HTMLInputElement) => { el.value = ''; });
  await input.pressSequentially(value, { delay: 0 });
  await expect(input).toHaveValue(value);
});
