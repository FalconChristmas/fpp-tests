import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { WLAN, WLAN_ADDR, addWlan, iwLink, removeStubs, removeWlan, stub } from './wifi-stubs';
import { putFile, setSettingInFile, snapshotSettings } from './settings-file';

// The WiFi status the network API gives for an adapter that is not a plain
// station: one whose saved config no longer names a network, and one running
// FPP's own hotspot (hostapd) for tethering -- and the network page acting on
// it. The adapter is the dummy "wlan9" of wifi-stubs.ts with stand-in wireless
// tools. hostapd is "running" when its config names wlan9 and systemctl (a
// stand-in that passes anything else to the real one) says it is active.

test.skip(!container, 'adds an interface and stand-in tools inside the run-web.sh container');

const CONFIG = `/home/fpp/media/config/interface.${WLAN}`;
const HOSTAPD = '/etc/hostapd/hostapd.conf';
const SYSTEMCTL = '/usr/local/bin/systemctl';

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  addWlan();
});

test.afterEach(() => {
  removeStubs();
  removeWlan();
  inPlayer('sh', '-c', `rm -f ${CONFIG} ${SYSTEMCTL}; if [ -e ${HOSTAPD}.fpp-tests ]; then mv ${HOSTAPD}.fpp-tests ${HOSTAPD}; else rm -f ${HOSTAPD}; fi`);
  restoreSettings();
});

// hostapd up on wlan9: its config names the interface and systemctl says active.
function hotspotUp() {
  inPlayer('sh', '-c', `mkdir -p /etc/hostapd; if [ -e ${HOSTAPD} ] && [ ! -e ${HOSTAPD}.fpp-tests ]; then mv ${HOSTAPD} ${HOSTAPD}.fpp-tests; fi`);
  putFile(HOSTAPD, `interface=${WLAN}\nssid=FPP\n`);
  putFile(SYSTEMCTL, '#!/bin/sh\n# fpp-tests stand-in\nif [ "$*" = "is-active hostapd" ]; then echo active; exit 0; fi\n' +
    'exec /usr/bin/systemctl "$@"\n');
  inPlayer('chmod', '755', SYSTEMCTL);
  // A station that is associated nowhere: wpa_supplicant is idle while hostapd owns the radio.
  stub('wpa_cli', [[`-i ${WLAN} status`, 'wpa_state=INTERFACE_DISABLED\n']]);
  stub('iw', [[`dev ${WLAN} link*`, 'Not connected.\n']]);
}

async function status(request: any) {
  return (await (await request.get(`/api/network/wifi/status/${WLAN}`)).json());
}

test('a live connection is reported though the saved config no longer names it', async ({ request }) => {
  // Regression: 6f3ade9f7. With the SSID cleared from the saved config but
  // the adapter still connected, the status said "No wireless network is
  // configured." -- the config was checked before the live connection.
  putFile(CONFIG, `INTERFACE="${WLAN}"\nPROTO="dhcp"\n`);
  stub('wpa_cli', [[`-i ${WLAN} status`, `wpa_state=COMPLETED\nssid=fpp-tests-home\nip_address=${WLAN_ADDR}\n`]]);
  stub('iw', [[`dev ${WLAN} link*`, iwLink('fpp-tests-home')]]);
  const r = await status(request);
  expect(r.connected, JSON.stringify(r)).toBe(true);
  expect(r.configuredSSID).toBe('');
  expect(r.reason).toBe(`Connected to fpp-tests-home (${WLAN_ADDR}) (saved config has no network configured - ` +
    'this will disconnect on the next network restart)');
});

test('the hotspot status names the tethering mode that put it up', async ({ request }) => {
  // Regression: 3a215fa1c (the status half). The hotspot was reported the
  // same way whatever the tethering setting, always as "once networking is
  // restarted (or the device is rebooted)", including when tethering was on
  // and a restart would bring it straight back.
  hotspotUp();
  putFile(CONFIG, `INTERFACE="${WLAN}"\nPROTO="dhcp"\nSSID="fpp-tests-home"\nPSK="secret12"\n`);
  setSettingInFile('EnableTethering', '1');
  let r = await status(request);
  expect(r.reason, JSON.stringify(r)).toBe('This device is currently broadcasting its own setup hotspot because ' +
    "tethering is enabled. Turn off tethering to have it try connecting to 'fpp-tests-home' instead.");
  setSettingInFile('EnableTethering', '2');
  r = await status(request);
  expect(r.reason).toBe('This device is currently broadcasting its own setup hotspot. Tethering was just set to ' +
    'Disabled, but that only takes effect once networking is restarted.');
  setSettingInFile('EnableTethering', '0');
  r = await status(request);
  expect(r.reason).toBe('This device is currently broadcasting its own setup hotspot. It will try to connect to ' +
    "'fpp-tests-home' the next time networking is restarted (or the device is rebooted).");
});

test('saving network settings while the hotspot is up asks for a reboot, not a network restart', async ({ page, request }) => {
  // Regression: 5e38521ca. The status had no hotspotActive, and a save showed
  // the "Restart Network" banner, whose restart bounces hostapd and drops
  // the tethered client -- most likely the one looking at the page -- in the
  // middle of it. Now the page asks for a reboot instead. The control: the
  // same save with no hotspot shows the banner and leaves the reboot flag.
  await request.put('/api/settings/rebootFlag', { data: '0' });
  setSettingInFile('uiLevel', '1');
  stub('wpa_cli', [[`-i ${WLAN} status`, 'wpa_state=SCANNING\n']]);
  stub('iw', [[`dev ${WLAN} link*`, 'Not connected.\n']]);
  expect((await status(request)).hotspotActive ?? false, 'control: no hotspot').toBe(false);

  // A changed manual DNS server, saved from the Global tab: only a change prompts.
  async function saveDNS(server: string) {
    await page.goto('/networkconfig.php');
    await page.click('#tab-global-network-tab');
    await page.locator('#dns_manual').check();
    await page.locator('#dns1').fill(server);
    await page.locator('input[value="Update DNS"]').click();
  }
  await saveDNS('192.0.2.53');
  await expect(page.locator('#btnConfigNetwork'), 'control: the Restart Network banner').toBeVisible({ timeout: 15_000 });
  expect(String((await (await request.get('/api/settings/rebootFlag')).json()).value)).toBe('0');

  hotspotUp();
  await saveDNS('192.0.2.54');
  await expect.poll(async () => String((await (await request.get('/api/settings/rebootFlag')).json()).value),
    { timeout: 15_000 }).toBe('1');
  await expect(page.locator('#btnConfigNetwork')).toBeHidden();
  expect((await status(request)).hotspotActive).toBe(true);
  await request.put('/api/settings/rebootFlag', { data: '0' });
  await request.post('/api/network/dns', { data: JSON.stringify({ DNS1: '', DNS2: '' }) });
});
