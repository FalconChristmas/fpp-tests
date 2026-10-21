import { test, expect } from './fixtures';
import { container } from './container';
import { settingInFile } from './settings-file';

// Choosing "No Password (Default)" in the setup wizard is recorded, so a later
// run of setup shows it as answered. Regression: 557bd3938 ("record a "No
// Password" choice so a re-run of setup does not ask again"). finishSetup()
// dropped passwordEnable unless it was '1', the settings file kept no key, and
// every re-run (after an fppOS update, say) offered "-- Choose an Option --"
// again -- the re-asking 8dab0b060 set out to stop.
//
// The setup project has just finished the wizard choosing No Password.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test("the wizard's No Password choice is not asked again", async ({ page }) => {
  expect(settingInFile('initialSetup-02')).toBe('1');
  expect(settingInFile('passwordEnable'), 'the choice was not recorded').toBe('0');
  await page.goto('/initialSetup.php');
  await expect(page.locator('#passwordEnable')).toBeAttached();
  await expect(page.locator('#passwordEnable option[value=""]'), 'the wizard asks for the password choice again').toHaveCount(0);
  await expect(page.locator('#passwordEnable')).toHaveValue('0');
});
