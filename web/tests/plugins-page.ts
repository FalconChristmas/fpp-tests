import type { Page } from '@playwright/test';

// The Plugins page in a browser, with nothing it asks of the outside world
// leaving the machine: the plugin list, its categories and each listed
// plugin's pluginInfo.json (which the page fetches from
// raw.githubusercontent.com itself) are served by the test, and so are the
// endpoints whose server side would go to GitHub or fppstats (popularity,
// GitHub stats, icons).  Any other request off the player is refused.

export const LIST_URL = 'https://raw.githubusercontent.com/FalconChristmas/fpp-data/master/pluginList.json';
export const CATEGORIES_URL = 'https://raw.githubusercontent.com/FalconChristmas/fpp-data/master/pluginCategories.json';
const CORS = { 'Access-Control-Allow-Origin': '*' };

// A listed plugin's pluginInfo.json URL (on the host the page's CSP allows).
export function infoURL(name: string): string {
  return `https://raw.githubusercontent.com/fpp-tests/${name}/master/pluginInfo.json`;
}

export async function routePluginsPage(page: Page, base: string, listed: Record<string, unknown>[],
  popularity: Record<string, number> = {}) {
  const host = new URL(base).host;
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    return u.host === host ? route.continue() : route.abort();
  });
  await page.route(LIST_URL, (route) => route.fulfill({
    headers: CORS, json: { pluginList: listed.map((p) => [p.repoName, infoURL(p.repoName as string)]) },
  }));
  await page.route(CATEGORIES_URL, (route) => route.fulfill({ headers: CORS, json: { categories: [] } }));
  for (const p of listed) {
    await page.route(infoURL(p.repoName as string), (route) => route.fulfill({ headers: CORS, json: p }));
  }
  await page.route('**/api/plugin/popularity*', (route) => route.fulfill({ json: { counts: popularity } }));
  await page.route('**/api/plugin/githubStats*', (route) => route.fulfill({ json: { repos: {} } }));
  await page.route(/\/api\/plugin\/[^/]+\/icon/, (route) => route.fulfill({ status: 404, body: '' }));
}
