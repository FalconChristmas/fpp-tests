import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { WLAN, addWlan, calls, clearCalls, realSyntaxErrors, removeStubs, removeWlan, stub } from './wifi-stubs';

// A WiFi scan of an adapter running FPP's hotspot with devices connected to
// it: a single radio stops beaconing to scan, dropping every one of them, so
// neither the network API nor wifi_scan.sh (Troubleshooting) scans it.  The
// adapter is a dummy "wlan9" with stand-in wireless tools (wifi-stubs.ts).

test.skip(!container, 'adds an interface and stand-in tools inside the run-web.sh container');

const SCAN_CACHE = `/tmp/fpp_wifi_scan_${WLAN}.json`;

const station = (mac: string) => `Station ${mac} (on ${WLAN})
\tinactive time:\t1200 ms
\trx bytes:\t52341
\ttx bytes:\t81234
\tsignal:  \t-41 dBm
\tauthorized:\tyes
\tassociated:\tyes
`;

function hotspot(stations: string[]) {
  stub('iw', [
    [`dev ${WLAN} info*`, `Interface ${WLAN}\n\tifindex 9\n\ttype AP\n\tssid FPP\n`],
    [`dev ${WLAN} station dump*`, stations.join('')],
    ['dev', `phy#0\n\tInterface ${WLAN}\n\t\ttype AP\n`],
  ]);
  stub('iwlist');
  stub('wpa_cli');
  clearCalls();
}

const scans = () => calls().filter((c) => /^iw dev \S+ scan(?! dump)|^iwlist \S+ scan/.test(c));

test.beforeEach(() => {
  addWlan();
  inPlayer('rm', '-f', SCAN_CACHE);
});

test.afterEach(() => {
  removeStubs();
  removeWlan();
  inPlayer('rm', '-f', SCAN_CACHE);
});

test('a hotspot with devices connected is not scanned', async ({ request }) => {
  // Regression: fed929798.  The scan ran `iw dev <if> scan` and `iwlist <if>
  // scan` on the hotspot's own adapter, which stops it beaconing and
  // disconnects every device on it.
  hotspot([station('02:11:22:33:44:01'), station('02:11:22:33:44:02')]);
  const r = await (await request.get(`/api/network/wifi/scan/${WLAN}`, { timeout: 60_000 })).json();
  expect(scans(), `the API scanned the hotspot:\n${calls().join('\n')}`).toEqual([]);
  // The control: the adapter was asked what it is and who is on it.
  expect(calls(), calls().join('\n')).toContain(`iw dev ${WLAN} station dump`);
  expect(r.status, JSON.stringify(r)).toBe('Blocked');
  expect(r.networks).toEqual([]);
  expect(r.message).toContain('2 device(s) connected');

  clearCalls();
  const out = inPlayer('bash', '/opt/fpp/scripts/wifi_scan.sh');
  expect(scans(), `wifi_scan.sh scanned the hotspot:\n${out}`).toEqual([]);
  expect(out).toContain(`${WLAN}: hotspot has 2 client(s) connected - skipping disruptive scan`);
  expect(realSyntaxErrors(), calls().join('\n')).toEqual([]);
});

test('a hotspot with nobody on it is scanned', async ({ request }) => {
  // The other half of fed929798: only connected devices stop the scan.
  hotspot([]);
  const r = await (await request.get(`/api/network/wifi/scan/${WLAN}`, { timeout: 60_000 })).json();
  expect(r.status, JSON.stringify(r)).not.toBe('Blocked');
  expect(scans(), calls().join('\n')).toContain(`iw dev ${WLAN} scan`);

  clearCalls();
  const out = inPlayer('bash', '/opt/fpp/scripts/wifi_scan.sh');
  expect(scans(), out).toContain(`iw dev ${WLAN} scan`);
  expect(out).not.toContain('skipping disruptive scan');
  expect(realSyntaxErrors(), calls().join('\n')).toEqual([]);
});
