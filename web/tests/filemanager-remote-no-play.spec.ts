import { test, expect } from './fixtures';
import { container } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// The File Manager's Sequences tab can play a sequence (Play, Play Here) only
// on a player: a Remote plays what its master sends.  The rest of the tab's
// buttons stay.

test.skip(!container, 'writes the settings file inside the run-web.sh container');

async function openSequences(page) {
  await page.goto(`/filemanager.php?fpp-tests=${Date.now()}`);
  await expect(page.locator('#tab-sequence')).toBeVisible();
  await expect(page.locator('#tab-sequence input[value="Clear"]')).toHaveCount(1);
}

test('the Sequences tab has Play buttons on a Player and not on a Remote', async ({ page }) => {
  // Regression: 8e03934b4.  A Remote got the buttons too, and they started
  // a sequence the master was meant to be driving.
  await keepingSettings(async () => {
    setSettingInFile('fppMode', 'player');
    await openSequences(page);
    await expect(page.locator('#tab-sequence input[value="Play"]')).toHaveCount(1);
    await expect(page.locator('#tab-sequence input[value="Play Here"]')).toHaveCount(1);

    setSettingInFile('fppMode', 'remote');
    await openSequences(page);
    await expect(page.locator('#tab-sequence input[value="Clear"]')).toHaveCount(1);
    await expect(page.locator('#tab-sequence input[value="Download"]')).toHaveCount(1);
    await expect(page.locator('#tab-sequence input[value="Play"]')).toHaveCount(0);
    await expect(page.locator('#tab-sequence input[value="Play Here"]')).toHaveCount(0);
  });
});
