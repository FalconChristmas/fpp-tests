import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';
import { routePluginsPage } from './plugins-page';

// A plugin loaded from a pasted URL is scrolled into view: it is listed under
// the page's header and category chips, below the box the URL was typed in,
// and on a short window that is past the fold.
//
// Regression: 2613874c2 ("Add auto-scroll to newly loaded plugin").  The
// plugin was added to the list and the page stayed where it was, so the card
// the person had just asked for was off the screen.

test.skip(!container, 'serves the plugin list to the run-web.sh container');

const CORS = { 'Access-Control-Allow-Origin': '*' };
const LOADED = 'zz-fpp-tests-loaded';

const entry = (name: string, m: string) => ({
  name, repoName: name, author: 'fpp-tests', description: 'fpp-tests plugin', homeURL: '',
  srcURL: `https://github.com/fpp-tests/${name}.git`,
  versions: [{ minFPPVersion: `${m}.0`, maxFPPVersion: '0', branch: 'master', sha: '' }],
});

let uiLevel = '0';
test.beforeEach(async ({ request }) => {
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
});
test.afterEach(async ({ request }) => {
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
});

async function major(request: APIRequestContext): Promise<string> {
  return (await (await request.get('/api/system/info')).json()).Version.split('.')[0];
}

test('a plugin loaded from a pasted URL is scrolled into view', async ({ page, request, baseURL }) => {
  const m = await major(request);
  const others = Array.from({ length: 24 }, (_, i) => entry(`fpp-tests-scroll-${String(i).padStart(2, '0')}`, m));
  // Developer level: the box loads a pasted pluginInfo.json address by itself.
  expect((await request.put('/api/settings/uiLevel', { data: '3' })).ok()).toBe(true);
  await page.setViewportSize({ width: 1280, height: 380 });
  await routePluginsPage(page, baseURL!, others);
  const url = `https://raw.githubusercontent.com/fpp-tests/${LOADED}/master/pluginInfo.json`;
  await page.route(url, (route) => route.fulfill({ headers: CORS, json: entry(LOADED, m) }));

  await page.goto('/plugins.php');
  await page.waitForFunction((n) => ((window as any).pluginInfos || []).filter((d: any) => d && /^fpp-tests-scroll-/.test(d.repoName)).length >= n, others.length);
  await expect(page.locator('#pluginInput')).toBeVisible();
  expect(await page.evaluate(() => scrollY)).toBe(0);

  await page.locator('#pluginInput').fill(url);
  const card = page.locator(`[id="row-${LOADED}"]`);
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  // The loaded plugin is listed alone, under the page's header and the
  // categories: below the fold of a short window until the page scrolls to it.
  await expect(card).toBeInViewport({ ratio: 1, timeout: 10_000 });
  expect(await page.evaluate(() => scrollY), 'the page did not scroll').toBeGreaterThan(0);
});
