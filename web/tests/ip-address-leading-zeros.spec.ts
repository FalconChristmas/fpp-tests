import { test, expect } from './fixtures';

// validateIPaddress() (fpp.js) checks the IPv4 addresses typed into the UI.
// An octet with a leading zero is refused: the system's resolvers (and
// fppd's inet_addr()) read "010" as octal, 8, so "192.168.1.010" would mean
// 192.168.1.8.  Shown here on the Network page's DNS servers, whose saved
// config is answered by the test, so nothing is saved to the player.

test('an IP address with a leading zero in an octet is refused', async ({ page }) => {
  // Regression: b170bbca9 (#2011).  Each octet's pattern allowed an
  // optional leading 0 or 1 before one or two digits, so "01.02.03.04" and
  // "192.168.001.010" passed as valid addresses.
  await page.route((u) => u.pathname.endsWith('/api/network/dns'), (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { DNS1: '192.0.2.53', DNS2: '' } }) : route.abort());
  await page.goto('/networkconfig.php');
  await page.click('#tab-global-network-tab');
  const dns1 = page.locator('#dns1');
  await expect(dns1).toHaveValue('192.0.2.53', { timeout: 15_000 });
  const warning = page.locator('#dns_warning, #dnsWarning').filter({ visible: true });

  for (const bad of ['01.02.03.04', '192.168.001.010', '192.168.1.00']) {
    await dns1.fill(bad);
    await dns1.dispatchEvent('change');
    await expect(warning.first(), bad).toHaveText('Invalid DNS Server #1');
    await expect(dns1, bad).toHaveCSS('border-top-color', 'rgb(255, 0, 0)');
  }
  // The control: the same addresses without the zeros, and 0 itself.
  for (const good of ['1.2.3.4', '192.168.1.10', '192.168.1.0', '10.0.0.255']) {
    await dns1.fill(good);
    await dns1.dispatchEvent('change');
    await expect(warning, good).toHaveCount(0);
    await expect(dns1, good).not.toHaveCSS('border-top-color', 'rgb(255, 0, 0)');
  }
});
