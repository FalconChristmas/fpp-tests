import { test, expect } from './fixtures';
import { container } from './container';
import { PluginRepo, PLUGINS, pluginInfo, restoreState, saveState, sh } from './plugin-repo';
import { routePluginsPage } from './plugins-page';

// The Plugins page's own verdicts on updates and recommendations.  The page
// runs with its plugin list served by the test (plugins-page.ts) and the
// installed plugins cloned from repositories inside the player
// (plugin-repo.ts), so nothing goes to GitHub.

test.skip(!container, 'builds plugin repositories inside the run-web.sh container');

const listedPlugin = (name: string, minFPPVersion: string) => ({
  name, repoName: name, author: 'fpp-tests', description: 'fpp-tests', homeURL: '',
  srcURL: `https://github.com/fpp-tests/${name}.git`,
  versions: [{ minFPPVersion, maxFPPVersion: '0', branch: 'master', sha: '' }],
});

// fpp 1bcca1964 ("fix(plugins): don't recommend plugins not updated for this
// FPP release"): the Popular strip, the page's recommendations, took any
// plugin it could install, so one whose only version was built for an older
// FPP major (offered as "Install anyway", untested here) was recommended
// alongside the ones made for this release.
test('the Popular strip leaves out a plugin not updated for this FPP release', async ({ page, baseURL }) => {
  const OK = 'fpp-tests-rec-current';
  const OLD = 'fpp-tests-rec-untested';
  const major = (await (await page.request.get('/api/system/info')).json()).Version.split('.')[0];
  // The untested plugin is the more popular, so only the filter can keep it out.
  await routePluginsPage(page, baseURL!, [listedPlugin(OK, `${major}.0`), listedPlugin(OLD, `${Number(major) - 1}.0`)],
    { [OK]: 50, [OLD]: 100 });
  await page.goto('/plugins.php');
  await page.waitForFunction((names) => {
    const w = window as any;
    const infos = w.pluginInfos || [];
    return w.popularityLoaded && names.every((n: string) => infos.some((d: any) => d && d.repoName === n));
  }, [OK, OLD]);
  // The page rebuilds the strip 300 ms after the last plugin arrives; build
  // it now, from everything loaded, rather than race that.
  await page.evaluate(() => (window as any).BuildPopularStrip());
  // The control: the strip is built, and holds the plugin made for this release.
  await expect(page.locator('#popularStrip')).toContainText(OK);
  expect(await page.locator('#popularStrip').textContent()).not.toContain(OLD);
});

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
    // The install records "no update" stamped with its second, and a check
    // drops its own answer for the plugin when the recorded one is as new:
    // a check started in the install's second (Update All below, on a fast
    // run) left that answer standing, and Update All offered nothing.
    await new Promise((res) => setTimeout(res, 1_100));
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
