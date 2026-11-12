import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// The DNS servers on the Network page, which Update Interface saves along
// with the interface: a server that is not an address is refused, a save
// the player does not take is said, and servers that have not changed are
// not written again.  A player with a static address and no working DNS has
// no name resolution, so a save that silently did not happen matters.
// The page's reads and writes of the DNS and interface configs are answered
// here; nothing is saved to the player.

test.skip(!container, 'sets the UI level in the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

async function open(page: Page) {
  setSettingInFile('uiLevel', '1');
  const dnsPosts: Record<string, string>[] = [];
  // What the test may change once the page is up.
  const player = { readFails: false, writeFails: false };
  await page.route((u) => u.pathname.endsWith('/api/network/dns'), (route) => {
    if (route.request().method() === 'GET') {
      return player.readFails ? route.fulfill({ status: 500, body: 'no' }) : route.fulfill({ json: { DNS1: '192.0.2.53', DNS2: '' } });
    }
    dnsPosts.push(JSON.parse(route.request().postData() ?? '{}'));
    return player.writeFails ? route.fulfill({ status: 500, body: 'no' }) : route.fulfill({ json: { status: 'OK' } });
  });
  await page.route((u) => u.pathname.endsWith('/api/network/gateway'), (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { GATEWAY: '' } }) : route.fulfill({ json: { status: 'OK' } }));
  await page.route((u) => u.pathname.endsWith('/api/network/interface/eth0'), (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { INTERFACE: 'eth0', PROTO: 'dhcp' } }) : route.fulfill({ json: { status: 'OK' } }));
  // The restart and reboot flags a save raises are kept off the player.
  await page.route((u) => u.pathname.includes('/api/settings/'), (route) =>
    route.request().method() === 'GET' ? route.fallback() : route.fulfill({ json: { status: 'OK' } }));
  await page.goto('/networkconfig.php');
  await page.click('#eth0-tab');
  await expect(page.locator('#eth_static_eth0')).toBeVisible({ timeout: 15_000 });
  // The saved server makes the DNS manual.
  await expect(page.locator('#dns1')).toHaveValue('192.0.2.53', { timeout: 15_000 });
  await expect(page.locator('#dns_manual')).toBeChecked();
  return { dnsPosts, player };
}
// The DNS servers are on the Global tab; Update Interface is on the interface's.
async function onGlobalTab(page: Page, edit: () => Promise<unknown>) {
  await page.click('#tab-global-network-tab');
  await expect(page.locator('#dns1')).toBeVisible();
  await edit();
  await page.click('#interface-settings-tab');
}
// The messages of the save before can lie over the button; its click is sent
// to it all the same.
const update = (page: Page) => page.locator('input[value="Update Interface"]:visible').dispatchEvent('click');
const notice = (page: Page, text: string) => page.locator('.jGrowl-notification', { hasText: text });
const settle = (page: Page) => page.waitForTimeout(750);

for (const [field, label] of [['dns1', 'Invalid DNS Server #1'], ['dns2', 'Invalid DNS Server #2']] as const) {
  test(`a ${field === 'dns1' ? 'first' : 'second'} DNS server that is not an address is refused, and the servers are not saved`, async ({ page }) => {
    const { dnsPosts } = await open(page);
    await onGlobalTab(page, () => page.fill(`#${field}`, '192.0.2.999'));
    await update(page);
    await expect(notice(page, label)).toBeVisible();
    const dialog = page.locator('#dialogOKPopup');
    await expect(dialog).toContainText('Save Failed');
    await expect(dialog.locator('.modal-title')).toHaveText('Invalid DNS Config');
    await settle(page);
    expect(dnsPosts).toEqual([]);
    expect(await notice(page, 'DNS configuration saved').count()).toBe(0);
  });
}

test('changed DNS servers are saved once, and the page says so (the control)', async ({ page }) => {
  const { dnsPosts } = await open(page);
  await onGlobalTab(page, () => page.fill('#dns2', '192.0.2.54'));
  await update(page);
  await expect(notice(page, 'DNS configuration saved')).toBeVisible();
  expect(dnsPosts).toEqual([{ DNS1: '192.0.2.53', DNS2: '192.0.2.54' }]);
  await expect(page.locator('#dialogOKPopup')).toBeHidden();
});

test('DNS servers that have not changed are not written again', async ({ page }) => {
  const { dnsPosts } = await open(page);
  await update(page);
  await settle(page);
  expect(dnsPosts).toEqual([]);
  expect(await notice(page, 'DNS configuration saved').count()).toBe(0);
  await expect(page.locator('#dns1')).toHaveValue('192.0.2.53');
});

test('a DNS save the player does not take is reported', async ({ page }) => {
  const { dnsPosts, player } = await open(page);
  player.writeFails = true;
  await onGlobalTab(page, () => page.fill('#dns1', '192.0.2.60'));
  await update(page);
  const dialog = page.locator('#dialogOKPopup');
  await expect(dialog).toContainText('Save Failed');
  await expect(dialog.locator('.modal-title')).toHaveText('Save DNS Config');
  expect(dnsPosts).toHaveLength(1);
  expect(await notice(page, 'DNS configuration saved').count()).toBe(0);
  // What was typed is still there to save again.
  await expect(page.locator('#dns1')).toHaveValue('192.0.2.60');
});

test('when the saved DNS servers cannot be read to compare, nothing is written and the failure is reported', async ({ page }) => {
  const { dnsPosts, player } = await open(page);
  player.readFails = true;
  await onGlobalTab(page, () => page.fill('#dns1', '192.0.2.60'));
  await update(page);
  const dialog = page.locator('#dialogOKPopup');
  await expect(dialog).toContainText('Save Failed');
  await expect(dialog.locator('.modal-title')).toHaveText('Save DNS Config');
  await settle(page);
  expect(dnsPosts).toEqual([]);
});

test('switching to DNS from DHCP clears the servers, and that is what is saved', async ({ page }) => {
  const { dnsPosts } = await open(page);
  await onGlobalTab(page, async () => {
    await page.locator('#dns_dhcp').click();
    await expect(page.locator('#dns_manual')).not.toBeChecked();
    await expect(page.locator('#dns1Row')).toBeHidden();
  });
  await update(page);
  await expect.poll(() => dnsPosts).toEqual([{ DNS1: '', DNS2: '' }]);
});

test('Ping with no address typed asks for one, and pings nothing', async ({ page }) => {
  await open(page);
  let pings = 0;
  page.on('request', (r) => {
    if (/ping/i.test(new URL(r.url()).pathname)) pings++;
  });
  // The address and its Ping button are offered for a static interface.
  await page.locator('#eth_static_eth0').check();
  await page.fill('#eth_ip_eth0', '');
  await page.locator('.ping-ip-btn:visible').first().click();
  await expect(notice(page, 'Please enter an IP address to ping')).toBeVisible();
  await settle(page);
  expect(pings).toBe(0);
});
