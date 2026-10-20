import { test, expect } from './fixtures';

// For each DHCP lease the Proxies page asks the leased device for
// /api/system/info (through /proxy/) and shows the HostName it answers.  It
// put that answer into the row with .html(), so any DHCP client of a tethered
// or AP-mode player could run script for whoever opened Proxies; fpp 6900cc21e
// had escaped the static host and description columns but not this one.
// Regression: 25e280731 ("fix(security): show a DHCP client's host name on
// Proxies as text").
//
// The lease and the device's answer are both supplied by the test.

const LEASE = '192.0.2.11';
const HOSTNAME = '<img src=x onerror=window.__fppTestsDhcpHost=1>';

test('a DHCP client\'s host name is shown as text', async ({ page }) => {
  await page.route('**/api/proxies', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: [{ host: LEASE, description: '', dhcp: true, pending: false }] })
    : route.continue());
  await page.route(`**/proxy/${LEASE}/api/system/info`, (route) => route.fulfill({ json: { HostName: HOSTNAME } }));
  await page.goto('/proxies.php');
  const cell = page.locator(`#dhcpDesc_${LEASE.replace(/\./g, '_')}`);
  await expect(cell).toContainText('DHCP (FPP Instance:', { timeout: 15_000 });
  await expect(cell.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__fppTestsDhcpHost)).toBeUndefined();
});
