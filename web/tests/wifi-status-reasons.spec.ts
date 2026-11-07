import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { WLAN, addWlan, calls, clearCalls, iwLink, realSyntaxErrors, removeStubs, removeWlan, stub } from './wifi-stubs';

// The reason the WiFi status (GET /api/network/wifi/status/<if>) gives for an
// adapter not being connected -- what the Network page shows under the
// adapter -- from what wpa_supplicant says (wpa_cli status), the last scan
// (iw scan dump: is the saved network in range?) and wpa_supplicant's log
// (journalctl: a wrong key, a timeout).  The tools are wifi-stubs.ts's
// stand-ins.  (wifi-adapter-api.spec.ts: not in range, and connected;
// wifi-hotspot-status.spec.ts: the hotspot's reasons.)

test.skip(!container, 'adds an interface and stand-in tools inside the run-web.sh container');

const CONFIG = `/home/fpp/media/config/interface.${WLAN}`;
const HOME = 'fpp-tests-home';

test.beforeEach(() => {
  addWlan();
  inPlayer('sh', '-c', `printf 'INTERFACE="${WLAN}"\\nPROTO="dhcp"\\nSSID="${HOME}"\\nPSK="secret12"\\n' > ${CONFIG}`);
});
test.afterEach(() => {
  removeStubs();
  removeWlan();
  inPlayer('rm', '-f', CONFIG);
});

const neighbour = 'BSS 02:aa:bb:cc:dd:01(on wlan9)\n\tfreq: 2437\n\tsignal: -50.00 dBm\n\tSSID: fpp-tests-neighbour\n';
const home = `BSS 02:aa:bb:cc:dd:02(on wlan9)\n\tfreq: 2437\n\tsignal: -45.00 dBm\n\tSSID: ${HOME}\n`;

// wpa_supplicant in state $state; the last scan saw $seen; its log says $log.
function station(o: { state: string; ip?: string; seen: string[]; log?: string; link?: string }) {
  stub('wpa_cli', [[`-i ${WLAN} status`,
    `bssid=02:aa:bb:cc:dd:02\nssid=${o.state === 'COMPLETED' ? HOME : ''}\nwpa_state=${o.state}\n` +
    (o.ip !== undefined ? `ip_address=${o.ip}\n` : '') + 'address=02:00:00:00:00:09\n']]);
  stub('iw', [
    [`dev ${WLAN} scan dump*`, o.seen.join('')],
    [`dev ${WLAN} link*`, o.link ?? 'Not connected.\n'],
  ]);
  stub('journalctl', [[`-u wpa_supplicant@${WLAN} *`, o.log ?? '-- No entries --\n']]);
  clearCalls();
}

async function status(request: APIRequestContext) {
  const r = await (await request.get(`/api/network/wifi/status/${WLAN}`)).json();
  expect(realSyntaxErrors(), calls().join('\n')).toEqual([]);
  return r;
}

test('associated but with no address yet: waiting for DHCP', async ({ request }) => {
  station({ state: 'COMPLETED', ip: '0.0.0.0', seen: [home], link: iwLink(HOME, -47) });
  const r = await status(request);
  expect(r).toMatchObject({ status: 'OK', connected: false, wpa_state: 'COMPLETED', ssid: HOME, ip: '0.0.0.0',
    signal: -47, ssidVisible: true, configuredSSID: HOME });
  expect(r.reason).toBe('Associated - waiting for an IP address (DHCP).');
});

test('a failed four-way handshake, or the log saying so, is a wrong password', async ({ request }) => {
  station({ state: '4WAY_HANDSHAKE', seen: [home] });
  expect((await status(request)).reason).toBe('Authentication failed - the WiFi password is likely incorrect.');

  for (const log of [
    `Nov 08 10:00:01 fpp wpa_supplicant[612]: ${WLAN}: CTRL-EVENT-SSID-TEMP-DISABLED id=0 ssid="${HOME}" auth_failures=1 duration=10 reason=WRONG_KEY\n`,
    `Nov 08 10:00:01 fpp wpa_supplicant[612]: ${WLAN}: WPA: 4-Way Handshake failed - pre-shared key may be incorrect\n`,
  ]) {
    station({ state: 'SCANNING', seen: [home], log });
    const r = await status(request);
    expect(r.reason, log).toBe('Authentication failed - the WiFi password is likely incorrect.');
    // Read from wpa_supplicant's own unit for this adapter.
    expect(calls()).toContain(`journalctl -u wpa_supplicant@${WLAN} -n 40 --no-pager`);
  }
});

test('a network in range that times out did not answer, and one that just fails says to check the password', async ({ request }) => {
  station({ state: 'SCANNING', seen: [neighbour, home],
    log: `Nov 08 10:00:01 fpp wpa_supplicant[612]: ${WLAN}: Authentication with 02:aa:bb:cc:dd:02 timed out.\n` });
  let r = await status(request);
  expect(r.ssidVisible).toBe(true);
  expect(r.reason).toBe('The access point did not respond (out of range or busy).');

  station({ state: 'DISCONNECTED', seen: [home] });
  r = await status(request);
  expect(r.reason).toBe(`Found '${HOME}' but could not connect - check the password and security type.`);
});

test('a timeout counts only when the log says it was authentication or association that timed out', async ({ request }) => {
  station({ state: 'DISCONNECTED', seen: [home], log: `Nov 08 10:00:01 fpp dhcpcd[700]: ${WLAN}: DHCP lease timed out\n` });
  expect((await status(request)).reason).toBe(`Found '${HOME}' but could not connect - check the password and security type.`);
});

test('with no network saved there is nothing to look for', async ({ request }) => {
  inPlayer('sh', '-c', `printf 'INTERFACE="${WLAN}"\\nPROTO="dhcp"\\n' > ${CONFIG}`);
  station({ state: 'INACTIVE', seen: [home] });
  const r = await status(request);
  expect(r).toMatchObject({ configuredSSID: '', ssidVisible: null, connected: false });
  expect(r.reason).toBe('No wireless network is configured.');
  // The last scan isn't read when there is no network to look for in it.
  expect(calls().filter((c) => c.includes('scan dump'))).toEqual([]);
});

test('the status of an interface the player does not have is refused', async ({ request }) => {
  expect(await (await request.get('/api/network/wifi/status/wlan77')).json()).toEqual({ status: 'Invalid Interface' });
});

// Known bug (~/FUTURE.md, fpp 49f2b29a0): with a network saved, ssidVisible
// is always true or false, so the reasons after "Found ... but could not
// connect" -- WiFi inactive, the connection service not running, and
// "Connecting to ..." while wpa_supplicant is still at it -- can never be
// given.  A Pi in the middle of joining its network says to check the
// password.  Expected to fail until the order is fixed.
test('a connection still in progress says it is connecting, not to check the password', async ({ request }) => {
  test.fail();
  station({ state: 'ASSOCIATING', seen: [home] });
  expect((await status(request)).reason).toBe(`Connecting to '${HOME}'... (ASSOCIATING)`);
});

test('no answer from wpa_supplicant at all says its service is not running', async ({ request }) => {
  test.fail();
  stub('wpa_cli');
  stub('iw', [[`dev ${WLAN} scan dump*`, home], [`dev ${WLAN} link*`, 'Not connected.\n']]);
  stub('journalctl');
  const r = await status(request);
  expect(r.wpa_state).toBe('');
  expect(r.reason).toContain('The WiFi connection service is not running for this interface.');
});
