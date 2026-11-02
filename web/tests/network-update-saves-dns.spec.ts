import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// The Network page's Update Interface button saves the DNS servers typed on
// the page along with the interface: a static address is no use without one,
// and a separate "Update DNS" button was easy to miss.  The page's reads and
// writes of the DNS and interface configs are answered here; nothing is
// saved to the player.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('uiLevel', '1');
});
test.afterEach(() => restoreSettings());

test('Update Interface on a static interface saves the DNS servers too', async ({ page }) => {
  // Regression: b21e9b343.  The DNS servers were saved only by their own
  // button, so a static address saved with the DNS rows filled in left the
  // old (empty) DNS in place and the box had no name resolution.
  const dnsPosts: string[] = [];
  const ifacePosts: string[] = [];
  await page.route((u) => u.pathname.endsWith('/api/network/dns'), async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { DNS1: '', DNS2: '' } });
    dnsPosts.push(route.request().postData() ?? '');
    await route.fulfill({ json: { status: 'OK' } });
  });
  await page.route((u) => u.pathname.endsWith('/api/network/interface/eth0'), async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { INTERFACE: 'eth0', PROTO: 'dhcp' } });
    ifacePosts.push(route.request().postData() ?? '');
    await route.fulfill({ json: { status: 'OK' } });
  });
  await page.goto('/networkconfig.php');
  await page.click('#eth0-tab');
  const isStatic = page.locator('#eth_static_eth0');
  await expect(isStatic).toBeVisible({ timeout: 15_000 });
  await isStatic.click();
  await page.fill('#eth_ip_eth0', '192.0.2.10');
  await page.fill('#eth_netmask_eth0', '255.255.255.0');
  await page.click('#tab-global-network-tab');
  await expect(page.locator('#dns_manual')).toBeChecked();
  await page.fill('#dns1', '192.0.2.53');
  await page.click('#interface-settings-tab');
  await page.locator('input[value="Update Interface"]:visible').click();

  await expect.poll(() => ifacePosts.length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(JSON.parse(ifacePosts[0]).PROTO).toBe('static');
  await expect.poll(() => dnsPosts.length, { message: 'the DNS servers were not saved', timeout: 15_000 }).toBeGreaterThan(0);
  expect(JSON.parse(dnsPosts[0]).DNS1).toBe('192.0.2.53');
});
