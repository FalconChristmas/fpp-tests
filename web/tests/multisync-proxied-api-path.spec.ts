import { test, expect } from './fixtures';

// The MultiSync page of another player seen through this one's /proxy/<address>/:
// the list of proxies it asks for must be asked under that prefix too.  The
// proxy is stood in for by routes that serve /proxy/peer/<path> from this
// player's own <path>.

const PREFIX = '/proxy/fpptests-peer/';

test('the proxies list is asked for under the /proxy/ path the page is served from', async ({ page, baseURL }) => {
  // Regression: 568b1632f.  The page asked for "/api/proxies", which through
  // /proxy/<address>/ is the proxying player's own list, not the proxied
  // player's, so every link on the page was drawn as if it were the other
  // player's.
  await page.request.put('/api/settings/initialSetup-02', { data: '"1"', headers: { 'Content-Type': 'application/json' } });
  const asked: string[] = [];
  await page.route(`**${PREFIX}**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/api/proxies')) asked.push(url.pathname);
    const res = await route.fetch({ url: new URL(url.pathname.slice(PREFIX.length - 1) + url.search, baseURL).toString() });
    await route.fulfill({ response: res });
  });
  // Anything of this player's own that the page asks for outside the prefix.
  await page.route('**/api/proxies', (route) => { asked.push(new URL(route.request().url()).pathname); return route.fulfill({ json: [] }); });
  await page.goto(`${PREFIX}multisync.php`);
  await expect(page.locator('#fppSystems tr.systemRow').first()).toBeAttached({ timeout: 15_000 });
  await expect.poll(() => asked.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(asked.every((p) => p === `${PREFIX}api/proxies`), asked.join(' ')).toBe(true);
});
