import { test, expect } from './fixtures';

// A player asked to hide external URLs (a kiosk browser, or a proxy that sends
// "Hide-External-Links: true") offers no links to other hosts from the
// Proxies page: the Link column is empty, with no header either.  Without the
// request each proxied host links to proxy/<host>.  The page's proxy list is
// stood in for, so it needs no Apache rules.

const STATIC = '192.168.0.31';
const DHCP = '192.168.0.32';

async function openProxies(page) {
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [
    { host: STATIC, description: 'static host', dhcp: false },
    { host: DHCP, description: 'dhcp host', dhcp: true },
  ] }));
  // The DHCP row looks its host up through the proxy to name it.
  await page.route('**/proxy/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto('/proxies.php');
  await expect(page.locator('#proxyTable tbody tr')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('#DHCPproxyTable tbody tr')).toHaveCount(1);
}

test('with a proxy listed, the Proxies page links to its host', async ({ page }) => {
  // The control for the next test: there are links to take away.
  await openProxies(page);
  await expect(page.locator('#proxyTable tbody a')).toHaveAttribute('href', `proxy/${STATIC}`);
  await expect(page.locator('#DHCPproxyTable tbody a')).toHaveAttribute('href', `proxy/${DHCP}/`);
  await expect(page.getByRole('columnheader', { name: 'Link' }).first()).toBeAttached();
  await expect(page.getByRole('columnheader', { name: 'Link' }).nth(1)).toBeAttached();
});

test('with external URLs hidden, the Proxies page has no links to the proxied hosts', async ({ page }) => {
  // Regression: 68a2c58a7.  The Link column was drawn for every player; a
  // kiosk that must not follow other hosts still showed a link to each.
  await page.setExtraHTTPHeaders({ 'Hide-External-Links': 'true' });
  await openProxies(page);
  // The rows themselves (host, description) are still listed.
  await expect(page.locator('#proxyTable tbody tr input.ipaddress')).toHaveValue(STATIC);
  await expect(page.locator('#DHCPproxyTable tbody tr')).toContainText(DHCP);
  await expect(page.locator('#proxyTable tbody a, #DHCPproxyTable tbody a')).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Link' })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Description' }).first()).toBeAttached();
  // Typing another host in doesn't bring a link back.
  await page.locator('#proxyTable tbody tr input.ipaddress').fill('192.168.0.40');
  await expect(page.locator('#proxyTable tbody tr td').last()).toHaveText('');
});
