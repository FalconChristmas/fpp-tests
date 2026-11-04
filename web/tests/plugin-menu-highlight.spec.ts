import { test, expect } from './fixtures';
import { container } from './container';
import { PLUGINS, sh } from './plugin-repo';

// A plugin's entries in the menu bar, and which menu is highlighted as the
// active one on the plugin page an entry opens.  The plugin is a directory
// put in the player's plugins folder, as an install leaves it.

test.skip(!container, 'puts a plugin in the run-web.sh container');

const NAME = 'fpp-tests-menus';

function put(path: string, content: string) {
  const b64 = Buffer.from(content).toString('base64');
  sh(`mkdir -p "$(dirname '${PLUGINS}/${NAME}/${path}')" && echo '${b64}' | base64 -d > '${PLUGINS}/${NAME}/${path}'`);
}

test.beforeEach(() => {
  sh(`rm -rf '${PLUGINS}/${NAME}'`);
  put('pluginInfo.json', JSON.stringify({
    name: NAME, repoName: NAME, author: 'fpp-tests', description: 'fpp-tests plugin',
    versions: [{ minFPPVersion: '0', maxFPPVersion: '0', branch: 'master', sha: '' }],
  }));
  // The older way of adding entries: a <menu>_menu.inc of plain links.
  put('output_menu.inc', `<li><a href="plugin.php?plugin=${NAME}&page=out.php">fpp-tests Output</a></li>\n`);
  put('status_menu.inc', `<li><a href="plugin.php?plugin=${NAME}&page=stat.php">fpp-tests Status</a></li>\n`);
  put('out.php', '<div id="fpp-tests-out">fpp-tests output page</div>\n');
  put('stat.php', '<div id="fpp-tests-stat">fpp-tests status page</div>\n');
});
test.afterEach(() => sh(`rm -rf '${PLUGINS}/${NAME}'`));

test("a plugin's Input/Output entry opens its page with the Input/Output menu highlighted", async ({ page }) => {
  // Regression: 5ca9d1000.  plugin.php never knew which menu its entry was
  // in, so no menu was highlighted on a plugin's page.  menu.inc now tags
  // each entry's link with its menu (_menu=...), and the "output" entries
  // with the menu bar's own key for it, "input-output".
  await page.goto('/index.php');
  const entry = page.locator('#navbarDropdownMenuLinkInOut + .dropdown-menu a', { hasText: 'fpp-tests Output' });
  await expect(entry).toHaveAttribute('href', `plugin.php?_menu=input-output&plugin=${NAME}&page=out.php`);
  await page.goto('/' + (await entry.getAttribute('href')));
  await expect(page.locator('#fpp-tests-out')).toBeVisible();
  const active = page.locator('.navbar .nav-item.dropdown.active > a.nav-link');
  await expect(active).toHaveCount(1);
  await expect(active).toHaveAttribute('id', 'navbarDropdownMenuLinkInOut');

  // The control: a Status entry highlights Status.
  await page.goto('/index.php');
  const status = page.locator('.dropdown-menu a', { hasText: 'fpp-tests Status' });
  await expect(status).toHaveAttribute('href', `plugin.php?_menu=status&plugin=${NAME}&page=stat.php`);
  await page.goto('/' + (await status.getAttribute('href')));
  await expect(page.locator('#fpp-tests-stat')).toBeVisible();
  await expect(active).toHaveCount(1);
  await expect(active).toContainText('Status');
});
