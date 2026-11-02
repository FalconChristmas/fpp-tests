import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile, settingInFile } from './settings-file';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// Which boards and UI levels a setting in www/settings.json is drawn for, and
// how the Settings page reloads itself after a setting that needs it.

test.skip(!container, 'runs the tree\'s PHP and pages inside the run-web.sh container');

const DRIVER = '/tmp/fpp-tests-platform-levels.php';
const DRIVER_SRC = `<?php
// argv: setting, platform, variant, uiLevel.  What ShouldPrintSetting() -- the
// test every setting's row goes through -- says for that board and level.
chdir('/opt/fpp/www');
$skipJSsettings = 1;
require_once 'config.php';
require_once 'common.php';
LoadSettingInfos();
$settings['Platform'] = $argv[2];
$settings['Variant'] = $argv[3];
$settings['uiLevel'] = intval($argv[4]);
echo json_encode(ShouldPrintSetting($settingInfos[$argv[1]]));
`;

function shown(setting: string, platform: string, variant: string, uiLevel: number): boolean {
  return JSON.parse(inPlayer('php', DRIVER, setting, platform, variant, String(uiLevel)).trim().split('\n').pop()!);
}

test.beforeAll(() => putFile(DRIVER, DRIVER_SRC));
test.afterAll(() => inPlayer('rm', '-f', DRIVER));

test('Enable HDMI Display on a BeagleBone Black is an Advanced level setting', () => {
  // Regression: bcb9f9bbc.  The setting carried no level, so it was offered
  // to every user at Basic level, where turning it on disables most of the
  // GPIO pins a cape needs.
  const bbb = 'BeagleBone Black';
  expect(shown('EnableBBBHDMI', bbb, bbb, 0), 'offered at Basic level').toBe(false);
  expect(shown('EnableBBBHDMI', bbb, bbb, 1)).toBe(true);
  // The control: Basic level hides it for the level only, not the board.
  expect(shown('EnableBBBHDMI', 'Raspberry Pi', 'Pi 4', 1)).toBe(false);
});

test('Disable IP announcement is offered on boards that are not a Pi', async ({ page }) => {
  // Regression: e30782bc1.  The setting was limited to the Raspberry Pi
  // platform although the announcement is played on any board with audio.
  for (const [platform, variant] of [['BeagleBone Black', 'BeagleBone Black'], ['Debian', 'Debian'], ['Raspberry Pi', 'Pi 4']]) {
    expect(shown('disableIPAnnouncement', platform, variant, 0), platform).toBe(true);
  }
  // And the page: this player's own board (not a Pi) draws the row.
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '1');
    await page.goto('/settings.php#settings-av');
    await page.locator('#settingsManagerTabs').waitFor({ state: 'visible', timeout: 15_000 });
    const row = page.locator('#disableIPAnnouncementRow');
    await expect(row).toBeAttached({ timeout: 15_000 });
    // Saving it reaches the settings file the boot announcement reads.
    await page.evaluate(() => { (document.querySelector('#disableIPAnnouncement') as HTMLInputElement).click(); });
    await expect.poll(() => settingInFile('disableIPAnnouncement'), { timeout: 15_000 }).toBe('1');
  });
});

test('reloadSettingsPage reloads the page where it is', async ({ page }) => {
  // Regression: eb412b786.  It set location.href to settings.php plus the
  // active tab's hash; with only the hash differing (or none) that is no
  // reload at all, and when the page was opened with a query that was lost.
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '1');
    await page.goto('/settings.php?fpp-tests=1#settings-av');
    await page.locator('#settingsManagerTabs').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForFunction(() => typeof (window as any).reloadSettingsPage === 'function');
    await page.evaluate(() => { (window as any).fppTestsMarker = 1; });
    const loaded = page.waitForEvent('load');
    await page.evaluate(() => (window as any).reloadSettingsPage());
    await loaded;
    await page.locator('#settingsManagerTabs').waitFor({ state: 'visible', timeout: 15_000 });
    expect(await page.evaluate(() => (window as any).fppTestsMarker), 'the page was not reloaded').toBeUndefined();
    expect(new URL(page.url()).search, 'the query was dropped').toBe('?fpp-tests=1');
    expect(new URL(page.url()).hash).toBe('#settings-av');
  });
});
