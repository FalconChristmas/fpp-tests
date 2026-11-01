import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import {
  PROXY_CONF, apacheSystemctl, clearProxies, noLeases, openProxies, realSystemctl,
} from './proxy-controller';

// A proxy's description: saved with its host through the proxies API, kept
// in the proxy file as a "# D:" line above the host's rewrite rules, listed
// back by the API, and shown in the Proxies page's Description column.

test.skip(!container, 'writes the proxy file inside the run-web.sh container');

const HOST = '192.0.2.50';
const DESC = 'fpp-tests Mega Tree';

test.afterAll(() => {
  noLeases();
  realSystemctl();
  clearProxies();
});
test.beforeEach(() => {
  noLeases();
  clearProxies();
  apacheSystemctl();
});

test('a proxy keeps its description in the API, the proxy file and the page', async ({ page, request }) => {
  // Regression: 04741805f ("Updated Proxy API to support Descriptions,
  // switch proxy UI to use API").  The API took and returned bare host
  // names; the page kept the descriptions to itself.
  const r = await request.post('/api/proxies', { data: [{ host: HOST, description: DESC }] });
  expect(r.ok()).toBe(true);
  expect(inPlayer('cat', PROXY_CONF)).toContain(`# D:${DESC}\nRewriteRule ^${HOST}$`);
  const list = await (await request.get('/api/proxies')).json();
  expect(list).toMatchObject([{ host: HOST, description: DESC }]);

  await openProxies(page);
  await expect(page.locator('#proxyTable .proxyRow .ipaddress')).toHaveValue(HOST, { timeout: 15_000 });
  await expect(page.locator('#proxyTable .proxyRow .description')).toHaveValue(DESC);
});
