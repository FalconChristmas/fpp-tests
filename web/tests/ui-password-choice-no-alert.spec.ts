import { test, expect } from './fixtures';
import { container } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// Choosing between "No Password" and "Enter a Password" on Settings > UI only
// shows or hides the password fields (and seeds them); it says nothing in an
// alert, and nothing is saved until Save UI Password.

test.skip(!container, 'sets the stored UI password inside the run-web.sh container');

test('choosing No Password, or Enter a Password with none saved, raises no alert', async ({ page }) => {
  // Regression: bd6375488.  ConfirmPasswordEnable() ended with an
  // alert('UI Password enabled using default password of "falcon"') whenever
  // the password field was empty -- and it still was when the choice was No
  // Password, so turning the password off announced that it was turned on.
  await keepingSettings(async () => {
    setSettingInFile('passwordEnable', '0');
    setSettingInFile('password', '');
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    await page.route((u) => /\/api\/settings\/(password|passwordVerify|passwordEnable)$/.test(u.pathname),
      (route) => route.request().method() === 'GET' ? route.continue() : route.fulfill({ json: { status: 'OK' } }));
    await page.goto('/settings.php?tab=UI');
    await page.click('#settings-ui-tab');
    await expect(page.locator('#passwordEnable')).toHaveValue('0', { timeout: 15_000 });

    // Enter a Password with nothing saved: the fields are seeded.
    await page.locator('#passwordEnable').selectOption('1');
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('#password')).toHaveValue('falcon');
    await expect(page.locator('#passwordVerify')).toHaveValue('falcon');

    // And back to No Password with the field empty.
    await page.fill('#password', '');
    await page.fill('#passwordVerify', '');
    await page.locator('#passwordEnable').selectOption('0');
    await expect(page.locator('#password')).toBeHidden();
    await page.waitForTimeout(1_000);
    expect(dialogs, 'an alert was raised').toEqual([]);
  });
});
