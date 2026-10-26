import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { PluginRepo, PLUGINS, pluginInfo, restoreState, saveState, exists } from './plugin-repo';
import { routePluginsPage } from './plugins-page';

// The Plugins page's card for a plugin that is installed, and the page's
// top tabs (Available / Installed / Updates) across a reload.  The plugin is
// installed from a repository inside the player (plugin-repo.ts) and the
// plugin list is served by the test (plugins-page.ts).

test.skip(!container, 'builds a plugin repository inside the run-web.sh container');

const NAME = 'fpp-tests-card-uninstall';

const listed = { name: 'fpp-tests Card Uninstall', repoName: NAME, author: 'fpp-tests', description: 'fpp-tests plugin', homeURL: '',
  srcURL: `https://github.com/fpp-tests/${NAME}.git`, versions: [{ minFPPVersion: '0', maxFPPVersion: '0', branch: 'master', sha: '' }] };

async function openPage(page: Page, baseURL: string) {
  await routePluginsPage(page, baseURL, [listed]);
  await page.goto('/plugins.php');
  await page.waitForFunction((n) => ((window as any).installedPlugins || []).includes(n), NAME);
}

test('an installed plugin\'s card uninstalls it, and the open tab survives a reload', async ({ page, request, baseURL }) => {
  // Regression: 4eaa6aa3d.  An installed plugin's card had Update at most,
  // and no Uninstall; and the top tab was forgotten on every load, so the
  // reload after an upgrade from the Updates tab landed back on Available.
  test.setTimeout(240_000);
  saveState();
  const repo = new PluginRepo(NAME);
  try {
    repo.commit({ 'pluginInfo.json': pluginInfo(NAME, { name: listed.name }) }, 'v1');
    const r = await request.post('/api/plugin', { data: repo.body(), timeout: 120_000 });
    expect((await r.json()).Status).toBe('OK');

    await openPage(page, baseURL!);
    await page.locator('#pluginTopTabs .nav-link[data-top-tab="updates"]').click();
    await expect(page.locator('#pluginTopTabs .nav-link[data-top-tab="updates"]')).toHaveClass(/active/);
    await page.reload();
    await page.waitForFunction((n) => ((window as any).installedPlugins || []).includes(n), NAME);
    // Soft: the Uninstall half below is reported either way.
    await expect.soft(page.locator('#pluginTopTabs .nav-link[data-top-tab="updates"]')).toHaveClass(/active/);

    await page.locator('#pluginTopTabs .nav-link[data-top-tab="installed"]').click();
    const card = page.locator('.card', { hasText: listed.name }).filter({ has: page.locator('button', { hasText: 'Uninstall' }) }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.locator('button', { hasText: 'Uninstall' }).click();
    const dialog = page.locator('#uninstallPluginDialog');
    // The plugin is named by its name, not its repository.
    await expect(dialog).toContainText(`uninstall the ${listed.name} plugin`);
    await dialog.getByRole('button', { name: 'Uninstall' }).click();
    // The receiving end: it is gone from the player.
    await expect.poll(() => exists(`${PLUGINS}/${NAME}`), { timeout: 120_000 }).toBe(false);
  } finally {
    repo.remove();
    restoreState([NAME]);
  }
});
