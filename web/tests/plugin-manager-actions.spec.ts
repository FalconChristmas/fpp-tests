import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { PluginRepo, sh, exists, clonePlugin, installPlugin, routePluginList, clearPluginSourceSettings } from './plugin-backfill';
import { routePluginsPage } from './plugins-page';

// What the Plugin Manager's buttons do to installed plugins: the update
// check, Update from a plugin's details, Reinstall and Reinstall All.  The
// plugins come from git repositories inside the player (plugin-backfill.ts);
// the receiving end is the plugin's directory on the player afterwards.

test.skip(!container, 'installs plugins from repositories inside the run-web.sh container');

const repos: PluginRepo[] = [];
function newRepo(name: string): PluginRepo {
  const r = new PluginRepo(name);
  repos.push(r);
  return r;
}

let uiLevel = '0';
test.beforeEach(async ({ request }) => {
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
});
test.afterEach(async ({ request }) => {
  for (const r of repos.splice(0)) r.remove();
  clearPluginSourceSettings();
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
});

async function openPluginsPage(page: Page, installed: string[]) {
  await routePluginList(page);
  await page.goto('/plugins.php');
  for (const p of installed) {
    await expect(page.locator(`[id="row-${p}"]`)).toBeAttached({ timeout: 20_000 });
  }
  await page.locator('#pluginTopTabs .nav-link[data-top-tab="installed"]').click();
}

async function openDetail(page: Page, name: string) {
  await page.locator(`[id="row-${name}"] .pluginTitle`).first().click();
  await expect(page.locator('#pluginDetailDialog')).toBeVisible();
}

test('Check for Updates shows it is busy until the check is done', async ({ page }) => {
  // Feature: 05b52536b ("Show spinner on the Check for Updates button").
  // The check is the player's own; its answer is held back here so the
  // busy state can be seen.
  const repo = newRepo('fpp-tests-act-spin');
  repo.init();
  clonePlugin(repo);
  await openPluginsPage(page, [repo.name]);
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/plugin/updateStatus/refresh', async (route) => {
    await held;
    await route.continue();
  });
  const button = page.locator('#checkAllUpdatesBtn');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toBeDisabled();
  await expect(button.locator('.fa-spin')).toHaveCount(1);
  release();
  await expect(button).toBeEnabled({ timeout: 90_000 });
  await expect(button.locator('.fa-spin')).toHaveCount(0);
});

test("a plugin's details offer Update once its check finds one, and Update updates it", async ({ page }) => {
  // Regression: f58622e8a ("Show Update button in plugin detail modal when
  // an update is available").  The check found the update and said nothing
  // in the dialog it was run from.
  const repo = newRepo('fpp-tests-act-detail');
  repo.init();
  clonePlugin(repo);
  const head = repo.commit('v2', { 'v.txt': '2\n' });
  await openPluginsPage(page, [repo.name]);
  await openDetail(page, repo.name);
  await page.locator('#pluginDetailCheckBtn').click();
  const update = page.locator('#pluginDetailDialog button', { hasText: /^\s*Update\s*$/ });
  await expect(update).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#pluginDetailCheckBtn')).toHaveCount(0);
  await update.click();
  // The receiving end: the plugin on the player is at the new commit.
  await expect.poll(() => repo.installedHead(), { timeout: 120_000 }).toBe(head);
});

test("a plugin list entry's markup is shown as text", async ({ page, request, baseURL }) => {
  // Regression: 02e2a3244 ("escape untrusted pluginInfo.json data").  The
  // name and description went into the page as markup.
  const NAME = 'fpp-tests-act-markup';
  const hostile = '<img src=x onerror="window.__pwned=1">';
  await routePluginsPage(page, baseURL!, [{
    name: `Plugin ${hostile}`, repoName: NAME, author: 'fpp-tests', description: `Does ${hostile} things`,
    homeURL: '', srcURL: `https://github.com/fpp-tests/${NAME}.git`,
    versions: [{ minFPPVersion: `${(await (await request.get('/api/system/info')).json()).Version.split('.')[0]}.0`, maxFPPVersion: '0', branch: 'master', sha: '' }],
  }]);
  await page.goto('/plugins.php');
  await page.waitForFunction((n) => ((window as any).pluginInfos || []).some((d: any) => d && d.repoName === n), NAME);
  const card = page.locator(`[id="row-${NAME}"]`).first();
  await expect(card).toBeAttached();
  await expect(card.locator('.pluginTitle').first()).toContainText(`Plugin ${hostile}`);
  await expect(card.locator('img[src="x"]')).toHaveCount(0);
  // And in its details.
  await page.evaluate((n) => (window as any).ShowPluginDetail(n), NAME);
  await expect(page.locator('#pluginDetailDialog')).toBeVisible();
  await expect(page.locator('#pluginDetailDialog')).toContainText(`Does ${hostile} things`);
  await expect(page.locator('#pluginDetailDialog img[src="x"]')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
});

test("a plugin's details offer Reinstall, which reinstalls it", async ({ page }) => {
  // Feature: 02e2a3244 ("add per-plugin Reinstall").
  const repo = newRepo('fpp-tests-act-reinst');
  repo.init();
  clonePlugin(repo);
  // Something that is not the plugin's: a reinstall leaves only what it installs.
  sh(`echo stray > ${repo.dir}/fpp-tests-stray.txt`);
  await openPluginsPage(page, [repo.name]);
  await openDetail(page, repo.name);
  await expect(page.locator('#pluginDetailDialog button', { hasText: 'Reinstall' })).toBeVisible();
  await page.locator('#pluginDetailDialog button', { hasText: 'Reinstall' }).click();
  await page.locator('#reinstallPluginDialog button', { hasText: 'Reinstall' }).click();
  await expect.poll(() => exists(`${repo.dir}/fpp-tests-stray.txt`), { timeout: 120_000 }).toBe(false);
  await expect.poll(() => repo.installed(), { timeout: 120_000 }).toBe(true);
  expect(repo.installedHead()).toBe(repo.head());
});

test('Reinstall All reinstalls every installed plugin', async ({ page, request }) => {
  // Feature: aa9393637 ("Add reinstall all option in advanced UI").
  test.setTimeout(240_000);
  const all = [newRepo('fpp-tests-act-all-a'), newRepo('fpp-tests-act-all-b')];
  for (const repo of all) {
    repo.init();
    const r = await installPlugin(request, repo.info());
    expect(r.Status, JSON.stringify(r)).toBe('OK');
    sh(`echo stray > ${repo.dir}/fpp-tests-stray.txt`);
  }
  expect((await request.put('/api/settings/uiLevel', { data: '1' })).ok()).toBe(true);
  await openPluginsPage(page, all.map((r) => r.name));
  await expect(page.locator('#reinstallAllBtn')).toBeVisible({ timeout: 30_000 });
  await page.locator('#reinstallAllBtn').click();
  await page.locator('#reinstallAllPluginsDialog button', { hasText: 'Reinstall All' }).click();
  for (const repo of all) {
    await expect.poll(() => exists(`${repo.dir}/fpp-tests-stray.txt`), { message: repo.name, timeout: 180_000 }).toBe(false);
    await expect.poll(() => repo.installed(), { message: repo.name, timeout: 180_000 }).toBe(true);
  }
});
