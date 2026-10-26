import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { keepingSettings, setSettingInFile, writeFile } from './privacy-helpers';

// Regression: aea8ba144 ("fix(settings): stop unescaped setting values from
// breaking the page's JavaScript").  The settings script every page carries
// (config.php), backup.php's copy of it, and the plugin pages'
// pluginSettings (plugin.php, and pluginconfig.php that plugin pages include)
// printed each value inside "..." as it was: a backslash at the end escaped
// the closing quote and a "</script>" ended the block, so the page had no
// settings, and whatever followed ran as markup.  The value here has both,
// and markup after the "</script>".

test.skip(!container, 'writes the settings file inside the run-web.sh container');

const VALUE = 'C:\\fpp-tests\\</script><b id=fpp-tests-injected>x</b>\\';
const KEY = 'fppTestsJsValue';
const PLUGIN = 'fpp-tests-jsvalues';
const PLUGIN_DIR = `/home/fpp/media/plugins/${PLUGIN}`;
const PLUGIN_CONFIG = `/home/fpp/media/config/plugin.${PLUGIN}`;

async function load(page: Page, path: string) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(path);
  await page.waitForLoadState('load');
  return errors;
}

for (const path of ['/index.php', '/settings.php', '/backup.php']) {
  test(`a setting with a backslash and </script> in it leaves ${path}'s settings script whole`, async ({ page, request }) => {
    await keepingSettings(async () => {
      setSettingInFile(KEY, VALUE);
      // What FPP itself reads back from the file is what the page should have.
      const stored = (await (await request.get(`/api/settings/${KEY}`)).json()).value;
      expect(stored, 'the control: the value is stored with its backslashes and </script>').toContain('</script>');
      const errors = await load(page, path);
      expect(errors).toEqual([]);
      expect(await page.evaluate((k) => (window as any).settings?.[k], KEY)).toBe(stored);
      await expect(page.locator('#fpp-tests-injected')).toHaveCount(0);
    });
  });
}

test("a plugin setting with a backslash and </script> in it leaves the plugin page's settings whole", async ({ page }) => {
  inPlayer('mkdir', '-p', PLUGIN_DIR);
  writeFile(`${PLUGIN_DIR}/pluginInfo.json`, JSON.stringify({
    name: PLUGIN, repoName: PLUGIN, versions: [{ minFPPVersion: '0', maxFPPVersion: '0', branch: 'master' }],
  }));
  // A plugin page that takes its settings from pluginconfig.php, as plugins do.
  writeFile(`${PLUGIN_DIR}/content.php`, `<?php include_once '/opt/fpp/www/pluginconfig.php'; ?>\n` +
    '<script>window.fppTestsFromConfig = pluginSettings;</script>\n<div id="fpp-tests-plugin-page">page</div>\n');
  writeFile(PLUGIN_CONFIG, `value = "${VALUE}"\n`);
  try {
    const errors = await load(page, `/plugin.php?plugin=${PLUGIN}&page=content.php`);
    await expect(page.locator('#fpp-tests-plugin-page')).toHaveCount(1);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => (window as any).pluginSettings?.value)).toBe(VALUE);
    expect(await page.evaluate(() => (window as any).fppTestsFromConfig?.value)).toBe(VALUE);
    await expect(page.locator('#fpp-tests-injected')).toHaveCount(0);
  } finally {
    inPlayer('rm', '-rf', PLUGIN_DIR, PLUGIN_CONFIG);
  }
});
