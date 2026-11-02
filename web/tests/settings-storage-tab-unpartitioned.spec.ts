import { test, expect } from './fixtures';
import { container } from './container';
import { dropSettings, keepingSettings, setSettingInFile } from './privacy-helpers';

// The Storage tab is an Advanced-level tab, but the Basic level keeps it when
// the card has room that is not partitioned yet (UnpartitionedSpace, set by
// the player's start-up), since expanding the card is done from there.

test.skip(!container, 'writes the settings file inside the run-web.sh container');

async function storageTab(page) {
  await page.goto(`/settings.php?fpp-tests=${Date.now()}`);
  await page.locator('#settingsManagerTabs').waitFor({ state: 'visible', timeout: 15_000 });
  return page.locator('#settings-storage-tab');
}

test('the Storage tab is kept at the Basic level when the card has unpartitioned space', async ({ page }) => {
  // Regression: 73214f46b.  The tab was left out below the Advanced level, so
  // a card that needed expanding had no way to do it from the Basic level.
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '0');
    dropSettings('UnpartitionedSpace');
    // The control: a full card hides it at this level, and Advanced shows it.
    await expect(await storageTab(page)).toHaveCount(0);
    setSettingInFile('uiLevel', '1');
    await expect(await storageTab(page)).toHaveCount(1);

    setSettingInFile('uiLevel', '0');
    setSettingInFile('UnpartitionedSpace', '4096');
    await expect(await storageTab(page)).toHaveCount(1);

    setSettingInFile('UnpartitionedSpace', '0');
    await expect(await storageTab(page)).toHaveCount(0);
  });
});
