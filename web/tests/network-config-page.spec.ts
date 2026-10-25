import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { WLAN, addWlan, removeWlan } from './wifi-stubs';
import { MEDIA, setSettingInFile, snapshotSettings } from './settings-file';

// The Network settings page (networkconfig.php) itself: the DNS rows, an
// interface switched to Static, the wifi password's show/hide eye and the
// DHCP server's settings. The page's reads of the DNS and interface configs
// are answered here where a test needs a particular saved state; nothing is
// saved to the player.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('uiLevel', '1');
});
test.afterEach(() => restoreSettings());

// The saved DNS servers, as GET api/network/dns answers, after `delay` ms.
async function savedDNS(page: Page, dns: { DNS1: string; DNS2: string }, delay = 0) {
  await page.route((u) => u.pathname.endsWith('/api/network/dns'), async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (delay) await new Promise((r) => setTimeout(r, delay));
    await route.fulfill({ json: dns });
  });
}

// An interface's saved config, as GET api/network/interface/<name> answers.
async function savedInterface(page: Page, name: string, config: Record<string, unknown>) {
  await page.route((u) => u.pathname.endsWith(`/api/network/interface/${name}`), (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { INTERFACE: name, ...config } }) : route.continue());
}

test('saved manual DNS servers are shown on load, even when they arrive late', async ({ page }) => {
  // Regression: c53dbede8 ("DNS Manual fields not showing on load on slower
  // devices"). The DNS rows were shown by a function local to the page's
  // ready handler, which ran before the saved DNS config had arrived; when
  // it arrived, GetDNSInfo() looked for that function globally, found
  // nothing, and the rows stayed hidden with Manual selected.
  await savedDNS(page, { DNS1: '192.0.2.53', DNS2: '192.0.2.54' }, 1500);
  await page.goto('/networkconfig.php');
  await page.click('#tab-global-network-tab');
  await expect(page.locator('#dns1')).toHaveValue('192.0.2.53', { timeout: 15_000 });
  await expect(page.locator('#dns_manual')).toBeChecked();
  await expect(page.locator('#dns1Row'), 'the saved DNS server is hidden').toBeVisible();
  await expect(page.locator('#dns2Row')).toBeVisible();
  await expect(page.locator('#dns1')).toBeEnabled();
});

test('the DNS server rows are hidden while DNS comes from DHCP', async ({ page }) => {
  // Feature: 1b521ca1d ("hide dns server ip input if dhcp"). The DNS server
  // boxes showed, disabled, whatever the DNS mode; they now show only for
  // Manual.
  await savedDNS(page, { DNS1: '', DNS2: '' });
  await page.goto('/networkconfig.php');
  await page.click('#tab-global-network-tab');
  await expect(page.locator('#dns_dhcp')).toBeChecked({ timeout: 15_000 });
  await expect(page.locator('#dns1Row'), 'the DNS server rows show for DHCP').toBeHidden();
  await expect(page.locator('#dns2Row')).toBeHidden();
  await page.click('#dns_manual');
  await expect(page.locator('#dns1Row')).toBeVisible();
  await expect(page.locator('#dns1')).toBeEnabled();
  await page.click('#dns_dhcp');
  await expect(page.locator('#dns1Row')).toBeHidden();
});

test('switching an interface to Static opens the DNS servers for typing', async ({ page }) => {
  // Regression: 8b3d99779 ("update network settings page"). Choosing Static
  // also selects Manual DNS, but by setting the radio, which fires no click
  // handler: the DNS rows stayed hidden and disabled, with nowhere to type
  // the DNS server a static address needs.
  await savedDNS(page, { DNS1: '', DNS2: '' });
  await savedInterface(page, 'eth0', { PROTO: 'dhcp' });
  await page.goto('/networkconfig.php');
  await page.click('#eth0-tab');
  const isStatic = page.locator('#eth_static_eth0');
  await expect(isStatic).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#dns1Row')).toHaveCSS('display', 'none');
  await isStatic.click();
  await expect(page.locator('#dns_manual')).toBeChecked();
  await page.click('#tab-global-network-tab');
  await expect(page.locator('#dns1Row'), 'the DNS rows stayed hidden').toBeVisible();
  await expect(page.locator('#dns1'), 'the DNS fields stayed disabled').toBeEnabled();
});

test("a wifi interface's password eye shows and hides that interface's password", async ({ page }) => {
  // Regression: 497a73ea8 ("Update HideShow icon handling", #2683). Each
  // interface tab is a copy of a template whose ids get the interface's
  // name appended, but the eye kept calling TogglePasswordHideShow("eth_psk"),
  // the template's id: clicking it did nothing to the tab's own field.
  addWlan();
  try {
    // A network saved with a key, so the PSK row is shown.
    await savedInterface(page, WLAN, { PROTO: 'dhcp', SSID: 'fpp-tests-net', PSKSet: true });
    await page.goto('/networkconfig.php');
    await page.click(`#${WLAN}-tab`);
    const psk = page.locator(`#eth_psk_${WLAN}`);
    await expect(psk).toBeVisible({ timeout: 15_000 });
    await psk.fill('fpp-tests-secret');
    await expect(psk).toHaveAttribute('type', 'password');
    // The eye next to the field, whatever its id.
    const eye = psk.locator('xpath=following-sibling::i[1]');
    await eye.click();
    await expect(psk, 'the eye did not show the password').toHaveAttribute('type', 'text');
    await eye.click();
    await expect(psk).toHaveAttribute('type', 'password');
  } finally {
    removeWlan();
  }
});

test("a DHCP server's static leases and pool defaults load, and saving keeps the leases", async ({ page, request }) => {
  // Regression: efa253d12 ("populate advanced settings with default
  // values"). The DHCP server settings were filled in by a second pass that
  // looked for fields the per-interface template no longer had, and each
  // lease row was built with ids, the same in every row: a saved
  // interface's DHCP server came up unticked, its pool blank and its static
  // leases missing, and an Update then saved it without them. Unset pool
  // values now default to offset 100, size 50.
  const lease = { '192.168.50.10': '02:00:00:00:50:10' };
  await savedDNS(page, { DNS1: '192.0.2.53', DNS2: '' });
  await savedInterface(page, 'eth0', {
    PROTO: 'static', ADDRESS: '192.168.50.1', NETMASK: '255.255.255.0', DHCPSERVER: '1', StaticLeases: lease,
  });
  let posted: any;
  await page.route((u) => u.pathname.endsWith('/api/network/interface/eth0'), (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    // $.post() of a JSON string: the body is the JSON itself.
    posted = JSON.parse(route.request().postData()!);
    return route.fulfill({ json: { status: 'OK' } });
  });
  page.on('dialog', (d) => d.accept());

  await page.goto('/networkconfig.php');
  await page.click('#eth0-tab');
  await expect(page.locator('#dhcpServer_eth0'), 'the DHCP server is not ticked').toBeChecked({ timeout: 15_000 });
  await expect(page.locator('#dhcpOffset_eth0')).toHaveValue('100');
  await expect(page.locator('#dhcpPoolSize_eth0')).toHaveValue('50');
  const row = page.locator('#staticLeasesTable_eth0 > tbody > tr');
  await expect(row, 'the static lease is not listed').toHaveCount(1);
  await expect(row.locator('.static_ip')).toHaveValue('192.168.50.10');
  await expect(row.locator('.static_enabled')).toBeChecked();

  await page.click('input[value="Update Interface"]');
  await expect.poll(() => posted, { message: 'nothing was saved' }).toBeTruthy();
  expect(posted.Leases, 'the save dropped the static lease').toEqual(lease);
  expect(posted.DHCPSERVER).toBe(true);
  expect([posted.DHCPOFFSET, posted.DHCPPOOLSIZE]).toEqual(['100', '50']);

  // The receiving end: the real API takes that save (under a scratch
  // interface name, so the player's own eth0 is untouched) and writes the
  // lease as the systemd-networkd [DHCPServerStaticLease] that fppinit's
  // network setup puts in place.
  const name = 'fpptestslease';
  try {
    const r = await request.post(`/api/network/interface/${name}`, { data: { ...posted, INTERFACE: name } });
    expect((await r.json()).status).toBe('OK');
    const conf = inPlayer('cat', `${MEDIA}/config/interface.${name}`);
    expect(conf).toMatch(/^DHCPSERVER=1$/m);
    expect(conf).toMatch(/^DHCPOFFSET=100$/m);
    expect(conf).toMatch(/^DHCPPOOLSIZE=50$/m);
    expect(inPlayer('cat', `${MEDIA}/config/leases.${name}`))
      .toBe('[DHCPServerStaticLease]\nMACAddress=02:00:00:00:50:10\nAddress=192.168.50.10\n\n');
  } finally {
    inPlayer('rm', '-f', `${MEDIA}/config/interface.${name}`, `${MEDIA}/config/leases.${name}`);
  }
});
