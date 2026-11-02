import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Saving the DNS servers on the Network page (networkconfig.php).  The page's
// reads and writes of the DNS config are answered here; nothing is saved to
// the player.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('uiLevel', '1');
});
test.afterEach(() => restoreSettings());

test('saving new DNS servers asks for a network restart, not a reboot', async ({ page }) => {
  // Regression: 4991ae242.  The DNS save raised the reboot flag, so the
  // whole player was told to reboot over two nameserver addresses that only
  // need the network restarted.
  const dnsPosts: string[] = [];
  const rebootWrites: string[] = [];
  await page.route((u) => u.pathname.endsWith('/api/network/dns'), async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { DNS1: '', DNS2: '' } });
    dnsPosts.push(route.request().postData() ?? '');
    await route.fulfill({ json: { status: 'OK' } });
  });
  await page.route((u) => u.pathname.endsWith('/api/settings/rebootFlag'), async (route) => {
    if (route.request().method() === 'PUT') rebootWrites.push(route.request().postData() ?? '');
    await route.continue();
  });
  await page.goto('/networkconfig.php');
  await page.click('#tab-global-network-tab');
  await expect(page.locator('#dns_dhcp')).toBeChecked({ timeout: 15_000 });
  await page.click('#dns_manual');
  await page.fill('#dns1', '192.0.2.53');
  await page.locator('input[value="Update DNS"]:visible').click();

  await expect.poll(() => dnsPosts.length, { message: 'the DNS servers were saved', timeout: 15_000 }).toBe(1);
  expect(JSON.parse(dnsPosts[0]).DNS1).toBe('192.0.2.53');
  await expect(page.locator('#btnConfigNetwork'), 'the network restart is offered').toBeVisible();
  expect(rebootWrites, 'the reboot flag was raised').toEqual([]);
});
