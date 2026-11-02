import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// The setup wizard is not where the "expand storage" warning belongs: the
// Health Check page and the Storage settings carry it.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

test('the setup wizard does not warn that the SD card has unused space', async ({ page }) => {
  // Regression: af4f98afb.  An SD card whose last partition ended between
  // about 1 and 7.4 million blocks (LastBlock) put an "SD card has unused
  // space" alert at the top of the wizard, where it is only noise for
  // someone setting up a new player.
  setSettingInFile('initialSetup-02', '0');
  setSettingInFile('LastBlock', '3000000');
  await page.goto('/initialSetup.php');
  await expect(page.locator('.setupStep[data-step="1"]')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('body')).not.toContainText('unused space');
});
