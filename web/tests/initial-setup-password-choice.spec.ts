import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Setup is re-run (after an fppOS update, or by hand) over a player whose
// password choices are already recorded. Regression: 8dab0b060 ("Stop
// re-asking for a password choice that was already made"). Both password
// dropdowns spell their first option "0", and the wizard offered "-- Choose an
// Option --" whenever !settings[key], which "0" is: someone who had chosen no
// password was made to choose again. And with a password already set, the
// never-stored verify box came up empty and the untouched step reported a
// mismatch, with no way on but to retype the password.
//
// The settings are written into the file directly, as a save from the Settings
// page leaves them: passwordEnable=1 there turns nothing on (only applying it
// rewrites Apache's password config), and this test never presses Finish.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

// The security step's own check, as leaving the step runs it; any alert it
// raises is the reason it refused.
async function securityStep(page: Page): Promise<{ ok: boolean; alerts: string[] }> {
  const alerts: string[] = [];
  const onDialog = (d: import('@playwright/test').Dialog) => { alerts.push(d.message()); d.dismiss(); };
  page.on('dialog', onDialog);
  const ok = await page.evaluate(() => (window as any).validateSetupStep(4));
  page.off('dialog', onDialog);
  return { ok, alerts };
}

async function openWizard(page: Page) {
  await page.goto('/initialSetup.php');
  await page.waitForFunction(() => typeof (window as any).validateSetupStep === 'function');
  await expect(page.locator('#passwordEnable')).toBeAttached();
}

test('a recorded "No Password" is shown as chosen, not asked again', async ({ page }) => {
  setSettingInFile('passwordEnable', '0');
  setSettingInFile('osPasswordEnable', '0');
  await openWizard(page);
  for (const key of ['passwordEnable', 'osPasswordEnable']) {
    const select = page.locator(`#${key}`);
    if (await select.count() === 0) continue; // the OS password is not offered on every platform
    await expect(select, key).toHaveValue('0');
    await expect(select.locator('option[value=""]'), `${key} asked again`).toHaveCount(0);
  }
  const step = await securityStep(page);
  expect(step.alerts).toEqual([]);
  expect(step.ok).toBe(true);
});

test('an untouched, already set password does not report a mismatch', async ({ page }) => {
  setSettingInFile('passwordEnable', '1');
  setSettingInFile('password', 'fpp-tests-pw');
  setSettingInFile('osPasswordEnable', '0');
  await openWizard(page);
  await expect(page.locator('#passwordEnable')).toHaveValue('1');
  await expect(page.locator('#passwordVerify')).toHaveValue('');
  const untouched = await securityStep(page);
  expect(untouched.alerts, 'the untouched step reported a mismatch').toEqual([]);
  expect(untouched.ok).toBe(true);

  // The control: a typed confirmation that does not match is still caught.
  // (The security step is not on screen; set the field as typing would.)
  await page.evaluate(() => { (window as any).$('#passwordVerify').val('fpp-tests-other'); });
  const typed = await securityStep(page);
  expect(typed.ok).toBe(false);
  expect(typed.alerts.join('\n')).toContain('do not match');
});
