import { test, expect } from './fixtures';
import { container } from './container';
import { PluginRepo, PLUGINS, pluginInfo, restoreState, saveState, sh } from './plugin-repo';
import { routePluginsPage } from './plugins-page';

// The Plugins page's own verdicts on updates and recommendations.  The page
// runs with its plugin list served by the test (plugins-page.ts) and the
// installed plugins cloned from repositories inside the player
// (plugin-repo.ts), so nothing goes to GitHub.

test.skip(!container, 'builds plugin repositories inside the run-web.sh container');

// Update All's report of a plugin whose code updated but whose own upgrade
// script failed.  The page decides from the re-check afterwards, and that
// plugin no longer has an update, so it counted as updated successfully.
// - fpp abd379389 ("fix(plugins): Update All reports a plugin whose install
//   script failed") reads such plugins out of the streamed log's
//   "===== upgrade FINISH: <plugin> (rc=2) =====" line and reports them;
// - fpp 76d51f4be ("fix(plugins): Update All said "updated successfully"
//   when the install script failed") takes any non-zero rc there, since the
//   deferred script phase (upgrade_plugin --run-upgrade-script) ends with the
//   script's own rc (3 here), not 2.
test('Update All reports a plugin whose upgrade script failed', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const NAME = 'fpp-tests-updateall';
  saveState();
  const repo = new PluginRepo(NAME);
  try {
    repo.commit({ 'pluginInfo.json': pluginInfo(NAME), 'version.txt': '1\n' }, 'v1');
    const r = await page.request.post('/api/plugin', { data: repo.body(), timeout: 120_000 });
    expect((await r.json()).Status).toBe('OK');
    const v2 = repo.commit({
      'version.txt': '2\n',
      'scripts/fpp_upgrade.sh': { content: '#!/bin/sh\necho fpp-tests upgrade script ran\nexit 3\n', mode: '755' },
    }, 'v2');

    await routePluginsPage(page, baseURL!, []);
    await page.goto('/plugins.php');
    await page.waitForFunction((n) => ((window as any).installedPlugins || []).includes(n), NAME);
    await page.evaluate(() => (window as any).UpdateAllPlugins());
    const confirm = page.locator('#updateAllPluginsDialog');
    await expect(confirm).toBeVisible({ timeout: 60_000 });
    await expect(confirm).toContainText(NAME);
    await confirm.getByRole('button', { name: 'Update All' }).click();

    const log = page.locator('#pluginsProgressPopupText');
    await expect.poll(async () => await log.inputValue(), { timeout: 120_000 }).toContain('Reload the page to refresh the plugin list');
    const text = await log.inputValue();
    // The control: the update ran, and its code landed.
    expect(sh(`git -C ${PLUGINS}/${NAME} rev-parse HEAD`).trim(), text).toBe(v2);
    expect(text).toContain('fpp-tests upgrade script ran');
    expect(text, 'Update All counted the failed script as a success').not.toContain('1 of 1 plugin(s) updated successfully');
    expect(text).toMatch(/install\/upgrade script failed[^\n]*fpp-tests-updateall/);
  } finally {
    repo.remove();
    restoreState([NAME]);
  }
});
