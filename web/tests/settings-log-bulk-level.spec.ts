import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, settingInFile, snapshotSettings } from './settings-file';

// The Logging tab's Bulk Change Log Level buttons set every log level at
// once, except Channel Data: debug or excess logging of channel data writes a
// line per frame, which fills the log and slows the player.
//
// Regression: 68cc39764 ("Skip Channel Data when bulk setting Log Level").

test.skip(!container, 'sets the settings file inside the run-web.sh container');

// The bulk change is applied to fppd as it is saved, so putting the file
// back is not enough: fppd would log at Debug (with its "Log Level is set to
// Debug" warning up) for every test after this one.  Each level fppd had is
// set again through the API, which tells fppd, and then the file is put
// back as it was.
let restoreSettings: () => void;
let levels: [string, string][];
test.beforeEach(async ({ request }) => {
  const defs = (await (await request.get('/settings.json')).json()).settings;
  levels = Object.keys(defs).filter((k) => k.startsWith('LogLevel_'))
    .map((k) => [k, settingInFile(k) ?? defs[k].default ?? 'info']);
  expect(levels.length, 'the log levels settings.json defines').toBeGreaterThan(1);
  restoreSettings = snapshotSettings();
  setSettingInFile('uiLevel', '3');
  setSettingInFile('LogLevel_General', 'info');
  setSettingInFile('LogLevel_ChannelData', 'warn');
});
test.afterEach(async ({ request }) => {
  for (const [name, value] of levels) {
    expect((await request.put(`/api/settings/${name}`, { data: value })).ok(), name).toBe(true);
  }
  restoreSettings();
});

test('Bulk Change sets every log level but Channel Data', async ({ page }) => {
  await page.goto('/settings.php?tab=Logging');
  await expect(page.locator('#LogLevel_General')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#LogLevel_ChannelData')).toHaveValue('warn');
  await page.locator('#settings-logs').getByRole('button', { name: 'Debug' }).click();
  // The control: the bulk change did change the others, and saved them.
  await expect(page.locator('#LogLevel_General')).toHaveValue('debug');
  await expect.poll(() => settingInFile('LogLevel_General')).toBe('debug');
  await expect(page.locator('#LogLevel_ChannelData')).toHaveValue('warn');
  expect(settingInFile('LogLevel_ChannelData')).toBe('warn');
});
