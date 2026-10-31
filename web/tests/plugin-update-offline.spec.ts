import { test, expect } from './fixtures';
import { container } from './container';
import { PluginRepo, sh, clonePlugin, routePluginList, clearPluginSourceSettings } from './plugin-backfill';

// A player that can reach none of its plugins' repositories (offline, or a
// show network with no route out): checking for updates must say the plugins
// could not be checked, never that they are up to date.  Two plugins whose
// origin refuses the connection make every fetch fail, which the background
// check records as an "offline" pass.

test.skip(!container, 'installs plugins from repositories inside the run-web.sh container');

const repos: PluginRepo[] = [];

test.beforeEach(() => {
  for (const name of ['fpp-tests-offline-a', 'fpp-tests-offline-b']) {
    const r = new PluginRepo(name);
    repos.push(r);
    r.init();
    clonePlugin(r);
    sh(`git -C ${r.dir} remote set-url origin http://127.0.0.1:9/${name}.git`);
  }
});

test.afterEach(() => {
  for (const r of repos.splice(0)) {
    r.remove();
  }
  clearPluginSourceSettings();
});

async function openPluginsPage(page: any) {
  await routePluginList(page);
  await page.goto('/plugins.php');
  for (const r of repos) {
    await expect(page.locator(`[id="row-${r.name}"]`)).toBeAttached({ timeout: 20_000 });
  }
}

test('Check for Updates on an offline player does not say the plugins are up to date', async ({ page }) => {
  // Regression: 4b890cc25.  A fetch that failed came back as Status Error
  // with HTTP 200, which the page counted as "no update", so with every fetch
  // failing it said "All plugins are up to date".  The browser-side check was
  // later replaced by the server's (1b2705a93); this holds for both.
  // Also 064b5d7ec: the Check for Updates button (#checkAllUpdatesBtn, first
  // "Check All for Updates") runs the check and reports its outcome.
  test.setTimeout(120_000);
  await openPluginsPage(page);
  await page.locator('#pluginTopTabs .nav-link[data-top-tab="installed"]').click();
  await page.locator('#checkAllUpdatesBtn').click();
  // Whatever the check says when it is done ("some checks failed" when the
  // fix landed, "2 could not be checked" now), it must say it is not sure.
  const growl = page.locator('.jGrowl-message').filter({ hasText: /up to date|could not|failed/i });
  await expect(growl.first()).toBeVisible({ timeout: 90_000 });
  const text = (await growl.allTextContents()).join('\n');
  expect(text).not.toMatch(/up to date/i);
  expect(text).toMatch(/could not|failed/i);
});

test('the Updates tab says the last check reached no plugin repository', async ({ page, request }) => {
  // Feature: d62d3345c (the Updates tab's status line).  An offline pass is
  // told apart from a partial one: each plugin is named as not known to be
  // up to date, with why, and the line says nothing could be reached.
  test.setTimeout(120_000);
  await openPluginsPage(page);
  await page.locator('#pluginTopTabs .nav-link[data-top-tab="installed"]').click();
  await page.locator('#checkAllUpdatesBtn').click();
  // The control: the check finished, and as an offline pass.
  await expect.poll(async () => (await (await request.get('/api/plugin/updateStatus')).json()).sweep?.result,
    { timeout: 90_000 }).toBe('offline');

  await page.locator('#pluginTopTabs .nav-link[data-top-tab="updates"]').click();
  const line = page.locator('#pluginUpdateStatusLine');
  await expect(line).toContainText('The last background check could not reach any plugin repository.');
  await expect(line).toContainText('Could not check 2 plugins, so they are not known to be up to date');
  for (const r of repos) {
    await expect(line).toContainText(`${r.name} - the player could not reach the repository host`);
  }
});
