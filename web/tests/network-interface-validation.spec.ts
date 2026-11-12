import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// What Update Interface on the Network page refuses to save, and what it
// saves with a warning: a static address that is not one, a netmask that is
// not one, the subnet's own network or broadcast address, a DHCP server pool
// that is not a number or does not fit, and static leases that are not
// addresses.  A refused form sends nothing to the player; saving a wrong
// address is how a player is lost from its network.  The player's interface
// and DNS configs are the test's, and nothing is saved to it.

test.skip(!container, 'sets the UI level in the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

type Saved = Record<string, unknown>;
async function open(page: Page, level: string, eth0: Saved = { INTERFACE: 'eth0', PROTO: 'dhcp' },
  o: { answer?: { status?: number; json?: unknown }; dns?: string } = {}) {
  setSettingInFile('uiLevel', level);
  const posts: Saved[] = [];
  await page.route((u) => u.pathname.endsWith('/api/network/dns'), (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { DNS1: o.dns ?? '192.0.2.53', DNS2: '' } }) : route.fulfill({ json: { status: 'OK' } }));
  await page.route((u) => u.pathname.endsWith('/api/network/gateway'), (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { GATEWAY: '' } }) : route.fulfill({ json: { status: 'OK' } }));
  await page.route((u) => u.pathname.endsWith('/api/network/interface/eth0'), (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: eth0 });
    posts.push(JSON.parse(route.request().postData() ?? '{}'));
    return route.fulfill(o.answer ?? { json: { status: 'OK' } });
  });
  await page.goto('/networkconfig.php');
  await page.click('#eth0-tab');
  await expect(page.locator('#eth_static_eth0')).toBeVisible({ timeout: 15_000 });
  return posts;
}
async function staticAddress(page: Page, ip: string, mask: string) {
  await page.locator('#eth_static_eth0').check();
  await page.fill('#eth_ip_eth0', ip);
  // Leaving the address fills in an empty netmask for a private network;
  // let it, before the netmask is typed.
  await page.locator('#eth_ip_eth0').blur();
  await page.fill('#eth_netmask_eth0', mask);
  await expect(page.locator('#eth_netmask_eth0')).toHaveValue(mask);
}
// The messages of the save before can lie over the button; its click is sent
// to it all the same.
const save = (page: Page) => page.locator('input[value="Update Interface"]:visible').dispatchEvent('click');
const growl = (page: Page, text: string | RegExp) => page.locator('.jGrowl-notification', { hasText: text });

async function refused(page: Page, posts: Saved[], message: string) {
  const before = posts.length;
  await save(page);
  await expect(page.locator('#ipWarning')).toHaveText(message);
  await expect(growl(page, message).last()).toBeVisible();
  // Nothing follows a refusal: no read of the interface, no save.
  await page.waitForTimeout(300);
  expect(posts.length, `"${message}" was saved all the same`).toBe(before);
}
async function savedAs(page: Page, posts: Saved[]) {
  await save(page);
  await expect(growl(page, 'eth0 network interface configuration saved').last()).toBeVisible();
  return posts[posts.length - 1];
}

test('a static address or netmask that is not one is refused, at every level', async ({ page }) => {
  for (const level of ['0', '3']) {
    const posts = await open(page, level);
    for (const ip of ['', '192.168.50', '192.168.50.256', 'ten.0.0.1']) {
      await staticAddress(page, ip, '255.255.255.0');
      await refused(page, posts, 'Invalid IP Address. Expect format like 192.168.0.101');
    }
    for (const mask of ['', '255.255.0.255', '255.255.255', '24']) {
      await staticAddress(page, '192.168.50.10', mask);
      await refused(page, posts, 'Invalid Netmask. Expect a contiguous mask like 255.255.255.0');
    }
    // The control: with both right, it is sent.
    await staticAddress(page, '192.168.50.10', '255.255.255.0');
    expect(await savedAs(page, posts)).toMatchObject({ INTERFACE: 'eth0', PROTO: 'static', ADDRESS: '192.168.50.10', NETMASK: '255.255.255.0' });
    expect(posts).toHaveLength(1);
  }
});

test.describe("the subnet's own network or broadcast address", () => {
  test('is refused at the Basic level', async ({ page }) => {
    const posts = await open(page, '0');
    for (const ip of ['192.168.50.0', '192.168.50.255']) {
      await staticAddress(page, ip, '255.255.255.0');
      await refused(page, posts, `IP ${ip} is the network or broadcast address for this subnet. Choose a host address.`);
    }
    // In a wider subnet .255 is a host like any other.
    await staticAddress(page, '192.168.50.255', '255.255.254.0');
    expect(await savedAs(page, posts)).toMatchObject({ ADDRESS: '192.168.50.255', NETMASK: '255.255.254.0' });
  });

  test('is saved with a warning at the Advanced level', async ({ page }) => {
    const posts = await open(page, '1');
    await staticAddress(page, '192.168.50.255', '255.255.255.0');
    expect(await savedAs(page, posts)).toMatchObject({ PROTO: 'static', ADDRESS: '192.168.50.255' });
    await expect(growl(page, 'Warning: IP 192.168.50.255 is the network or broadcast address for this subnet.')).toBeVisible();
  });
});

test.describe('the DHCP server pool (Advanced)', () => {
  const SERVER = { INTERFACE: 'eth0', PROTO: 'static', ADDRESS: '192.168.50.1', NETMASK: '255.255.255.0', DHCPSERVER: '1', DHCPOFFSET: '100', DHCPPOOLSIZE: '50' };

  test('has to have an offset and a size that are positive numbers', async ({ page }) => {
    const posts = await open(page, '1', SERVER);
    await expect(page.locator('#dhcpServer_eth0')).toBeChecked();
    for (const offset of ['', '0', '-4']) {
      await page.fill('#dhcpOffset_eth0', offset);
      await refused(page, posts, 'DHCP Pool Offset must be a positive number.');
    }
    await page.fill('#dhcpOffset_eth0', '100');
    for (const size of ['', '0', '-1']) {
      await page.fill('#dhcpPoolSize_eth0', size);
      await refused(page, posts, 'DHCP Pool Size must be a positive number.');
    }
  });

  test('that runs past the end of the subnet is saved with a warning', async ({ page }) => {
    const posts = await open(page, '1', SERVER);
    await page.fill('#dhcpOffset_eth0', '200');
    await page.fill('#dhcpPoolSize_eth0', '100');
    expect(await savedAs(page, posts)).toMatchObject({ DHCPSERVER: true, DHCPOFFSET: '200', DHCPPOOLSIZE: '100' });
    await expect(growl(page, 'Warning: DHCP pool (offset 200 + size 100) exceeds the 254 usable host(s) in this subnet.')).toBeVisible();
  });

  test('that ends on the last host fits, with no warning', async ({ page }) => {
    const posts = await open(page, '1', SERVER);
    await page.fill('#dhcpOffset_eth0', '155');
    await page.fill('#dhcpPoolSize_eth0', '100');
    expect(await savedAs(page, posts)).toMatchObject({ DHCPOFFSET: '155', DHCPPOOLSIZE: '100' });
    await expect(growl(page, 'exceeds')).toHaveCount(0);
  });

  test("a static lease that is not an address is refused, and one outside the subnet is saved with a warning", async ({ page }) => {
    const posts = await open(page, '1', { ...SERVER, StaticLeases: { '192.168.50.20': 'aa:bb:cc:00:00:01' },
      CurrentLeases: { '192.168.50.130': 'aa:bb:cc:00:00:02' } });
    const rows = page.locator('#staticLeasesTable_eth0 > tbody > tr');
    await expect(rows).toHaveCount(2);
    await rows.nth(0).locator('.static_ip').fill('192.168.50.x');
    await refused(page, posts, "Static lease IP '192.168.50.x' is not a valid IP address.");
    // A row that is not ticked is not a lease, whatever is typed in it.
    await rows.nth(0).locator('.static_ip').fill('192.168.50.20');
    await rows.nth(1).locator('.static_ip').fill('nonsense');
    expect((await savedAs(page, posts)).Leases).toEqual({ '192.168.50.20': 'aa:bb:cc:00:00:01' });

    // Ticked, and in another subnet: a warning, and it is sent.
    await rows.nth(1).locator('.static_ip').fill('10.0.0.9');
    await rows.nth(1).locator('.static_enabled').check();
    expect((await savedAs(page, posts)).Leases).toEqual({ '192.168.50.20': 'aa:bb:cc:00:00:01', '10.0.0.9': 'aa:bb:cc:00:00:02' });
    await expect(growl(page, 'Warning: Static lease IP 10.0.0.9 is not within the interface subnet.')).toBeVisible();
  });
});

test.describe('once the form is good', () => {
  test('a static address saved with no DNS server set is followed by a reminder to set one', async ({ page }) => {
    const posts = await open(page, '0', undefined, { dns: '' });
    await staticAddress(page, '192.168.50.10', '255.255.255.0');
    await save(page);
    const dialog = page.locator('.modal.show');
    await expect(dialog.locator('.modal-title')).toHaveText('Check DNS');
    await expect(dialog).toContainText("Don't forget to set a DNS IP address");
    await expect(dialog).toContainText('your FPP will have no Internet Access');
    expect(posts).toHaveLength(1);
  });

  test("the player's refusal is shown with its reason", async ({ page }) => {
    await open(page, '0', undefined, { answer: { json: { status: 'ERROR: bad address' } } });
    await staticAddress(page, '192.168.50.10', '255.255.255.0');
    await save(page);
    const dialog = page.locator('.modal.show');
    await expect(dialog.locator('.modal-title')).toHaveText('Save Network Config');
    await expect(dialog).toContainText('Save Failed: ERROR: bad address');
    await expect(growl(page, 'configuration saved')).toHaveCount(0);
  });

  test('a save that gets no answer is an error, not a silent success', async ({ page }) => {
    await open(page, '0', undefined, { answer: { status: 500, json: {} } });
    await staticAddress(page, '192.168.50.10', '255.255.255.0');
    await save(page);
    const dialog = page.locator('.modal.show');
    await expect(dialog.locator('.modal-title')).toHaveText('Save Network Config');
    await expect(dialog).toContainText('Save Failed');
    await expect(growl(page, 'configuration saved')).toHaveCount(0);
  });

  test('an interface saved as it already is, is not sent again', async ({ page }) => {
    const posts = await open(page, '0', { INTERFACE: 'eth0', PROTO: 'static', ADDRESS: '192.168.50.10', NETMASK: '255.255.255.0' });
    await expect(page.locator('#eth_ip_eth0')).toHaveValue('192.168.50.10');
    const reread = page.waitForResponse((r) => r.url().endsWith('/api/network/interface/eth0') && r.request().method() === 'GET');
    await save(page);
    await reread;
    await page.waitForTimeout(500);
    expect(posts).toEqual([]);
  });
});
