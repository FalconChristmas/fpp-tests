import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { WLAN, WLAN_ADDR, WLAN_ADDR6, addWlan, calls, clearCalls, iwLink, realSyntaxErrors, removeStubs, removeWlan, stub, wrap } from './wifi-stubs';

// The network API's view of a wireless adapter: a dummy "wlan9" in the
// player, with stand-in wireless tools answering for it (wifi-stubs.ts).
// The stand-ins answer whatever they are asked, so every test also checks
// that each call they got is one the real tool accepts (realSyntaxErrors()).
// The real tools can't run here (no nl80211 in the container's kernel).

test.skip(!container, 'adds an interface and stand-in tools inside the run-web.sh container');

const CONFIG = `/home/fpp/media/config/interface.${WLAN}`;
const SCAN_CACHE = `/tmp/fpp_wifi_scan_${WLAN}.json`;

test.beforeEach(() => {
  addWlan();
});

test('the real-tool syntax check refuses what the real tools refuse', () => {
  // The control for realSyntaxErrors(): iw's low-priority scan flag is
  // "lowpri"; iwlist has no "scanx".
  expect(realSyntaxErrors(['iw dev wlan9 scan lowpri', 'iwlist wlan9 scan', 'wpa_cli -i wlan9 status'])).toEqual([]);
  expect(realSyntaxErrors(['iw dev wlan9 scan low-priority', 'iwlist wlan9 scanx', 'iw wlan9 link'])).toHaveLength(3);
});

test.afterEach(() => {
  removeStubs();
  removeWlan();
  inPlayer('rm', '-f', CONFIG, SCAN_CACHE);
});

test('a scan that iw cannot do falls back to iwlist', async ({ request }) => {
  // Regression: 55b745026.  Some out-of-tree USB drivers have no working
  // nl80211 scan: `iw dev <if> scan` comes back empty with networks in range,
  // and the scan answered "no networks" though `iwlist <if> scan` lists them.
  stub('iw');
  stub('iwlist', [[`${WLAN} scan`, `${WLAN}     Scan completed :
          Cell 01 - Address: 02:AA:BB:CC:DD:01
                    Channel:6
                    Frequency:2.437 GHz (Channel 6)
                    Quality=60/70  Signal level=-50 dBm
                    Encryption key:on
                    ESSID:"fpp-tests-iwlist"
                    IE: IEEE 802.11i/WPA2 Version 1
                        Group Cipher : CCMP
                        Authentication Suites (1) : PSK
          Cell 02 - Address: 02:AA:BB:CC:DD:02
                    Frequency:5.18 GHz (Channel 36)
                    Quality=40/70  Signal level=-70 dBm
                    Encryption key:off
                    ESSID:"fpp-tests-open"
`]]);
  const r = await (await request.get(`/api/network/wifi/scan/${WLAN}`, { timeout: 60_000 })).json();
  // The control: iw was asked first and had nothing.
  expect(calls().some((c) => c.startsWith(`iw dev ${WLAN} scan`)), calls().join('\n')).toBe(true);
  expect(r.status, JSON.stringify(r)).toBe('OK');
  expect(r.networks.map((n: any) => [n.SSID, n.freq, n.signal])).toEqual([
    ['fpp-tests-iwlist', 2437, '-50.00 dBm'],
    ['fpp-tests-open', 5180, '-70.00 dBm'],
  ]);
  expect(realSyntaxErrors(), calls().join('\n')).toEqual([]);
});

test('a connected adapter is scanned at low priority, in words iw takes', async ({ request }) => {
  // Regression: fpp f32c3b1b8.  The scan of a connected adapter asked for
  // `iw dev <if> scan low-priority`; iw's flag is "lowpri", and it refuses
  // anything else as a usage error, so the low-priority scan never ran and
  // every scan fell through to a full one -- in the network API and in
  // wifi_scan.sh (Troubleshooting) alike.
  const bss = 'BSS 02:aa:bb:cc:dd:07(on wlan9)\n\tfreq: 2437\n\tsignal: -48.00 dBm\n\tSSID: fpp-tests-lowpri\n';
  stub('iw', [
    [`dev ${WLAN} info*`, `Interface ${WLAN}\n\tifindex 9\n\ttype managed\n`],
    [`dev ${WLAN} link*`, iwLink('fpp-tests-home')],
    // Only the low-priority scan finds anything.
    [`dev ${WLAN} scan lowpri`, bss],
    ['dev', `phy#0\n\tInterface ${WLAN}\n\t\ttype managed\n`],
  ]);
  stub('iwlist');
  clearCalls();
  const r = await (await request.get(`/api/network/wifi/scan/${WLAN}`, { timeout: 60_000 })).json();
  // The control: the adapter was taken as connected, so a low-priority scan
  // was meant.
  expect(calls().some((c) => c === `iw dev ${WLAN} link`), calls().join('\n')).toBe(true);
  expect(realSyntaxErrors(), calls().join('\n')).toEqual([]);
  expect(r.status, JSON.stringify(r)).toBe('OK');
  expect(r.networks.map((n: any) => n.SSID)).toEqual(['fpp-tests-lowpri']);

  clearCalls();
  const out = inPlayer('bash', '/opt/fpp/scripts/wifi_scan.sh');
  expect(calls(), out).toContain(`iw dev ${WLAN} scan lowpri`);
  expect(realSyntaxErrors(), calls().join('\n')).toEqual([]);
  expect(out).toContain('fpp-tests-lowpri');
});

test('an adapter\'s address and link come from ip and iw, never ifconfig or iwconfig', async ({ request }) => {
  // Regression: 88f05d967.  Every interface lookup ran ifconfig, which goes
  // through the kernel's wireless extensions on a wireless adapter (a "will
  // stop working for Wi-Fi 7 hardware" warning each time).
  // Regression: f4970efd6 (#2554).  The SSID and bit rate were read from
  // iwconfig, which modern systems no longer ship.
  stub('iw', [
    [`dev ${WLAN} link*`, iwLink('fpp-tests-link', -55)],
  ]);
  wrap('ifconfig');
  stub('iwconfig');
  const r = await (await request.get(`/api/network/interface/${WLAN}`)).json();
  expect(r.status, JSON.stringify(r)).toBe('OK');
  expect(r.CurrentAddress, JSON.stringify(r)).toBe(WLAN_ADDR);
  expect(r.CurrentNetmask).toBe('255.255.255.0');
  expect(r.CurrentSSID, JSON.stringify(r)).toBe('fpp-tests-link');
  expect(r.CurrentRate).toBe('72.2');

  expect(calls().filter((c) => /^(ifconfig|iwconfig) /.test(c))).toEqual([]);
  expect(realSyntaxErrors(), calls().join('\n')).toEqual([]);
});

test('the WiFi status names a configured network that is not in range', async ({ request }) => {
  // Feature: 979c4343b (GET /api/network/wifi/status/<if>).  wpa_supplicant
  // is still scanning, and the last scan has no sign of the saved SSID.
  inPlayer('sh', '-c', `printf 'INTERFACE="${WLAN}"\\nPROTO="dhcp"\\nSSID="fpp-tests-home"\\nPSK="secret12"\\n' > ${CONFIG}`);
  stub('wpa_cli', [[`-i ${WLAN} status`, 'wpa_state=SCANNING\np2p_device_address=02:00:00:00:00:09\naddress=02:00:00:00:00:09\n']]);
  stub('iw', [
    [`dev ${WLAN} scan dump*`, 'BSS 02:aa:bb:cc:dd:01(on wlan9)\n\tfreq: 2437\n\tsignal: -50.00 dBm\n\tSSID: fpp-tests-neighbour\n'],
    [`dev ${WLAN} info*`, `Interface ${WLAN}\n\tifindex 9\n\ttype managed\n`],
    [`dev ${WLAN} link*`, 'Not connected.\n'],
  ]);
  clearCalls();
  const r = await (await request.get(`/api/network/wifi/status/${WLAN}`)).json();
  expect(calls().some((c) => c === `wpa_cli -i ${WLAN} status`), calls().join('\n')).toBe(true);
  expect(r.status, JSON.stringify(r)).toBe('OK');
  expect(r.connected).toBe(false);
  expect(r.wpa_state).toBe('SCANNING');
  expect(r.configuredSSID).toBe('fpp-tests-home');
  expect(r.ssidVisible).toBe(false);
  expect(r.reason).toBe("Network 'fpp-tests-home' not found in range (or it is hidden).");

  // The control: once it is associated with an address, it is connected.
  stub('wpa_cli', [[`-i ${WLAN} status`, `wpa_state=COMPLETED\nssid=fpp-tests-home\nip_address=${WLAN_ADDR}\n`]]);
  const ok = await (await request.get(`/api/network/wifi/status/${WLAN}`)).json();
  expect(ok.connected, JSON.stringify(ok)).toBe(true);
  expect(ok.reason).toContain('Connected to fpp-tests-home');
  expect(realSyntaxErrors(), calls().join('\n')).toEqual([]);
});

test('the interface list keeps an adapter\'s IPv6 addresses', async ({ request }) => {
  // Regression: 9d0b2b9a9.  GET /api/network/interface dropped every address
  // but IPv4, so MultiSync never saw that a remote's IPv6 address was on its
  // wireless interface, and showed no wifi icon by it.
  const list = await (await request.get('/api/network/interface')).json();
  const mine = list.find((i: any) => i.ifname === WLAN);
  expect(mine, JSON.stringify(list.map((i: any) => i.ifname))).toBeTruthy();
  const addrs = mine.addr_info.map((a: any) => [a.family, a.local]);
  expect(addrs).toContainEqual(['inet', WLAN_ADDR]);
  expect(addrs, JSON.stringify(addrs)).toContainEqual(['inet6', WLAN_ADDR6]);
});
