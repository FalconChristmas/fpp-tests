import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { writeFile } from './privacy-helpers';

// pluginconfig.php, which plugin pages include for their settings, printed
// the path of the plugin's config file into the page: a debugging echo left
// in by 24adba429 ("Minor XSS Issue"), so every plugin page that includes it
// starts with <media>/config/plugin.<name> as text.

test.skip(!container, 'writes a plugin into the run-web.sh container');

const PLUGIN = 'fpp-tests-configpath';
const PLUGIN_DIR = `/home/fpp/media/plugins/${PLUGIN}`;
const PLUGIN_CONFIG = `/home/fpp/media/config/plugin.${PLUGIN}`;

test('a plugin page that includes pluginconfig.php does not print its config file path', async ({ page }) => {
  inPlayer('mkdir', '-p', PLUGIN_DIR);
  writeFile(`${PLUGIN_DIR}/pluginInfo.json`, JSON.stringify({
    name: PLUGIN, repoName: PLUGIN, versions: [{ minFPPVersion: '0', maxFPPVersion: '0', branch: 'master' }],
  }));
  writeFile(`${PLUGIN_DIR}/content.php`, `<?php include_once '/opt/fpp/www/pluginconfig.php'; ?>\n` +
    '<div id="fpp-tests-plugin-page">page</div>\n');
  writeFile(PLUGIN_CONFIG, 'value = "x"\n');
  try {
    await page.goto(`/plugin.php?plugin=${PLUGIN}&page=content.php`);
    await expect(page.locator('#fpp-tests-plugin-page'), 'the plugin page is drawn').toHaveCount(1);
    // The control: the settings were read.
    expect(await page.evaluate(() => (window as any).pluginSettings?.value)).toBe('x');
    // The media directory is wherever the player keeps it (not always
    // /home/fpp/media), so the path is matched from config/ on.
    await expect(page.locator('body'), 'the config path is printed').not.toContainText(`config/plugin.${PLUGIN}`);
  } finally {
    inPlayer('rm', '-rf', PLUGIN_DIR, PLUGIN_CONFIG);
  }
});
