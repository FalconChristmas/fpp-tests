import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { WLAN, addWlan, calls, clearCalls, iwLink, realSyntaxErrors, removeStubs, removeWlan, stub } from './wifi-stubs';

// What a WiFi scan says about each network's security, from each of the three
// places it can come from: `iw dev <if> scan` (the usual one), wpa_supplicant's
// own scan results (`wpa_cli scan_results`, for a connected adapter whose
// iw scans come back empty) and `iwlist <if> scan` (drivers without nl80211
// scanning).  The Network page builds its list from these fields: the badge,
// whether picking a network asks for a WPA key or a WEP key or none, and
// whether it ticks WPA3.  The tools are wifi-stubs.ts's stand-ins, answering
// with output in the real tools' own words (iw 6.9, wpa_cli 2.10, wireless-
// tools 30).

test.skip(!container, 'adds an interface and stand-in tools inside the run-web.sh container');

const SCAN_CACHE = `/tmp/fpp_wifi_scan_${WLAN}.json`;

test.beforeEach(() => {
  addWlan();
  inPlayer('rm', '-f', SCAN_CACHE);
});
test.afterEach(() => {
  removeStubs();
  removeWlan();
  inPlayer('rm', '-f', SCAN_CACHE);
});

async function scan(request: APIRequestContext, iface = WLAN) {
  return (await request.get(`/api/network/wifi/scan/${iface}`, { timeout: 60_000 })).json();
}

const byName = (networks: any[]) => Object.fromEntries(networks.map((n) => [n.SSID, n]));

// An iw scan entry, as iw prints one (the lines the parser reads, and some of
// those it should pass over).
function bss(mac: string, ssid: string, o: { freq?: number; signal?: number; privacy?: boolean; ies?: string } = {}) {
  return `BSS ${mac}(on ${WLAN})
\tTSF: 1234567890 usec (0d, 00:20:34)
\tfreq: ${o.freq ?? 2437}
\tbeacon interval: 100 TUs
\tcapability: ESS${o.privacy ? ' Privacy' : ''} ShortSlotTime (0x04${o.privacy ? '11' : '01'})
\tsignal: ${(o.signal ?? -50).toFixed(2)} dBm
\tlast seen: 120 ms ago
\tSSID: ${ssid}
\tSupported rates: 1.0* 2.0* 5.5* 11.0* 6.0 9.0 12.0 18.0
\tDS Parameter set: channel 6
${o.ies ?? ''}`;
}
const rsn = (suites: string, group = 'CCMP') =>
  `\tRSN:\t * Version: 1\n\t\t * Group cipher: ${group}\n\t\t * Pairwise ciphers: ${group}\n\t\t * Authentication suites: ${suites}\n\t\t * Capabilities: 16-PTKSA-RC 1-GTKSA-RC (0x000c)\n`;
const wpa = (group = 'TKIP') =>
  `\tWPA:\t * Version: 1\n\t\t * Group cipher: ${group}\n\t\t * Pairwise ciphers: ${group}\n\t\t * Authentication suites: PSK\n`;

test('an iw scan names each network\'s security, authentication and cipher', async ({ request }) => {
  stub('iw', [[`dev ${WLAN} scan`, [
    bss('02:aa:bb:cc:00:01', 'fpp-tests-open', { freq: 2412, signal: -40 }),
    bss('02:aa:bb:cc:00:02', 'fpp-tests-wpa2', { freq: 5180, privacy: true, ies: rsn('PSK') }),
    bss('02:aa:bb:cc:00:03', 'fpp-tests-mixed', { privacy: true, ies: wpa() + rsn('PSK', 'TKIP') }),
    bss('02:aa:bb:cc:00:04', '', { privacy: true, ies: rsn('PSK') }), // a hidden network
  ].join('')]]);
  stub('iwlist');
  const r = await scan(request);
  expect(r.status, JSON.stringify(r)).toBe('OK');
  expect(r.networks).toEqual([
    { bssid: '02:AA:BB:CC:00:01', freq: 2412, signal: '-40.00 dBm', lastSeen: '120 ms ago', SSID: 'fpp-tests-open' },
    { bssid: '02:AA:BB:CC:00:02', freq: 5180, signal: '-50.00 dBm', lastSeen: '120 ms ago', SSID: 'fpp-tests-wpa2',
      encrypted: true, security: 'WPA2', auth: 'PSK', cipher: 'CCMP' },
    { bssid: '02:AA:BB:CC:00:03', freq: 2437, signal: '-50.00 dBm', lastSeen: '120 ms ago', SSID: 'fpp-tests-mixed',
      encrypted: true, security: 'WPA WPA2', auth: 'PSK', cipher: 'TKIP' },
    // Hidden: iw's "SSID: " line loses its trailing space to exec(), so the
    // entry has no SSID at all (the page leaves such entries out).
    { bssid: '02:AA:BB:CC:00:04', freq: 2437, signal: '-50.00 dBm', lastSeen: '120 ms ago',
      encrypted: true, security: 'WPA2', auth: 'PSK', cipher: 'CCMP' },
  ]);
  // A good scan is kept, for when the next one can't run.
  expect(JSON.parse(inPlayer('cat', SCAN_CACHE)).networks).toEqual(r.networks);
  expect(realSyntaxErrors(), calls().join('\n')).toEqual([]);
});

// iw prints WPA3's suite as "SAE" and Enterprise's as "IEEE 802.1X", and a
// WEP network has neither an RSN nor a WPA element.  Before 40fcea7da
// network_parse_iw_scan() called a WPA3-only network "WPA2" (so picking it
// left WPA3 unticked), gave a WEP network no security (so the page treated it
// as Open and asked for no key), and an Enterprise one no authentication.
test.describe('what an iw scan used to miss', () => {
  test.beforeEach(() => stub('iwlist'));

  test('a WPA3-only network is named WPA3', async ({ request }) => {
    stub('iw', [[`dev ${WLAN} scan`, bss('02:aa:bb:cc:00:11', 'fpp-tests-wpa3', { privacy: true, ies: rsn('SAE') })]]);
    const n = byName((await scan(request)).networks)['fpp-tests-wpa3'];
    expect(n?.security, JSON.stringify(n)).toBe('WPA3');
  });

  test('a WEP network is named WEP', async ({ request }) => {
    stub('iw', [[`dev ${WLAN} scan`, bss('02:aa:bb:cc:00:12', 'fpp-tests-wep', { privacy: true })]]);
    const n = byName((await scan(request)).networks)['fpp-tests-wep'];
    expect(n?.encrypted, JSON.stringify(n)).toBe(true);
    expect(n.security).toBe('WEP');
  });

  test('a WPA3 transition-mode network is both, so picking it leaves WPA3 unticked', async ({ request }) => {
    stub('iw', [[`dev ${WLAN} scan`, bss('02:aa:bb:cc:00:14', 'fpp-tests-trans', { privacy: true, ies: rsn('PSK SAE') })]]);
    const n = byName((await scan(request)).networks)['fpp-tests-trans'];
    expect(n, JSON.stringify(n)).toMatchObject({ encrypted: true, security: 'WPA3 WPA2', auth: 'PSK' });
  });

  test('fast-transition and SAE-EXT-KEY suites are WPA3 too', async ({ request }) => {
    stub('iw', [[`dev ${WLAN} scan`, bss('02:aa:bb:cc:00:15', 'fpp-tests-ft', { privacy: true, ies: rsn('FT/SAE SAE-EXT-KEY') })]]);
    const n = byName((await scan(request)).networks)['fpp-tests-ft'];
    expect(n, JSON.stringify(n)).toMatchObject({ security: 'WPA3', auth: 'PSK' });
  });

  test('an Enhanced Open (OWE) network is encrypted but asks for no key', async ({ request }) => {
    // As wpa_supplicant's own scan results have it: encrypted, no security
    // type, so the page shows it as secured and asks for no key.
    stub('iw', [[`dev ${WLAN} scan`, bss('02:aa:bb:cc:00:16', 'fpp-tests-owe', { privacy: true, ies: rsn('OWE') })]]);
    const n = byName((await scan(request)).networks)['fpp-tests-owe'];
    expect(n?.encrypted, JSON.stringify(n)).toBe(true);
    expect(n.security).toBeUndefined();
    expect(n.auth).toBeUndefined();
  });

  test('an Enterprise network is named Enterprise', async ({ request }) => {
    stub('iw', [[`dev ${WLAN} scan`, bss('02:aa:bb:cc:00:13', 'fpp-tests-corp', { privacy: true, ies: rsn('IEEE 802.1X') })]]);
    const n = byName((await scan(request)).networks)['fpp-tests-corp'];
    expect(n?.auth, JSON.stringify(n)).toBe('Enterprise');
    expect(n.security).toBe('WPA2');
  });
});

test("a connected adapter's empty iw scans fall back to wpa_supplicant's scan results", async ({ request }) => {
  stub('iw', [
    [`dev ${WLAN} info*`, `Interface ${WLAN}\n\tifindex 9\n\ttype managed\n`],
    [`dev ${WLAN} link*`, iwLink('fpp-tests-home')],
  ]);
  stub('iwlist');
  stub('wpa_cli', [[`-i ${WLAN} scan_results`, [
    `Selected interface '${WLAN}'`,
    'bssid / frequency / signal level / flags / ssid',
    '02:aa:bb:cc:01:01\t2437\t-41\t[WPA2-PSK-CCMP][WPS][ESS]\tfpp-tests-home',
    '02:aa:bb:cc:01:02\t5745\t-55\t[WPA2-SAE-CCMP][ESS]\tfpp-tests-wpa3',
    '02:aa:bb:cc:01:03\t5180\t-60\t[WPA2-PSK+SAE-CCMP][ESS]\tfpp-tests-transition',
    '02:aa:bb:cc:01:04\t2412\t-70\t[WPA-PSK-TKIP][WPA2-PSK-CCMP+TKIP][ESS]\tfpp-tests-old',
    '02:aa:bb:cc:01:05\t2462\t-72\t[WEP][ESS]\tfpp-tests-wep',
    '02:aa:bb:cc:01:06\t5200\t-58\t[WPA2-EAP-CCMP][ESS]\tfpp-tests-corp',
    '02:aa:bb:cc:01:07\t2437\t-80\t[ESS]\tfpp-tests-open',
    '02:aa:bb:cc:01:08\t2437\t-81\t[WPA2-PSK-CCMP][ESS]\t',
    'FAIL-BUSY',
  ].join('\n') + '\n']]);
  clearCalls();
  const r = await scan(request);
  expect(r.status, JSON.stringify(r)).toBe('OK');
  // The control: both iw scans were tried first, and came back empty.
  expect(calls()).toEqual(expect.arrayContaining([`iw dev ${WLAN} scan lowpri`, `iw dev ${WLAN} scan`, `wpa_cli -i ${WLAN} scan_results`]));
  const n = (mac: string, freq: number, signal: string, SSID: string, more: Record<string, unknown> = {}) =>
    ({ bssid: mac.toUpperCase(), freq, signal, SSID, ...more });
  expect(r.networks).toEqual([
    n('02:aa:bb:cc:01:01', 2437, '-41.00 dBm', 'fpp-tests-home', { encrypted: true, security: 'WPA2', auth: 'PSK', cipher: 'CCMP' }),
    n('02:aa:bb:cc:01:02', 5745, '-55.00 dBm', 'fpp-tests-wpa3', { encrypted: true, security: 'WPA3', auth: 'PSK', cipher: 'CCMP' }),
    n('02:aa:bb:cc:01:03', 5180, '-60.00 dBm', 'fpp-tests-transition', { encrypted: true, security: 'WPA3 WPA2', auth: 'PSK', cipher: 'CCMP' }),
    n('02:aa:bb:cc:01:04', 2412, '-70.00 dBm', 'fpp-tests-old', { encrypted: true, security: 'WPA2 WPA', auth: 'PSK', cipher: 'TKIP' }),
    n('02:aa:bb:cc:01:05', 2462, '-72.00 dBm', 'fpp-tests-wep', { encrypted: true, security: 'WEP' }),
    n('02:aa:bb:cc:01:06', 5200, '-58.00 dBm', 'fpp-tests-corp', { encrypted: true, security: 'WPA2', auth: 'Enterprise', cipher: 'CCMP' }),
    n('02:aa:bb:cc:01:07', 2437, '-80.00 dBm', 'fpp-tests-open'),
    n('02:aa:bb:cc:01:08', 2437, '-81.00 dBm', '', { encrypted: true, security: 'WPA2', auth: 'PSK', cipher: 'CCMP' }),
  ]);
  expect(realSyntaxErrors(), calls().join('\n')).toEqual([]);
});

test('an iwlist scan names WPA, Enterprise and the group cipher', async ({ request }) => {
  stub('iw');
  stub('iwlist', [[`${WLAN} scan`, `${WLAN}     Scan completed :
          Cell 01 - Address: 02:AA:BB:CC:02:01
                    Frequency:2.412 GHz (Channel 1)
                    Quality=50/70  Signal level=-60 dBm
                    Encryption key:on
                    ESSID:"fpp-tests-legacy"
                    IE: WPA Version 1
                        Group Cipher : TKIP
                        Pairwise Ciphers (1) : TKIP
                        Authentication Suites (1) : 802.1x
`]]);
  const r = await scan(request);
  expect(r.networks).toEqual([{ bssid: '02:AA:BB:CC:02:01', freq: 2412, signal: '-60.00 dBm', SSID: 'fpp-tests-legacy',
    encrypted: true, security: 'WPA', cipher: 'TKIP', auth: 'Enterprise' }]);
});

test('a scan that finds nothing, with nothing kept from before, is an empty list, and is not kept', async ({ request }) => {
  stub('iw');
  stub('iwlist');
  expect(await scan(request)).toEqual({ status: 'OK', networks: [] });
  expect(inPlayer('sh', '-c', `test -e ${SCAN_CACHE} && echo kept || echo none`).trim()).toBe('none');
  // A kept scan with no networks in it is no help either.
  inPlayer('sh', '-c', `printf '{"time":%s,"networks":[]}' $(date +%s) > ${SCAN_CACHE}`);
  expect(await scan(request)).toEqual({ status: 'OK', networks: [] });
});

test("a hotspot with devices on it shows the last scan instead, with its age", async ({ request }) => {
  stub('iw', [
    [`dev ${WLAN} info*`, `Interface ${WLAN}\n\tifindex 9\n\ttype AP\n`],
    [`dev ${WLAN} station dump*`, `Station 02:11:22:33:44:01 (on ${WLAN})\n\tauthorized:\tyes\n`],
  ]);
  stub('iwlist');
  const kept = [{ SSID: 'fpp-tests-kept', freq: 2437, signal: '-61.00 dBm' }];
  // A second can pass between writing the scan and asking: the ages in
  // seconds may be one more.
  for (const [ago, said] of [[1, '(1 second|2 seconds) ago'], [45, '4[56] seconds ago'], [60 * 60, '60 minutes ago'],
    [3 * 3600 + 600, '3 hours ago'], [91 * 60, '2 hours ago'], [150, '3 minutes ago'], [60, '6[01] seconds ago'],
    [5000, '83 minutes ago']] as const) {
    inPlayer('sh', '-c', `printf '%s' '${JSON.stringify({ networks: kept })}' | sed "s/^{/{\\"time\\":$(( $(date +%s) - ${ago} )),/" > ${SCAN_CACHE}`);
    const r = await scan(request);
    expect(r.status, `${ago}s: ${JSON.stringify(r)}`).toBe('Cached');
    expect(r.networks).toEqual(kept);
    expect(r.message).toContain('running the FPP hotspot with 1 device(s) connected');
    expect(r.message, `${ago}s`).toMatch(new RegExp(`Showing the last scan, from ${said}\\.$`));
  }
  expect(calls().filter((c) => / scan( |$)/.test(c) && !c.includes('dump')), 'the hotspot was not scanned').toEqual([]);
});

test('a scan of an interface the player does not have is refused', async ({ request }) => {
  stub('iw');
  expect(await scan(request, 'wlan77')).toEqual({ status: 'Invalid Interface', networks: [] });
  expect(calls(), 'nothing was run for it').toEqual([]);
});
