import { test, expect } from './fixtures';
import { container } from './container';
import { PLUGINS, sh } from './plugin-repo';

// A plugin page's settings drawn with common.php's PrintSetting* helpers:
// the multi-select one.  The plugin is a directory put in the player's
// plugins folder, as an install leaves it.

test.skip(!container, 'puts a plugin in the run-web.sh container');

const NAME = 'fpp-tests-multiselect';

function put(path: string, content: string) {
  const b64 = Buffer.from(content).toString('base64');
  sh(`mkdir -p "$(dirname '${PLUGINS}/${NAME}/${path}')" && echo '${b64}' | base64 -d > '${PLUGINS}/${NAME}/${path}'`);
}

test.beforeEach(() => {
  sh(`rm -rf '${PLUGINS}/${NAME}' '/home/fpp/media/config/plugin.${NAME}'`);
  put('pluginInfo.json', JSON.stringify({
    name: NAME, repoName: NAME, author: 'fpp-tests', description: 'fpp-tests plugin',
    versions: [{ minFPPVersion: '0', maxFPPVersion: '0', branch: 'master', sha: '' }],
  }));
  put('settings.php', `<div id="fpp-tests-ms"><?php PrintSettingMultiSelect('Colors', 'colors', 0, 0, '', ` +
    `array('Red' => 'red', 'Green' => 'green', 'Blue' => 'blue'), '${NAME}'); ?></div>\n`);
});
test.afterEach(() => sh(`rm -rf '${PLUGINS}/${NAME}' '/home/fpp/media/config/plugin.${NAME}'`));

test('a plugin multi-select setting saves every value picked and shows them picked again', async ({ page, request }) => {
  // Feature: eb4bfa895 ("Add a PrintSettingMultiSelect for plugins to
  // use").  A plugin had no way to draw a setting that takes several
  // values: PrintSettingMultiSelect draws a <select multiple> whose values
  // are saved as one comma-separated list.
  const url = `/plugin.php?plugin=${NAME}&page=settings.php`;
  await page.goto(url);
  const select = page.locator('#fpp-tests-ms select#colors');
  await expect(select).toHaveAttribute('multiple', '');
  await select.selectOption(['red', 'blue']);
  await expect.poll(async () => (await (await request.get(`/api/plugin/${NAME}/settings/colors`)).json()).colors,
    { timeout: 10_000 }).toBe('red,blue');
  await page.goto(url);
  await expect(select).toHaveValues(['red', 'blue']);
});
