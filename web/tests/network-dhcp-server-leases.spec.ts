import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { WLAN, addWlan, calls, clearCalls, iwLink, realSyntaxErrors, removeStubs, removeWlan, stub } from './wifi-stubs';

// An interface running FPP's DHCP server (the hotspot, or a show network) as
// GET /api/network/interface/<if> reports it for the Network page: its static
// leases, read back from the leases file the save writes, and the leases the
// server has handed out right now (networkctl status, each address's MAC from
// arp), less those that are just the static ones.  Also a wireless adapter's
// link rates.  networkctl and arp are wifi-stubs.ts's stand-ins.
// (network-config-page.spec.ts: the page showing and saving static leases.)

test.skip(!container, 'adds an interface and stand-in tools inside the run-web.sh container');

const CONFIG = `/home/fpp/media/config`;

test.beforeEach(() => {
  addWlan();
  inPlayer('sh', '-c', `printf 'INTERFACE="${WLAN}"\\nPROTO="static"\\nADDRESS="192.168.8.1"\\nNETMASK="255.255.255.0"\\n` +
    `GATEWAY="192.168.8.254"\\nDHCPSERVER="1"\\nDHCPOFFSET="100"\\nDHCPPOOLSIZE="50"\\n' > ${CONFIG}/interface.${WLAN}`);
});
test.afterEach(() => {
  removeStubs();
  removeWlan();
  inPlayer('rm', '-f', `${CONFIG}/interface.${WLAN}`, `${CONFIG}/leases.${WLAN}`);
});

// networkctl status for an interface serving DHCP: the leases are the line
// that starts "Offered DHCP leases:" and the lines lined up under it.
const networkctl = (leases: [string, string][]) => `●  9: ${WLAN}
                     Link File: /usr/lib/systemd/network/99-default.link
                  Network File: /etc/systemd/network/10-${WLAN}.network
                         State: routable (configured)
                       Address: 192.168.8.1
${leases.map(([ip, client], i) => `${i ? '                              ' : '           Offered DHCP leases: '}${ip} (to ${client})`).join('\n')}
             Activation Policy: up
`;
const arp = (ip: string, mac: string) => `? (${ip}) at ${mac} [ether] on ${WLAN}\n`;

test("the static leases are read back, and the current ones are listed less those that are static", async ({ request }) => {
  inPlayer('sh', '-c', `printf '[DHCPServerStaticLease]\\nMACAddress=02:00:00:00:08:10\\nAddress=192.168.8.10\\n\\n` +
    `[DHCPServerStaticLease]\\nAddress=192.168.8.11\\nMACAddress=02:00:00:00:08:11\\n\\n' > ${CONFIG}/leases.${WLAN}`);
  stub('networkctl', [[`* status ${WLAN}`, networkctl([
    ['192.168.8.10', '01:02:00:00:00:08:10'], // the static lease, taken by its own device
    ['192.168.8.11', '01:02:00:00:00:08:99'], // the static address, but another device has it
    ['192.168.8.120', '01:02:00:00:00:08:20'], // from the pool
  ])]]);
  stub('arp', [
    ['-a 192.168.8.10', arp('192.168.8.10', '02:00:00:00:08:10')],
    ['-a 192.168.8.11', arp('192.168.8.11', '02:00:00:00:08:99')],
    ['-a 192.168.8.120', arp('192.168.8.120', '02:00:00:00:08:20')],
  ]);
  stub('iw', [[`dev ${WLAN} link*`, iwLink('fpp-tests-ap', -40)]]);
  clearCalls();

  const r = await (await request.get(`/api/network/interface/${WLAN}`)).json();
  expect(r.status, JSON.stringify(r)).toBe('OK');
  expect(r.StaticLeases).toEqual({ '192.168.8.10': '02:00:00:00:08:10', '192.168.8.11': '02:00:00:00:08:11' });
  expect(r.CurrentLeases).toEqual({ '192.168.8.11': '02:00:00:00:08:99', '192.168.8.120': '02:00:00:00:08:20' });
  // The gateway is global now, not the interface's.
  expect(r).not.toHaveProperty('GATEWAY');
  expect(r).toMatchObject({ PROTO: 'static', ADDRESS: '192.168.8.1', DHCPSERVER: '1' });
  // And the link, from iw: its SSID and both bit rates.
  expect(r).toMatchObject({ CurrentSSID: 'fpp-tests-ap', CurrentRate: '72.2', CurrentTXRate: '72.2', CurrentRXRate: '65.0' });
  expect(realSyntaxErrors(), calls().join('\n')).toEqual([]);
});

test('with no leases file and nothing handed out, both lists are empty', async ({ request }) => {
  stub('networkctl', [[`* status ${WLAN}`, networkctl([]).replace(/^.*Offered DHCP leases:.*\n/m, '')]]);
  stub('arp');
  stub('iw');
  const r = await (await request.get(`/api/network/interface/${WLAN}`)).json();
  expect(r.StaticLeases).toEqual([]);
  expect(r.CurrentLeases).toEqual([]);
  expect(calls().filter((c) => c.startsWith('arp')), 'no address to look up').toEqual([]);
});

test('an interface without the DHCP server has no lease lists, and runs nothing for them', async ({ request }) => {
  inPlayer('sh', '-c', `sed -i 's/^DHCPSERVER=.*/DHCPSERVER="0"/' ${CONFIG}/interface.${WLAN}`);
  stub('networkctl');
  stub('arp');
  stub('iw');
  const r = await (await request.get(`/api/network/interface/${WLAN}`)).json();
  expect(r.status).toBe('OK');
  expect(r).not.toHaveProperty('StaticLeases');
  expect(r).not.toHaveProperty('CurrentLeases');
  expect(calls().filter((c) => /^(networkctl|arp) /.test(c))).toEqual([]);
});
