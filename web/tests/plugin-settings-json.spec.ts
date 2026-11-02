import { test, expect } from './fixtures';
import { container } from './container';
import { PLUGINS, CONFIG, sh, writeFile } from './plugin-backfill';

// A plugin's settings.json describes its settings as www/settings.json does
// FPP's: a default for each, and the type its field is drawn as.
//
// Regression: 216d7fbe2 ("Add datalist type for settings.json, allow plugins
// to get $pluginSettings defaults loaded from settings.json ...").  A plugin
// page got only what its config file held -- nothing for a setting never
// saved -- and a datalist setting (free text with suggestions) could not be
// drawn.  (The commit's lifecycle callbacks for script plugins are
// test_plugin_scripts.py::test_lifecycle_and_playlist_events.)

test.skip(!container, 'seeds a plugin inside the run-web.sh container');

const NAME = 'fpp-tests-sjson';

test.beforeEach(() => {
  sh(`rm -rf ${PLUGINS}/${NAME} ${CONFIG}/plugin.${NAME}`);
  writeFile(`${PLUGINS}/${NAME}/pluginInfo.json`, JSON.stringify({
    name: NAME, repoName: NAME, versions: [{ minFPPVersion: '0', maxFPPVersion: '0', branch: 'master' }],
  }));
  writeFile(`${PLUGINS}/${NAME}/settings.json`, JSON.stringify({
    settingGroups: {},
    settings: {
      fppTestsUnsaved: { name: 'fppTestsUnsaved', description: 'Unsaved', type: 'text', default: 'from-settings-json' },
      fppTestsSaved: { name: 'fppTestsSaved', description: 'Saved', type: 'text', default: 'from-settings-json' },
      fppTestsColour: {
        name: 'fppTestsColour', description: 'Colour', type: 'datalist', default: 'red',
        options: { red: 'Red', green: 'Green' },
      },
    },
  }));
  writeFile(`${PLUGINS}/${NAME}/page.php`, `<?php PrintPluginSetting('${NAME}', 'fppTestsColour'); ?>\n`);
  writeFile(`${CONFIG}/plugin.${NAME}`, 'fppTestsSaved = "from-config"\n');
});
test.afterEach(() => sh(`rm -rf ${PLUGINS}/${NAME} ${CONFIG}/plugin.${NAME}`));

test("a plugin page gets its settings.json defaults for settings it hasn't saved", async ({ request }) => {
  const text = await (await request.get(`/plugin.php?plugin=${NAME}&page=page.php`)).text();
  // The control: a saved value is the saved one, not the default.
  expect(text).toContain('pluginSettings["fppTestsSaved"] = "from-config";');
  expect(text).toContain('pluginSettings["fppTestsUnsaved"] = "from-settings-json";');
});

test('a datalist setting is drawn as a text box with its options as suggestions', async ({ page }) => {
  await page.goto(`/plugin.php?plugin=${NAME}&page=page.php`);
  const input = page.locator('#fppTestsColour');
  await expect(input).toBeVisible({ timeout: 15_000 });
  await expect(input).toHaveAttribute('list', 'fppTestsColour_list');
  const options = await page.locator('datalist#fppTestsColour_list option').evaluateAll(
    (os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(options).toEqual(['red', 'green']);
});
