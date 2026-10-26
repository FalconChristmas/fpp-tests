import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { WLAN, WLAN_ADDR, addWlan, calls, iwLink, realSyntaxErrors, removeStubs, removeWlan, stub } from './wifi-stubs';

// Regression: 82f25d613 ("run one wpa_supplicant, not two").  FPP stopped
// starting the generic wpa_supplicant service, and with it the network API
// stopped depending on wpa_supplicant's control socket for "associated, and
// to what": the WiFi status falls back to the kernel (iw link, ip addr) when
// wpa_cli gets no answer.  Before, a station whose socket was unreachable was
// reported not connected, with no SSID or address.  The adapter is
// wifi-stubs.ts's dummy wlan9 with its address; wpa_cli is a stand-in that
// answers nothing, as with no socket; iw is a stand-in for the kernel.

test.skip(!container, 'adds an interface and stand-in tools inside the run-web.sh container');

const CONFIG = `/home/fpp/media/config/interface.${WLAN}`;

test.beforeEach(() => addWlan());
test.afterEach(() => {
  removeStubs();
  removeWlan();
  inPlayer('rm', '-f', CONFIG);
});

test('an associated station is reported connected when wpa_supplicant gives no answer', async ({ request }) => {
  inPlayer('sh', '-c', `printf 'INTERFACE="${WLAN}"\\nPROTO="dhcp"\\nSSID="fpp-tests-home"\\nPSK="secret12"\\n' > ${CONFIG}`);
  stub('wpa_cli', []);
  stub('iw', [[`dev ${WLAN} link*`, iwLink('fpp-tests-home')], [`dev ${WLAN} info*`, `Interface ${WLAN}\n\ttype managed\n`]]);
  const r = await (await request.get(`/api/network/wifi/status/${WLAN}`)).json();
  // The control: wpa_cli was asked, and said nothing.
  expect(calls()).toContain(`wpa_cli -i ${WLAN} status`);
  expect(r.connected, JSON.stringify(r)).toBe(true);
  expect(r.ssid).toBe('fpp-tests-home');
  expect(r.ip).toBe(WLAN_ADDR);
  expect(realSyntaxErrors()).toEqual([]);
});
