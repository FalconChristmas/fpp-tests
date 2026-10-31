import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// The status page (index.php) of a player in remote mode.  The page is drawn
// from the settings file's fppMode, and then follows the mode in each status
// answer, which the test edits (fppd here runs as a player).  The status
// WebSocket is held open without sending anything, so the page keeps polling.

test.skip(!container, "edits the player's settings file");

async function openWithMode(page: Page, mode: 2 | 8) {
  await page.routeWebSocket('**/fppdws', () => {});
  await page.route(/\/api\/(system|fppd)\/status/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.mode = mode;
    json.mode_name = mode == 8 ? 'remote' : 'player';
    return route.fulfill({ response, json });
  });
  await page.goto('/index.php');
}

const title = (page: Page) => page.locator('h1.title.statusTitle');

test('in remote mode the status page leaves out the scheduler', async ({ page }) => {
  // Regression: ae937dea6.  A remote runs no schedule of its own, but its
  // status page showed the Scheduler box, and its menu the Scheduler page.
  await keepingSettings(async () => {
    setSettingInFile('fppMode', 'remote');
    setSettingInFile('uiLevel', '0');
    await openWithMode(page, 8);
    await expect(title(page)).toContainText('Status - Remote Mode', { timeout: 15_000 });
    await expect(page.locator('#remoteModeInfo')).toBeVisible();
    await expect(page.locator('#schedulerInfo')).toBeHidden();
    await expect(page.locator('a.dropdown-item[href="scheduler.php"]')).toHaveCount(0);
  });
  // The control: a player shows both.
  await page.unrouteAll();
  await openWithMode(page, 2);
  await expect(title(page)).toContainText('Status - Player Mode', { timeout: 15_000 });
  await expect(page.locator('#schedulerInfo')).toBeVisible();
  await expect(page.locator('a.dropdown-item[href="scheduler.php"]')).toHaveCount(1);
});

test("the status title follows a change of mode while the page is open", async ({ page }) => {
  // Regression: ba1aec23d.  The title ("Remote Status" or "Status") was
  // written once by the PHP: a player switched to remote mode, with the page
  // open, swapped to the remote view under the player's title.
  await openWithMode(page, 2);
  await expect(title(page)).toContainText('Status - Player Mode', { timeout: 15_000 });
  await page.unroute(/\/api\/(system|fppd)\/status/);
  await page.route(/\/api\/(system|fppd)\/status/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.mode = 8;
    json.mode_name = 'remote';
    return route.fulfill({ response, json });
  });
  await expect(page.locator('#remoteModeInfo')).toBeVisible({ timeout: 15_000 });
  await expect(title(page)).toContainText('Status - Remote Mode');
});

test('Disable Audio Volume Slider takes the slider off the remote view too', async ({ page }) => {
  // Regression: 306e93009 (#1726).  The setting hid the player view's
  // volume controls only; a remote still showed its slider and buttons.
  await keepingSettings(async () => {
    setSettingInFile('fppMode', 'remote');
    setSettingInFile('disableAudioVolumeSlider', '1');
    await openWithMode(page, 8);
    await expect(page.locator('#remoteModeInfo')).toBeVisible({ timeout: 15_000 });
    // The volume itself is still shown.
    await expect(page.locator('#remoteVolume')).toHaveText(/^\d+$/, { timeout: 15_000 });
    await expect(page.locator('#remoteVolumeSlider')).toHaveCount(0);
    await expect(page.locator('#remoteModeInfo .volumeButton')).toHaveCount(0);
    await expect(page.locator('#slider')).toHaveCount(0);
  });
});
