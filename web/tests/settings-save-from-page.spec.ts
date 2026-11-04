import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, settingInFile, snapshotSettings } from './settings-file';

// fpp.js's two savers as a page calls them.  A value used to travel in a URL
// and was cut at its first & or # until 748cc4a68 encoded it; it travels in
// the request body now, and has to arrive whole either way.

test.skip(!container, 'reads what was saved inside the run-web.sh container');

const PLUGIN = 'fpp-tests-save-page';

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => {
  restoreSettings();
  inPlayer('rm', '-f', `${MEDIA}/config/plugin.${PLUGIN}`);
});

async function openPage(page: any) {
  await page.goto('/index.php');
  await page.waitForFunction(() => typeof (window as any).SetPluginSetting === 'function');
}

test('SetPluginSetting saves a setting of the plugin it names', async ({ page, request }) => {
  // Feature: df1dc0f5e, the JS half of d70aea014's API.
  await openPage(page);
  await page.evaluate((plugin) => (window as any).SetPluginSetting(plugin, 'Colour', 'teal', 0, 0), PLUGIN);
  await expect.poll(async () => (await request.get(`/api/plugin/${PLUGIN}/settings/Colour`)).text(),
    { timeout: 10_000 }).toContain('teal');
});
