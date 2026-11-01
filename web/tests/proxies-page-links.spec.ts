import { test, expect } from './fixtures';

// The Proxies page's links to the hosts it proxies: they open in a new tab,
// and are not offered at all where external URLs are hidden.  The page is
// given the lists api/proxies would return.

const MANUAL = '192.0.2.50';
const DHCP = '192.0.2.60';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/proxies', (route) => (route.request().method() === 'GET'
    ? route.fulfill({ json: [
      { host: MANUAL, description: 'fpp-tests manual' },
      { host: DHCP, description: 'DHCP', dhcp: true },
    ] })
    : route.fallback()));
  // The page asks each DHCP client who it is, through its own /proxy.
  await page.route(`**/proxy/${DHCP}/**`, (route) => route.fulfill({ status: 502, body: '' }));
});

test('the links to the proxied hosts open in a new tab', async ({ page }) => {
  // Regression: c9d35e9b8.  Following one replaced the Proxies page, with the
  // edits made to it, by the proxied host's page.
  await page.goto('/proxies.php');
  await expect(page.locator('#DHCPproxyTable tbody tr')).toHaveCount(1, { timeout: 15_000 });
  const saved = page.locator(`#proxyTable a[href="proxy/${MANUAL}"]`);
  await expect(saved).toHaveCount(1);
  await expect(saved).toHaveAttribute('target', '_blank');
  const leased = page.locator(`#DHCPproxyTable a[href="proxy/${DHCP}/"]`);
  await expect(leased).toHaveCount(1);
  await expect(leased).toHaveAttribute('target', '_blank');
});

test('with external URLs hidden, a hand-saved proxy host is not linked', async ({ page }) => {
  // Regression: bd9c4f9f5.  The Proxies page listed a link for every host
  // whether or not the player had been asked to hide external URLs.
  await page.setExtraHTTPHeaders({ 'Hide-External-Links': 'true' });
  await page.goto('/proxies.php');
  await expect(page.locator('#DHCPproxyTable tbody tr')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('#proxyTable tbody tr')).toHaveCount(1);
  await expect(page.locator('#proxyTable a[href^="proxy/"]')).toHaveCount(0);
});

// Regression: 291d39bcc's separate DHCP table drew its link column
// unconditionally (AddProxyForDHCPHost), where the list it replaced hid it, so
// a player asked to hide external URLs still linked its DHCP clients under a
// table whose "Link" heading is gone.
test.describe('the DHCP table', () => {
  test('with external URLs hidden, a DHCP client is not linked', async ({ page }) => {
    await page.setExtraHTTPHeaders({ 'Hide-External-Links': 'true' });
    await page.goto('/proxies.php');
    await expect(page.locator('#DHCPproxyTable tbody tr')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('#DHCPproxyTable a[href^="proxy/"]')).toHaveCount(0);
  });
});
