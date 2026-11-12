import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// The Network page's global gateway: what Update Gateway refuses, what it
// only warns about, and what it sends.  A gateway outside every subnet the
// player has leaves it unable to reach anything beyond its own network, so at
// the Basic level it is refused; an Advanced user (policy routing) and a
// player with a DHCP interface up (whose subnet cannot be known) are warned
// and let through.  The interfaces and the saved gateway are the test's:
// nothing is saved to the player.

test.skip(!container, 'sets the UI level in the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

type Iface = { ifname: string; operstate?: string; config?: Record<string, string>; addr_info?: { family: string; local: string; prefixlen: number }[] };
const STATIC: Iface = { ifname: 'eth0', operstate: 'UP', config: { INTERFACE: 'eth0', PROTO: 'static', ADDRESS: '192.168.50.10', NETMASK: '255.255.255.0' },
  addr_info: [{ family: 'inet', local: '192.168.50.10', prefixlen: 24 }] };
const DHCP_UP: Iface = { ifname: 'eth1', operstate: 'UP', config: { INTERFACE: 'eth1', PROTO: 'dhcp' },
  addr_info: [{ family: 'inet', local: '10.9.8.7', prefixlen: 16 }] };

async function open(page: Page, o: { level: string; interfaces: Iface[] | 'fails'; saved?: string; saveFails?: boolean }) {
  setSettingInFile('uiLevel', o.level);
  const posts: string[] = [];
  await page.route((u) => u.pathname.endsWith('/api/network/interface'), (route) =>
    o.interfaces === 'fails' ? route.fulfill({ status: 500, body: 'no' }) : route.fulfill({ json: o.interfaces }));
  // The page's own eth0 tab reads that interface by itself, and what its form
  // shows counts for more than the list: it has to say the same.
  await page.route((u) => u.pathname.endsWith('/api/network/interface/eth0'), (route) => {
    const eth0 = o.interfaces === 'fails' ? undefined : o.interfaces.find((i) => i.ifname === 'eth0');
    return route.request().method() === 'GET' ? route.fulfill({ json: eth0?.config ?? { INTERFACE: 'eth0', PROTO: 'dhcp' } }) : route.fulfill({ json: { status: 'OK' } });
  });
  await page.route((u) => u.pathname.endsWith('/api/network/gateway'), (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { GATEWAY: o.saved ?? '' } });
    posts.push(route.request().postData() ?? '');
    return o.saveFails ? route.fulfill({ status: 500, body: 'no' }) : route.fulfill({ json: { status: 'OK' } });
  });
  await page.goto('/networkconfig.php');
  await page.click('#tab-global-network-tab');
  await expect(page.locator('#global_gateway')).toBeVisible();
  return posts;
}
async function update(page: Page, gateway: string) {
  await expect(page.locator('#global_gateway')).toBeEnabled();
  await page.fill('#global_gateway', gateway);
  await page.locator("input[value='Update Gateway']").click();
}
const growl = (page: Page, text: string | RegExp) => page.locator('.jGrowl-notification', { hasText: text });
// The save, when there is one, follows the validation's own read of the
// interfaces; a refusal is known by its message.
const saved = async (page: Page, posts: string[]) => {
  await expect(growl(page, 'Global gateway configuration saved')).toBeVisible();
  return posts.map((p) => JSON.parse(p));
};

test('a gateway inside a static interface\'s subnet is saved, and the page offers to apply it', async ({ page }) => {
  const posts = await open(page, { level: '0', interfaces: [STATIC] });
  await update(page, '192.168.50.1');
  expect(await saved(page, posts)).toEqual([{ GATEWAY: '192.168.50.1' }]);
  await expect(page.locator('.jGrowl-notification.danger, .jGrowl-notification.warning')).toHaveCount(0);
});

test('a gateway that is not an address is refused at every level, and the field goes back to the saved one', async ({ page }) => {
  for (const level of ['0', '3']) {
    const posts = await open(page, { level, interfaces: [STATIC], saved: '192.168.50.1' });
    for (const bad of ['192.168.50', '192.168.50.999', 'gateway']) {
      await update(page, bad);
      await expect(growl(page, 'Invalid Gateway. Expect format like 192.168.0.1').last(), `${bad} at level ${level}`).toBeVisible();
      await expect(page.locator('#global_gateway')).toHaveValue('192.168.50.1');
      await page.locator('.jGrowl-notification .jGrowl-close').first().click().catch(() => {});
      await expect(growl(page, 'Invalid Gateway')).toHaveCount(0, { timeout: 10_000 });
    }
    expect(posts).toEqual([]);
  }
});

test.describe('a gateway outside every subnet the player has', () => {
  test('is refused at the Basic level', async ({ page }) => {
    const posts = await open(page, { level: '0', interfaces: [STATIC], saved: '192.168.50.1' });
    await update(page, '172.16.0.1');
    await expect(growl(page, "Gateway 172.16.0.1 is not within any interface's subnet and will be unreachable.")).toBeVisible();
    await expect(page.locator('#global_gateway')).toHaveValue('192.168.50.1');
    expect(posts).toEqual([]);
  });

  test('is saved with a warning at the Advanced level', async ({ page }) => {
    const posts = await open(page, { level: '1', interfaces: [STATIC] });
    await update(page, '172.16.0.1');
    await expect(growl(page, 'Warning: Gateway 172.16.0.1 is not within any interface subnet and may be unreachable.')).toBeVisible();
    expect(await saved(page, posts)).toEqual([{ GATEWAY: '172.16.0.1' }]);
  });

  test('is saved with a warning at the Basic level when a DHCP interface is up, which may reach it', async ({ page }) => {
    const posts = await open(page, { level: '0', interfaces: [STATIC, { ...DHCP_UP, addr_info: [] }] });
    await update(page, '172.16.0.1');
    await expect(growl(page, 'is not within a known static subnet. If it is reached via a DHCP interface this is likely fine.')).toBeVisible();
    expect(await saved(page, posts)).toEqual([{ GATEWAY: '172.16.0.1' }]);
  });
});

test("a gateway in the subnet a DHCP interface was given is in a known subnet, and the DHCP route is warned of", async ({ page }) => {
  const posts = await open(page, { level: '0', interfaces: [STATIC, DHCP_UP] });
  await update(page, '10.9.0.1');
  await expect(growl(page, 'Warning: A DHCP interface is active and may provide its own default route. Manual gateway may conflict.')).toBeVisible();
  expect(await saved(page, posts)).toEqual([{ GATEWAY: '10.9.0.1' }]);
});

test('the gateway is cleared by saving it empty, with nothing to check', async ({ page }) => {
  const posts = await open(page, { level: '0', interfaces: [STATIC], saved: '192.168.50.1' });
  await expect(page.locator('#global_gateway')).toHaveValue('192.168.50.1');
  await update(page, '');
  expect(await saved(page, posts)).toEqual([{ GATEWAY: '' }]);
});

test('an unchanged gateway is not saved again', async ({ page }) => {
  const posts = await open(page, { level: '0', interfaces: [STATIC], saved: '192.168.50.1' });
  await expect(page.locator('#global_gateway')).toHaveValue('192.168.50.1');
  const reread = page.waitForResponse((r) => r.url().endsWith('/api/network/gateway') && r.request().method() === 'GET');
  await page.locator("input[value='Update Gateway']").click();
  await reread;
  await page.waitForTimeout(500);
  expect(posts).toEqual([]);
  await expect(growl(page, 'Global gateway configuration saved')).toHaveCount(0);
});

test('with every interface on DHCP the gateway cannot be set: DHCP gives the route', async ({ page }) => {
  await open(page, { level: '0', interfaces: [{ ...DHCP_UP, ifname: 'eth0', config: { INTERFACE: 'eth0', PROTO: 'dhcp' } }], saved: '192.168.50.1' });
  const field = page.locator('#global_gateway');
  await expect(field).toBeDisabled();
  await expect(field).toHaveValue('');
  await expect(field).toHaveAttribute('placeholder', 'Disabled - DHCP interfaces provide routing');
  await expect(page.locator("input[value='Update Gateway']")).toBeDisabled();
  await expect(page.locator('#globalGatewayRow .description-text')).toContainText('Gateway disabled because all interfaces use DHCP');
});

test('a save the player refuses is an error dialog', async ({ page }) => {
  const posts = await open(page, { level: '0', interfaces: [STATIC], saveFails: true });
  await update(page, '192.168.50.1');
  const dialog = page.locator('.modal.show');
  await expect(dialog.locator('.modal-title')).toHaveText('Save Global Gateway');
  await expect(dialog).toContainText('Save Failed');
  expect(posts).toHaveLength(1);
  await expect(growl(page, 'Global gateway configuration saved')).toHaveCount(0);
});
