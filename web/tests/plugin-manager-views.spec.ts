import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container } from './container';
import { PluginRepo, PLUGINS, pluginInfo, restoreState, saveState, exists } from './plugin-repo';
import { routePluginsPage } from './plugins-page';
import { runUpdateCheck } from './plugin-backfill';

// What the Plugin Manager lists, finds and offers: the incompatible section
// by UI level, the search, Update for a plugin that pins its updates per
// version, and Uninstall All.  The plugin list is served by the test
// (plugins-page.ts) and installed plugins come from repositories inside the
// player (plugin-repo.ts), so nothing goes to GitHub.

test.skip(!container, 'serves the plugin list and builds plugin repositories inside the run-web.sh container');

async function major(request: APIRequestContext): Promise<string> {
  return (await (await request.get('/api/system/info')).json()).Version.split('.')[0];
}

const listed = (name: string, versions: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  name, repoName: name, author: 'fpp-tests', description: 'fpp-tests plugin', homeURL: '',
  srcURL: `https://github.com/fpp-tests/${name}.git`, versions, ...extra,
});

let uiLevel = '0';
test.beforeEach(async ({ request }) => {
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
});
test.afterEach(async ({ request }) => {
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
});

async function setUiLevel(request: APIRequestContext, level: string) {
  expect((await request.put('/api/settings/uiLevel', { data: level })).ok()).toBe(true);
}

// Opens the page and waits until every named plugin has been loaded (and so
// placed, or left out, by LoadPlugin()).
async function openPage(page: Page, names: string[]) {
  await page.goto('/plugins.php');
  await page.waitForFunction((n) => n.every((r: string) => ((window as any).pluginInfos || []).some((d: any) => d && d.repoName === r)), names);
}

test('an incompatible plugin is listed at Advanced, and not at Basic', async ({ page, request, baseURL }) => {
  // Regression: e00c3c184 ("Add early return for uiLevel check").  Basic hid
  // plugins it could only "Install anyway", but showed the ones that won't
  // install on this FPP at all, in their own section.
  // Feature: 119fd772d ("Show incompatible plugins in a collapsed section").
  // They had been listed with the rest, at the Developer level only.
  const OK = 'fpp-tests-compat';
  const BAD = 'fpp-tests-incompat';
  const m = await major(request);
  const plugins = [
    listed(OK, [{ minFPPVersion: `${m}.0`, maxFPPVersion: '0', branch: 'master', sha: '' }]),
    listed(BAD, [{ minFPPVersion: '5.0', maxFPPVersion: '5.999', branch: 'master', sha: '' }]),
  ];
  for (const [level, shown] of [['0', false], ['1', true]] as const) {
    await setUiLevel(request, level);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await routePluginsPage(page, baseURL!, plugins);
    await openPage(page, [OK, BAD]);
    // The control: the compatible one is listed at both levels.
    await expect(page.locator(`#pluginGrid [id="row-${OK}"]`)).toBeAttached();
    await expect(page.locator(`#incompatibleGrid [id="row-${BAD}"]`), `uiLevel ${level}`).toHaveCount(shown ? 1 : 0);
    await expect(page.locator(`#pluginGrid [id="row-${BAD}"]`)).toHaveCount(0);
    if (shown) {
      await expect(page.locator('#incompatiblePluginsWrap')).toBeVisible();
      // Collapsed until opened.
      await expect(page.locator('#incompatiblePluginsWrap details')).not.toHaveAttribute('open', /.*/);
      await expect(page.locator(`#incompatibleGrid [id="row-${BAD}"]`)).toBeHidden();
      await expect(page.locator('#incompatiblePluginsCount')).toHaveText('1');
    } else await expect(page.locator('#incompatiblePluginsWrap')).toBeHidden();
  }
});

test('the plugin search finds a plugin by its author or its description', async ({ page, baseURL }) => {
  // Regression: bf3102bd7 ("Enhance plugin search by including author and
  // description").  Only the title was searched.
  const BY_AUTHOR = 'fpp-tests-search-a';
  const BY_DESC = 'fpp-tests-search-b';
  const v = [{ minFPPVersion: '0', maxFPPVersion: '0', branch: 'master', sha: '' }];
  await routePluginsPage(page, baseURL!, [
    listed(BY_AUTHOR, v, { srcURL: `https://github.com/fpp-tests-zebra/${BY_AUTHOR}.git` }),
    listed(BY_DESC, v, { description: 'Drives a quokka-shaped prop' }),
  ]);
  await page.request.put('/api/settings/uiLevel', { data: '1' });
  await openPage(page, [BY_AUTHOR, BY_DESC]);
  const card = (n: string) => page.locator(`#pluginGrid [id="row-${n}"]`);
  const search = async (text: string) => {
    await page.locator('#pluginInput').fill(text);
    await page.evaluate(() => (window as any).FilterPlugins());
  };
  // The control: a title search finds its plugin and hides the other.
  await search('search-a');
  await expect(card(BY_AUTHOR)).toBeVisible();
  await expect(card(BY_DESC)).toBeHidden();
  await search('zebra');
  await expect(card(BY_AUTHOR), 'not found by its author').toBeVisible();
  await expect(card(BY_DESC)).toBeHidden();
  await search('quokka');
  await expect(card(BY_DESC), 'not found by its description').toBeVisible();
  await expect(card(BY_AUTHOR)).toBeHidden();
});

test('a plugin\'s Update follows the allowUpdates of the version this FPP uses', async ({ page, request, baseURL }) => {
  // Regression: 8e3ecf0f4 ("honor per-version allowUpdates in Plugin
  // Manager").  Only the top-level allowUpdates was read, so a plugin could
  // not freeze one FPP major's version (pinned, allowUpdates 0) while keeping
  // updates on for another.  Both plugins here have an update waiting.
  test.setTimeout(240_000);
  const FROZEN = 'fpp-tests-allow-frozen';
  const OPEN = 'fpp-tests-allow-open';
  const m = await major(request);
  const ver = (allowUpdates: number) => [{ minFPPVersion: `${m}.0`, maxFPPVersion: '0', branch: 'master', allowUpdates }];
  saveState();
  const repos = [new PluginRepo(FROZEN), new PluginRepo(OPEN)];
  try {
    const infos = { [FROZEN]: { allowUpdates: 1, versions: ver(0) }, [OPEN]: { allowUpdates: 0, versions: ver(1) } };
    for (const repo of repos) {
      repo.commit({ 'pluginInfo.json': pluginInfo(repo.name, infos[repo.name]), 'version.txt': '1\n' }, 'v1');
      const r = await request.post('/api/plugin', { data: repo.body(), timeout: 120_000 });
      expect((await r.json()).Status, repo.name).toBe('OK');
    }
    // As in plugins-page.spec.ts: a check in the install's second is dropped.
    await new Promise((res) => setTimeout(res, 1_100));
    for (const repo of repos) repo.commit({ 'version.txt': '2\n' }, 'v2');
    runUpdateCheck();

    await routePluginsPage(page, baseURL!, []);
    await page.goto('/plugins.php');
    await page.waitForFunction((n) => n.every((r: string) => ((window as any).installedPlugins || []).includes(r)), [FROZEN, OPEN]);
    await page.evaluate(() => (window as any).ShowTopTab('installed'));
    const update = (n: string) => page.locator(`[id="row-${n}"] [data-plugin-action="update"]`);
    // The control: the open one offers its waiting update.
    await expect(update(OPEN)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(`[id="row-${FROZEN}"]`)).toBeAttached();
    await expect(update(FROZEN), 'an update was offered for a version that freezes them').toHaveCount(0);
  } finally {
    for (const repo of repos) repo.remove();
    restoreState([FROZEN, OPEN]);
  }
});

test('Uninstall All uninstalls every installed plugin', async ({ page, request, baseURL }) => {
  // Feature: df6243639 ("Add Advanced option to uninstall all plugins"); it
  // was shown at the Developer UI level only then, and at every level since
  // 02e2a3244.
  test.setTimeout(240_000);
  const names = ['fpp-tests-uninstall-a', 'fpp-tests-uninstall-b'];
  saveState();
  const repos = names.map((n) => new PluginRepo(n));
  try {
    for (const repo of repos) {
      repo.commit({ 'pluginInfo.json': pluginInfo(repo.name) }, 'v1');
      const r = await request.post('/api/plugin', { data: repo.body(), timeout: 120_000 });
      expect((await r.json()).Status, repo.name).toBe('OK');
    }
    await setUiLevel(request, '3');
    await routePluginsPage(page, baseURL!, []);
    await page.goto('/plugins.php');
    await page.waitForFunction((n) => n.every((r: string) => ((window as any).installedPlugins || []).includes(r)), names);
    await page.evaluate(() => (window as any).ShowTopTab('installed'));
    await page.locator('#uninstallAllBtn').click({ timeout: 30_000 });
    const confirm = page.locator('#uninstallAllPluginsDialog');
    await expect(confirm).toContainText(/uninstall all \d+ installed plugin/);
    await confirm.getByRole('button', { name: 'Uninstall All' }).click();
    // The receiving end: the plugins are gone from the player.
    await expect.poll(() => names.filter((n) => exists(`${PLUGINS}/${n}`)), { timeout: 120_000 }).toEqual([]);
    const left = await (await request.get('/api/plugin')).json();
    expect(left.filter((n: string) => names.includes(n))).toEqual([]);
  } finally {
    for (const repo of repos) repo.remove();
    restoreState(names);
  }
});
