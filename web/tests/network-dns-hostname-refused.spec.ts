import { test, expect } from './fixtures';

// The DNS server fields on the Network page take IPv4 addresses.  A name
// is not one, and the warning for a bad entry shows on both tabs that
// carry the DNS fields (the Global tab's and the interface tab's).

test('a host name in a DNS server field is refused, with the warning on both tabs', async ({ page }) => {
  // Regression: 5a1247251 (#1130).  validateIPaddress() let anything with a
  // letter in it through ("is it a hostname?" matched any text), so
  // "dns.example.com" or "abc" saved as a DNS server; and the warning text
  // went to the one tab's element only.
  await page.route((u) => u.pathname.endsWith('/api/network/dns'), (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { DNS1: '192.0.2.53', DNS2: '192.0.2.54' } }) : route.abort());
  await page.goto('/networkconfig.php');
  await page.click('#tab-global-network-tab');
  const dns1 = page.locator('#dns1');
  const dns2 = page.locator('#dns2');
  await expect(dns1).toHaveValue('192.0.2.53', { timeout: 15_000 });
  await expect(dns2).toHaveValue('192.0.2.54');
  const change = async (field: typeof dns1, value: string) => {
    await field.fill(value);
    await field.dispatchEvent('change');
  };

  for (const name of ['dns.example.com', 'abc', '8.8.8.8.example']) {
    await change(dns1, name);
    await expect(page.locator('#dns_warning'), name).toHaveText('Invalid DNS Server #1');
    await expect(page.locator('#dnsWarning'), name).toHaveText('Invalid DNS Server #1');
    await expect(dns1, name).toHaveCSS('border-top-color', 'rgb(255, 0, 0)');
  }
  await change(dns1, '192.0.2.53');
  await expect(page.locator('#dns_warning')).toBeHidden();
  await expect(page.locator('#dnsWarning')).toBeHidden();

  // The second server is checked the same way.
  await change(dns2, 'dns2.example.com');
  await expect(page.locator('#dns_warning')).toHaveText('Invalid DNS Server #2');
  await expect(page.locator('#dnsWarning')).toHaveText('Invalid DNS Server #2');
  await expect(dns2).toHaveCSS('border-top-color', 'rgb(255, 0, 0)');
  await change(dns2, '192.0.2.54');
  await expect(page.locator('#dns_warning')).toBeHidden();
});
