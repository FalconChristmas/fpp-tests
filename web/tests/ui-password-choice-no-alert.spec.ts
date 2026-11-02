import { test, expect } from './fixtures';
import { container } from './container';
import { keepingFile, keepingSettings, setSettingInFile } from './privacy-helpers';
import { inPlayer } from './container';

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

test('choosing the default OS password raises no alert, and Enter a Password shows its fields', async ({ page }) => {
  // Regression: e8e6a7625.  ConfirmOSPasswordEnable() ended with an
  // alert('OS Password set to default password of "falcon"') when the choice
  // was the default, a popup for something the page shows by its fields.
  // The OS password is offered only on a real player (it has /etc/fpp/platform
  // and is not a container), so the container's marker is put aside.
  await keepingFile('/etc/fpp/container', () => keepingFile('/etc/fpp/platform', () => keepingSettings(async () => {
    inPlayer('rm', '-f', '/etc/fpp/container');
    inPlayer('sh', '-c', "mkdir -p /etc/fpp && printf '%s' 'BeagleBone Black' > /etc/fpp/platform");
    setSettingInFile('osPasswordEnable', '1');
    setSettingInFile('osPassword', 'fpp-tests-os');
    setSettingInFile('osPasswordVerify', 'fpp-tests-os');
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    // Nothing is stored: choosing runs chpasswd for real.
    await page.route((u) => /\/api\/settings\/(osPassword|osPasswordVerify|osPasswordEnable)$/.test(u.pathname),
      (route) => route.request().method() === 'GET' ? route.continue() : route.fulfill({ json: { status: 'OK' } }));
    await page.goto('/settings.php?tab=System');
    await page.click('#settings-system-tab');
    await expect(page.locator('#osPasswordEnable')).toHaveValue('1', { timeout: 15_000 });
    await expect(page.locator('#osPassword')).toBeVisible();

    await page.locator('#osPasswordEnable').selectOption('0');
    await expect(page.locator('#osPassword')).toBeHidden();
    await expect(page.locator('#osPassword')).toHaveValue('falcon');
    await page.waitForTimeout(1_000);
    expect(dialogs, 'an alert was raised').toEqual([]);
  })));
});
