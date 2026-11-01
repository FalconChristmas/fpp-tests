import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import {
  PROXY_CONF, apacheSystemctl, clearProxies, noLeases, offerLeases, openProxies, realSystemctl, startController, stopController,
} from './proxy-controller';

// The Proxies page (www/proxies.php): the hosts saved by hand, the DHCP
// clients of this player listed apart from them, and saving.  The DHCP
// client is a real controller next to the player (proxy-controller.ts), and
// the page reaches it through the player's own /proxy.

test.skip(!container, 'puts a controller next to the run-web.sh container');

const MANUAL = '192.0.2.50';
let ctl = '';
test.beforeAll(() => {
  ctl = startController();
});
test.afterAll(() => {
  stopController();
  noLeases();
  realSystemctl();
  clearProxies();
});
test.beforeEach(() => {
  noLeases();
  clearProxies();
  apacheSystemctl();
});

test('a DHCP client is listed in a table of its own, named by what it answers', async ({ page, request }) => {
  // Regression: 9a170622f ("fix #2261"): the page appended the leases that
  // 1cc724483 returned to "#dchpProxyTable", which did not exist, so none
  // showed.  291d39bcc ("redesign of proxies page to split manually added
  // from dhcp") gave them their own table, out of the saved list.  9db5d8b40
  // ("try to find hostname for fpp dhcp clients in proxy UI") asks each
  // client's /api/system/info through /proxy and shows the FPP's host name.
  // Also f568aaea0 ("Show dhcp leases on the proxies page"): the leases the
  // DHCP server has offered are listed, from networkctl.
  expect((await request.post('/api/proxies', { data: [{ host: MANUAL, description: 'fpp-tests manual' }] })).ok()).toBe(true);
  offerLeases([ctl]);
  await openProxies(page);
  const dhcpRows = page.locator('#DHCPproxyTable tbody tr');
  await expect(dhcpRows).toHaveCount(1, { timeout: 15_000 });
  await expect(dhcpRows.locator(`a[href="proxy/${ctl}/"]`)).toHaveCount(1);
  await expect(page.locator(`#dhcpDesc_${ctl.replace(/\./g, '_')}`)).toHaveText('DHCP (FPP Instance: fpp-tests-dhcp-host)');
  // The hand-made list holds only the hand-made host, so Save doesn't fold
  // the lease into it.
  await expect(page.locator('#proxyTable .proxyRow')).toHaveCount(1);
  await expect(page.locator('#proxyTable .proxyRow .ipaddress')).toHaveValue(MANUAL);
  await expect(page.locator('#proxyTable tbody tr')).toHaveCount(1);
});

test('Save shows it has changes to save until they are saved, and saving none deletes them all', async ({ page }) => {
  // Regression: c0c144628 ("Fix proxies to ensure migration, deletion and
  // save needed alert").  Nothing showed that a row added or removed was not
  // saved yet; and removing the last row and saving GOT the list and changed
  // nothing (no DELETE existed), so the last proxy could never be removed.
  await openProxies(page);
  await expect(page.locator('#btnSave')).toBeVisible();
  const alert = page.locator('#btnSave .save-alert-icon');
  await expect(alert).toHaveCount(0);
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(alert).toHaveCount(1);
  await page.locator('#ipRow0').fill(ctl);
  const posted = page.waitForRequest((r) => r.url().endsWith('/api/proxies') && r.method() === 'POST');
  let reloaded = page.waitForEvent('load');
  await page.locator('#btnSave').click();
  expect((await posted).postDataJSON()).toEqual([{ host: ctl, description: '' }]);
  // The page reloads once saved, and lists what was saved.
  await reloaded;
  await expect(page.locator('#proxyTable .proxyRow .ipaddress')).toHaveValue(ctl, { timeout: 15_000 });
  await expect(alert).toHaveCount(0);
  expect(inPlayer('cat', PROXY_CONF)).toContain(`^${ctl}/(.*)$`);

  await page.locator('#proxyTable .proxyRow td').first().click();
  await page.locator('#btnDelete').click();
  await expect(alert).toHaveCount(1);
  const deleted = page.waitForResponse((r) => r.url().endsWith('/api/proxies') && r.request().method() === 'DELETE');
  await page.locator('#btnSave').click();
  expect((await deleted).status()).toBe(200);
  await expect.poll(() => inPlayer('cat', PROXY_CONF)).toBe('');
  reloaded = page.waitForEvent('load');
  await page.reload();
  await reloaded;
  await expect(page.locator('#btnSave')).toBeVisible();
  await expect.poll(async () => (await page.request.get('/api/proxies')).json()).toEqual([]);
  await expect(page.locator('#proxyTable tbody tr')).toHaveCount(0);
});

test('a page that lost its scripts loading is loaded again before it is used', async ({ page }) => {
  // The nightly saw the Proxies page "load" with fpp.js dropped
  // (net::ERR_NETWORK_CHANGED), after which Save did nothing. openProxies()
  // loads it again until the page has its scripts.
  let dropped = 0;
  await page.route('**/js/fpp.js*', (route) => (dropped++ === 0 ? route.abort('internetdisconnected') : route.continue()));
  await openProxies(page);
  expect(dropped).toBeGreaterThan(1);
  expect(await page.evaluate(() => typeof (window as any).SetProxies)).toBe('function');
});
