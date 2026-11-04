import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// A static address in 192.168.6.x, 7.x or 8.x clashes with the subnets the
// tethering (USB and wifi) uses, so the Network page warns about it.  The
// page's reads of the interface config are answered here; nothing is saved.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('uiLevel', '1');
});
test.afterEach(() => restoreSettings());

test('a static address on a tethering subnet is warned about, another is not', async ({ page }) => {
  // Regression: cad757de6.
  await page.route((u) => u.pathname.endsWith('/api/network/dns'), (route) =>
    route.fulfill({ json: { DNS1: '', DNS2: '' } }));
  await page.route((u) => u.pathname.endsWith('/api/network/interface/eth0'), (route) =>
    route.fulfill({ json: route.request().method() === 'GET' ? { INTERFACE: 'eth0', PROTO: 'dhcp' } : { status: 'OK' } }));
  await page.goto('/networkconfig.php');
  await page.click('#eth0-tab');
  const isStatic = page.locator('#eth_static_eth0');
  await expect(isStatic).toBeVisible({ timeout: 15_000 });
  await isStatic.click();
  const ip = page.locator('#eth_ip_eth0');
  for (const tether of ['192.168.6.20', '192.168.7.50', '192.168.8.9']) {
    await ip.fill(tether);
    await ip.blur();
    await expect(page.locator('#ipWarning'), tether).toContainText('192.168.6.x, 192.168.7.x, and 192.168.8.x');
  }
  await ip.fill('192.168.1.50');
  await ip.blur();
  await expect(page.locator('#ipWarning')).toBeEmpty();
});
