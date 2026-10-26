import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { CATEGORIES_URL, LIST_URL, infoURL, routePluginsPage } from './plugins-page';

// The Plugin Manager's Available list: what it lists where, its categories,
// its search, and the box that loads a plugin from a URL.  The plugin list,
// its categories and every pluginInfo.json the page fetches from
// raw.githubusercontent.com are answered by the test (plugins-page.ts), the
// way GitHub serves them; nothing leaves the machine.

test.skip(!container, 'serves the plugin list to the run-web.sh container');

const CORS = { 'Access-Control-Allow-Origin': '*' };

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

// The plugin list with a category for each plugin (the list's third field)
// and the category list, as fpp-data serves them.  Routed after
// routePluginsPage(), so these answer instead of its uncategorised ones.
async function routeCategories(page: Page, categories: Record<string, unknown>[], of: Record<string, string>, plugins: Record<string, unknown>[]) {
  await page.route(CATEGORIES_URL, (route) => route.fulfill({ headers: CORS, json: { categories } }));
  await page.route(LIST_URL, (route) => route.fulfill({
    headers: CORS,
    json: { pluginList: plugins.map((p) => [p.repoName, infoURL(p.repoName as string), ...(of[p.repoName as string] ? [of[p.repoName as string]] : [])]) },
  }));
}

// Opens the page and waits until every named plugin has been loaded (and so
// placed, or left out, by LoadPlugin()).
async function openPage(page: Page, names: string[]) {
  await page.goto('/plugins.php');
  await page.waitForFunction((n) => n.every((r: string) => ((window as any).pluginInfos || []).some((d: any) => d && d.repoName === r)), names);
}

const card = (page: Page, name: string) => page.locator(`[id="row-${name}"]`);

test('a GitHub repository URL loads the plugin from its pluginInfo.json', async ({ page, request, baseURL }) => {
  // Regression: bc7698015 ("load a plugin from its GitHub repo URL").  Only a
  // URL ending in pluginInfo.json loaded a plugin; a repository's address was
  // searched for as text.
  const NAME = 'fpp-tests-ghurl';
  const m = await major(request);
  const info = listed(NAME, [{ minFPPVersion: `${m}.0`, maxFPPVersion: '0', branch: 'master', sha: '' }]);
  await setUiLevel(request, '3');
  await routePluginsPage(page, baseURL!, []);
  const fetched: string[] = [];
  // Where raw.githubusercontent.com serves a repository's file: HEAD is its
  // default branch, whatever that is called.
  await page.route(`https://raw.githubusercontent.com/fpp-tests/${NAME}/**`, (route) => {
    fetched.push(route.request().url());
    return route.fulfill({ headers: CORS, json: info });
  });
  await openPage(page, []);
  const input = page.locator('#pluginInput');
  for (const [typed, url] of [
    [`github.com/fpp-tests/${NAME}`, `https://raw.githubusercontent.com/fpp-tests/${NAME}/HEAD/pluginInfo.json`],
    [`https://www.github.com/fpp-tests/${NAME}.git`, `https://raw.githubusercontent.com/fpp-tests/${NAME}/HEAD/pluginInfo.json`],
    [`https://github.com/fpp-tests/${NAME}/tree/v2/`, `https://raw.githubusercontent.com/fpp-tests/${NAME}/v2/pluginInfo.json`],
  ]) {
    fetched.length = 0;
    await input.fill('');
    await input.fill(typed);
    await expect.poll(() => fetched, { message: typed }).toEqual([url]);
    await expect(card(page, NAME), typed).toBeVisible();
  }
  // The control: plain text is searched for, and loads nothing.
  fetched.length = 0;
  await input.fill('');
  await input.fill(`fpp-tests/${NAME}`);
  await page.waitForTimeout(500);
  expect(fetched).toEqual([]);
});

test('a pluginInfo.json URL that does not load says so in the page', async ({ page, request, baseURL }) => {
  // Regression: b9b4cb87c ("show the URL-load error message").  The message
  // for a URL that loaded nothing was hidden whenever there was one to show.
  // Regression: 42a1fb4d1 ("auto-load pluginInfo.json URLs, inline X clear
  // button, remove browser alerts").  A pasted URL waited for a button, and
  // a failure came up as an alert().
  const BAD = infoURL('fpp-tests-not-there');
  await setUiLevel(request, '3');
  await routePluginsPage(page, baseURL!, []);
  // GitHub's answer for a file that is not there.
  await page.route(BAD, (route) => route.fulfill({ status: 404, headers: CORS, body: '404: Not Found' }));
  let alerted = '';
  page.on('dialog', (d) => { alerted = d.message(); d.dismiss().catch(() => undefined); });
  await openPage(page, []);
  await page.locator('#pluginInput').fill(BAD);
  // Retried through the player's own proxy, which (with no GitHub
  // credentials set up) refuses; then the page says so.
  await expect(page.locator('#noUrlResults')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#noUrlResults .fppUrlErrorTerm')).toHaveText(BAD);
  expect(alerted, 'the failure came up as an alert').toBe('');
  // The X clears the box and the message.
  await page.locator('#pluginClearBtn').click();
  await expect(page.locator('#pluginInput')).toHaveValue('');
  await expect(page.locator('#noUrlResults')).toBeHidden();
});

test('a pasted pluginInfo.json URL loads on its own and the X takes it away', async ({ page, request, baseURL }) => {
  // Regression: 42a1fb4d1.  Regression: 5b017702f ("URL import not
  // switching tabs").  A plugin loaded from a URL was put on the Available
  // tab while the Installed tab stayed showing.
  const NAME = 'fpp-tests-pasted';
  const m = await major(request);
  await setUiLevel(request, '3');
  await routePluginsPage(page, baseURL!, []);
  await page.route(infoURL(NAME), (route) => route.fulfill({
    headers: CORS, json: listed(NAME, [{ minFPPVersion: `${m}.0`, maxFPPVersion: '0', branch: 'master', sha: '' }]),
  }));
  await openPage(page, []);
  await page.evaluate(() => (window as any).ShowTopTab('installed'));
  await expect(page.locator('#pane-available')).toBeHidden();
  await page.locator('#pluginInput').fill(infoURL(NAME));
  await expect(card(page, NAME)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#pane-available')).toBeVisible();
  await expect(page.locator('#pluginTopTabs .nav-link.active')).toHaveAttribute('data-top-tab', 'available');
  await page.locator('#pluginClearBtn').click();
  await expect(page.locator('#pluginInput')).toHaveValue('');
  await expect(card(page, NAME)).toHaveCount(0);
});

test('a URL without http:// or https:// gets a warning', async ({ page, request, baseURL }) => {
  // Feature: fae89c348 ("add missing URL scheme warning").
  await setUiLevel(request, '3');
  await routePluginsPage(page, baseURL!, []);
  await openPage(page, []);
  const typed = 'raw.githubusercontent.com/fpp-tests/fpp-tests-noscheme/master/pluginInfo.json';
  await page.locator('#pluginInput').fill(typed);
  await expect(page.locator('#noUrlSchemeResults')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#noUrlSchemeResults .fppUrlSchemeErrorTerm')).toHaveText(typed);
  // The control: with the scheme there is no such warning.
  await page.locator('#pluginInput').fill(`https://${typed}`);
  await expect(page.locator('#noUrlSchemeResults')).toBeHidden();
});

test('the search narrows the incompatible plugins too', async ({ page, request, baseURL }) => {
  // Regression: b9b4cb87c ("apply search filtering to the Incompatible
  // Plugins section").  A search left that section as it was, its plugins
  // showing under a search that matched none of them.
  const A = 'fpp-tests-incompat-alpha';
  const B = 'fpp-tests-incompat-beta';
  const old = [{ minFPPVersion: '5.0', maxFPPVersion: '5.999', branch: 'master', sha: '' }];
  await setUiLevel(request, '1');
  await routePluginsPage(page, baseURL!, [listed(A, old), listed(B, old)]);
  await openPage(page, [A, B]);
  const grid = page.locator('#incompatibleGrid');
  await expect(grid.locator(`[id="row-${A}"]`)).toBeAttached();
  await page.locator('#pluginInput').fill('alpha');
  await expect(grid.locator(`[id="row-${B}"]`), 'a plugin the search does not match is listed').toHaveClass(/d-none/);
  await expect(grid.locator(`[id="row-${A}"]`)).not.toHaveClass(/d-none/);
  await expect(page.locator('#incompatiblePluginsCount')).toHaveText('1');
  await page.locator('#pluginInput').fill('fpp-tests-matches-nothing');
  await expect(page.locator('#incompatiblePluginsWrap')).toBeHidden();
});

test('a plugin whose maxFPPVersion is this version is compatible', async ({ page, request, baseURL }) => {
  // Regression: e99f18998 ("fix bug in plugin version evaluation").  The
  // upper bound was exclusive: a plugin that named this very version as its
  // last was taken as incompatible with it.
  const NAME = 'fpp-tests-max-this';
  const m = await major(request);
  await setUiLevel(request, '1');
  await routePluginsPage(page, baseURL!, []);
  await page.goto('/plugins.php');
  const triplet = await page.evaluate(() => (window as any).getFPPVersionTriplet());
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await routePluginsPage(page, baseURL!, [listed(NAME, [{ minFPPVersion: `${m}.0`, maxFPPVersion: triplet, branch: 'master', sha: '' }])]);
  await openPage(page, [NAME]);
  await expect(page.locator(`#pluginGrid [id="row-${NAME}"]`), `maxFPPVersion ${triplet}`).toBeAttached();
  await expect(page.locator(`#incompatibleGrid [id="row-${NAME}"]`)).toHaveCount(0);
});

test('an uncategorised plugin is under one Other pill, even when the category list has an Other', async ({ page, request, baseURL }) => {
  // Regression: 5b017702f ("missing other category").  A plugin with no
  // category was counted under an Other pill that was never added.
  // Regression: 5f4a8f8c6 ("Other category is sometimes shown duplicated").
  // An "Other" in pluginCategories.json made a second one.
  const SORTED = 'fpp-tests-audio';
  const LOOSE = 'fpp-tests-loose';
  const m = await major(request);
  const v = [{ minFPPVersion: `${m}.0`, maxFPPVersion: '0', branch: 'master', sha: '' }];
  const plugins = [listed(SORTED, v), listed(LOOSE, v)];
  for (const categories of [[{ name: 'Audio' }], [{ name: 'Audio' }, { name: 'Other' }]]) {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await routePluginsPage(page, baseURL!, plugins);
    await routeCategories(page, categories, { [SORTED]: 'Audio' }, plugins);
    await openPage(page, [SORTED, LOOSE]);
    const names = categories.map((c) => c.name).join(', ');
    const other = page.locator('#pluginCategoryPills .nav-link', { hasText: 'Other' });
    await expect(other, names).toHaveCount(1);
    await expect(card(page, LOOSE)).toHaveAttribute('data-category-slug', 'other');
    await expect(other.locator('.fppCatCount')).toHaveText('1');
    // The control: the categorised one is under its own pill.
    await expect(page.locator('#pluginCategoryPills .nav-link', { hasText: 'Audio' }).locator('.fppCatCount')).toHaveText('1');
  }
});

test('a plugin that needs more RAM or CPU cores than the player has is marked, and hidden at Basic', async ({ page, request, baseURL }) => {
  // Feature: ae7078eaa ("Add plugin min RAM/CPU resource hints").  The
  // device's memory and cores are the player's own, put in the page by PHP.
  const BIG = 'fpp-tests-needs-more';
  const SMALL = 'fpp-tests-needs-less';
  const m = await major(request);
  const v = [{ minFPPVersion: `${m}.0`, maxFPPVersion: '0', branch: 'master', sha: '' }];
  const plugins = [listed(BIG, v, { minMemoryMB: 99999999, minCpuCores: 4096 }), listed(SMALL, v, { minMemoryMB: 1, minCpuCores: 1 })];
  const memMB = Math.round(parseInt(inPlayer('sh', '-c', "awk '/^MemTotal/ {print $2}' /proc/meminfo"), 10) / 1024);
  const cores = parseInt(inPlayer('nproc').trim(), 10);
  for (const [level, shown] of [['1', true], ['0', false]] as const) {
    await setUiLevel(request, level);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await routePluginsPage(page, baseURL!, plugins);
    await openPage(page, [BIG, SMALL]);
    expect(Math.abs(await page.evaluate(() => (window as any).DEVICE_MEM_MB) - memMB), 'the page has the player\'s memory').toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => (window as any).DEVICE_CORES)).toBe(cores);
    // The control: the one within the player's means is listed, unmarked.
    await expect(card(page, SMALL)).toBeAttached();
    await expect(card(page, SMALL).locator('.pluginResourceBadge')).toHaveCount(0);
    if (shown) {
      const badge = card(page, BIG).locator('.pluginResourceBadge');
      await expect(badge, `uiLevel ${level}`).toHaveText('Not Enough RAM/CPU');
      await expect(badge).toHaveAttribute('title', `This plugin needs 99999999 MB RAM (this device has ${await page.evaluate(() => (window as any).DEVICE_MEM_MB)} MB); needs 4096 CPU cores (this device has ${cores}). It may run poorly or not at all on this device.`);
      await expect(card(page, BIG).locator('[data-plugin-action="install"]')).toContainText('Install anyway');
    } else {
      await expect(card(page, BIG), `uiLevel ${level}`).toHaveCount(0);
    }
  }
});

test('plugins usable here are listed ahead of the rest, whatever their popularity', async ({ page, request, baseURL }) => {
  // Regression: dc2326953 ("compat-first sort").  The Available grid was in
  // order of popularity, so a popular plugin not updated for this FPP came
  // ahead of the ones that install.
  const UNTESTED = 'fpp-tests-aa-untested';
  const COMPAT = 'fpp-tests-zz-compat';
  const m = await major(request);
  await setUiLevel(request, '1');
  await routePluginsPage(page, baseURL!, [
    // Made for an older major, with no upper bound: "not updated for this FPP".
    listed(UNTESTED, [{ minFPPVersion: `${parseInt(m, 10) - 1}.0`, maxFPPVersion: '0', branch: 'master', sha: '' }]),
    listed(COMPAT, [{ minFPPVersion: `${m}.0`, maxFPPVersion: '0', branch: 'master', sha: '' }]),
  ], { [UNTESTED]: 5000, [COMPAT]: 3 });
  await openPage(page, [UNTESTED, COMPAT]);
  await page.waitForTimeout(1000);
  const order = await page.locator('#pluginGrid > .pluginCard').evaluateAll((cards) => cards.map((c) => c.id));
  expect(order).toEqual([`row-${COMPAT}`, `row-${UNTESTED}`]);
});

test('a search updates the category counts to what it matches', async ({ page, request, baseURL }) => {
  // Feature: 454a5c3b8 ("dynamic search counts").  The category pills
  // counted every plugin in the category, whatever the search.
  const m = await major(request);
  const v = [{ minFPPVersion: `${m}.0`, maxFPPVersion: '0', branch: 'master', sha: '' }];
  const plugins = [listed('fpp-tests-audio-one', v), listed('fpp-tests-audio-two', v), listed('fpp-tests-video-one', v)];
  await routePluginsPage(page, baseURL!, plugins);
  await routeCategories(page, [{ name: 'Audio' }, { name: 'Video' }],
    { 'fpp-tests-audio-one': 'Audio', 'fpp-tests-audio-two': 'Audio', 'fpp-tests-video-one': 'Video' }, plugins);
  await openPage(page, plugins.map((p) => p.repoName));
  const count = (name: string) => page.locator('#pluginCategoryPills .nav-link', { hasText: name }).locator('.fppCatCount');
  await expect(count('Audio')).toHaveText('2');
  await expect(count('Video')).toHaveText('1');
  await page.locator('#pluginInput').fill('two');
  await expect(count('Audio')).toHaveText('1');
  await expect(count('All')).toHaveText('1');
  // A category the search matches nothing in is not offered.
  await expect(page.locator('#pluginCategoryPills .nav-link', { hasText: 'Video' }).locator('xpath=..')).toHaveClass(/d-none/);
  await expect(page.locator('#topCountAvailable')).toHaveText('1');
});
