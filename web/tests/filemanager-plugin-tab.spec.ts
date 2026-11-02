import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// A plugin's own File Manager tab: pluginInfo.json names a file extension
// with a "tab", and <ext>-tab.inc holds the tab's content.

test.skip(!container, 'seeds a plugin inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const PLUGIN = 'fpp-tests-tab-plugin';
const DIR = `${MEDIA}/plugins/${PLUGIN}`;

test.afterEach(() => {
  inPlayer('rm', '-rf', DIR);
});

test('a plugin\'s File Manager tab runs the php in its tab file', async ({ page }) => {
  // Regression: 460786619.  The page read the tab file as text and echoed it,
  // so a tab with php in it (the usual way to list the plugin's own files)
  // reached the browser as the php source and drew nothing.
  inPlayer('sh', '-c', `mkdir -p ${DIR} && printf '%s' '{"name":"${PLUGIN}","fileExtensions":{"fptest":{"tab":"FPTest","folder":"fptest"}}}' > ${DIR}/pluginInfo.json`);
  inPlayer('sh', '-c', `printf '%s' '<div class="tab-pane fade" id="tab-fptest" role="tabpanel"><p id="fptestOut">computed <?php echo 6 * 7; ?> here</p></div>' > ${DIR}/fptest-tab.inc`);
  await page.goto(`/filemanager.php?fpp-tests=${Date.now()}`);
  await page.locator('#tab-fptest-tab').click();
  await expect(page.locator('#tab-fptest')).toBeVisible();
  await expect(page.locator('#fptestOut')).toHaveText('computed 42 here');
  expect(await page.content()).not.toContain('<?php');
});
