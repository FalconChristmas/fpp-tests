import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { MEDIA, setSettingInFile, snapshotSettings } from './settings-file';

// The Network page's Update Interface and an interface's advanced settings
// (route metric, IP forwarding, DHCP server): what the page shows of a saved
// interface, what its save sends, and what the real API then writes.  The
// page's read of eth0 is answered here and its POST captured; that body is
// then saved by the real API under a scratch interface name seeded with the
// same settings, so the player's own eth0 is untouched.  Also the DHCP /
// Static switch keeping a typed address, and the WEP key field.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const SCRATCH = 'fpptestsadv';
const CONF = `${MEDIA}/config/interface.${SCRATCH}`;
const LEASES = `${MEDIA}/config/leases.${SCRATCH}`;
const SAVED = { PROTO: 'static', ADDRESS: '192.168.60.1', NETMASK: '255.255.255.0',
  ROUTEMETRIC: '50', IPFORWARDING: '2', DHCPSERVER: '1', DHCPOFFSET: '20', DHCPPOOLSIZE: '30' };
const SAVED_FILE = 'INTERFACE="fpptestsadv"\nPROTO="static"\nADDRESS="192.168.60.1"\nNETMASK="255.255.255.0"\n' +
  'DHCPSERVER=1\nDHCPOFFSET=20\nDHCPPOOLSIZE=30\nROUTEMETRIC=50\nIPFORWARDING=2\n';

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => {
  inPlayer('rm', '-f', CONF, LEASES);
  restoreSettings();
});

async function openEth0(page: Page, saved: Record<string, unknown>) {
  const posted: any[] = [];
  await page.route((u) => u.pathname.endsWith('/api/network/interface/eth0'), (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { INTERFACE: 'eth0', ...saved } });
    if (route.request().method() === 'POST') {
      posted.push(JSON.parse(route.request().postData()!));
      return route.fulfill({ json: { status: 'OK' } });
    }
    return route.fallback();
  });
  // A DNS server is set, so a static save does not stop to ask for one.
  await page.route((u) => u.pathname.endsWith('/api/network/dns'), (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { DNS1: '192.0.2.53', DNS2: '' } }) : route.fallback());
  await page.route((u) => /\/api\/network\/interface\/[^/]+\/apply$/.test(u.pathname), (r) => r.fulfill({ json: { status: 'OK', output: [] } }));
  page.on('dialog', (d) => d.accept());
  await page.goto('/networkconfig.php');
  await page.click('#eth0-tab');
  await expect(page.locator('#eth_ip_eth0')).toBeAttached({ timeout: 15_000 });
  return posted;
}

async function update(page: Page, posted: any[]) {
  const n = posted.length;
  await page.click('input[value="Update Interface"]');
  await expect.poll(() => posted.length, { message: 'nothing was saved' }).toBe(n + 1);
  return posted[n];
}

// What the real API writes for that body, over a file holding SAVED.
async function writtenFor(request: APIRequestContext, body: any) {
  inPlayer('sh', '-c', `printf '%s' '${SAVED_FILE}' > ${CONF}`);
  const r = await request.post(`/api/network/interface/${SCRATCH}`, { data: { ...body, INTERFACE: SCRATCH } });
  expect((await r.json()).status).toBe('OK');
  return inPlayer('cat', CONF);
}

test('at Advanced level the saved route metric, forwarding and DHCP server are shown, sent and written back', async ({ page, request }) => {
  setSettingInFile('uiLevel', '1');
  const posted = await openEth0(page, SAVED);
  await expect(page.locator('#eth_route_metric_eth0')).toHaveValue('50');
  await expect(page.locator('#ipForwarding_eth0')).toHaveValue('2');
  await expect(page.locator('#dhcpServer_eth0')).toBeChecked();
  await expect(page.locator('#dhcpOffset_eth0')).toHaveValue('20');
  await expect(page.locator('#dhcpPoolSize_eth0')).toHaveValue('30');

  const body = await update(page, posted);
  expect(body).toMatchObject({ PROTO: 'static', ADDRESS: '192.168.60.1', NETMASK: '255.255.255.0',
    ROUTEMETRIC: '50', IPFORWARDING: '2', DHCPSERVER: true, DHCPOFFSET: '20', DHCPPOOLSIZE: '30' });
  expect(await writtenFor(request, body)).toBe(SAVED_FILE);

  // Changed on the page, the new values are what is sent.
  await page.fill('#eth_route_metric_eth0', '5');
  await page.selectOption('#ipForwarding_eth0', '0');
  const changed = await update(page, posted);
  expect(changed).toMatchObject({ ROUTEMETRIC: '5', IPFORWARDING: '0' });
  const conf = await writtenFor(request, changed);
  expect(conf).toMatch(/^ROUTEMETRIC=5$/m);
  expect(conf).toMatch(/^IPFORWARDING=0$/m);

  // An interface saved with none of them shows the defaults.
  await openEth0(page, { PROTO: 'dhcp' });
  await expect(page.locator('#eth_route_metric_eth0')).toHaveValue('0');
  await expect(page.locator('#ipForwarding_eth0')).toHaveValue('0');
  await expect(page.locator('#dhcpServer_eth0')).not.toBeChecked();
});

test('an Update at Basic level keeps the route metric, forwarding and DHCP server it cannot show', async ({ page, request }) => {
  setSettingInFile('uiLevel', '0');
  const posted = await openEth0(page, SAVED);
  await expect(page.locator('#eth_route_metric_eth0')).toHaveCount(0);
  // Only the address is changed.
  await page.fill('#eth_ip_eth0', '192.168.60.2');
  const body = await update(page, posted);
  const conf = await writtenFor(request, body);
  expect(conf).toMatch(/^ADDRESS="192\.168\.60\.2"$/m);
  expect(conf, 'the DHCP server was turned off').toMatch(/^DHCPSERVER=1$/m);
  expect(conf).toMatch(/^ROUTEMETRIC=50$/m);
  expect(conf).toMatch(/^IPFORWARDING=2$/m);
});

test('switching to DHCP at Basic level turns the DHCP server off and keeps the route metric', async ({ page, request }) => {
  // fppinit reads DHCPSERVER before PROTO: kept on a DHCP interface it wrote a
  // proxy rule for an empty address, and came back on a later switch to Static.
  setSettingInFile('uiLevel', '0');
  const posted = await openEth0(page, SAVED);
  await page.click('#eth_dhcp_eth0');
  const body = await update(page, posted);
  expect(body.PROTO).toBe('dhcp');
  const conf = await writtenFor(request, body);
  expect(conf).toMatch(/^PROTO=dhcp$/m);
  expect(conf).not.toMatch(/^DHCPSERVER=1$/m);
  expect(conf).toMatch(/^ROUTEMETRIC=50$/m);
  expect(conf).toMatch(/^IPFORWARDING=2$/m);
});

test('switching to DHCP and back to Static brings back the address typed', async ({ page }) => {
  setSettingInFile('uiLevel', '1');
  const posted = await openEth0(page, { PROTO: 'static', ADDRESS: '192.168.61.1', NETMASK: '255.255.255.0' });
  await expect(page.locator('#eth_ip_eth0')).toHaveValue('192.168.61.1');
  await page.fill('#eth_ip_eth0', '192.168.61.9');
  await page.click('#eth_dhcp_eth0');
  await expect(page.locator('#ipAddressRow_eth0')).toBeHidden();
  await expect(page.locator('#eth_ip_eth0')).toHaveValue('');
  // A DHCP save sends no address.
  const dhcp = await update(page, posted);
  expect(dhcp.PROTO).toBe('dhcp');
  expect(dhcp).not.toHaveProperty('ADDRESS');

  const again = await openEth0(page, { PROTO: 'static', ADDRESS: '192.168.61.1', NETMASK: '255.255.255.0' });
  await page.fill('#eth_ip_eth0', '192.168.61.9');
  await page.click('#eth_dhcp_eth0');
  await page.click('#eth_static_eth0');
  await expect(page.locator('#ipAddressRow_eth0')).toBeVisible();
  await expect(page.locator('#eth_ip_eth0')).toHaveValue('192.168.61.9');
  await expect(page.locator('#eth_netmask_eth0')).toHaveValue('255.255.255.0');
  // Static also turns DNS to Manual, so there is somewhere to type one.
  await expect(page.locator('#dns_manual')).toBeChecked();
  const back = await update(page, again);
  expect(back).toMatchObject({ PROTO: 'static', ADDRESS: '192.168.61.9', NETMASK: '255.255.255.0' });
});

test('a WEP key the page asks for is stored with the network', async ({ request }) => {
  // The page shows a WEP Key field for a WEP network (selectWifiNetworkForInterface)
  // and a saved KEY (loadInterfaceConfiguration), and its save sends KEY.
  test.fail(true, 'the save never writes KEY and nothing reads one, so a WEP network cannot be joined from the page (FUTURE.md)');
  const wl = 'wlfpptestswep';
  try {
    const r = await request.post(`/api/network/interface/${wl}`, { data: { INTERFACE: wl, PROTO: 'dhcp',
      SSID: 'fpp-tests-wep', PSK: '', KEY: '0123456789', HIDDEN: false, WPA3: false,
      BACKUPSSID: '', BACKUPPSK: '', BACKUPHIDDEN: false, BACKUPWPA3: false } });
    expect((await r.json()).status).toBe('OK');
    expect(inPlayer('cat', `${MEDIA}/config/interface.${wl}`)).toContain('0123456789');
  } finally {
    inPlayer('rm', '-f', `${MEDIA}/config/interface.${wl}`, `${MEDIA}/config/leases.${wl}`);
  }
});
