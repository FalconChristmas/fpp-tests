import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { writeFile } from './pw-helpers';
import { netAdmin } from './wifi-stubs';

// Clearing the persistent interface names (DELETE /api/network/persistentNames,
// the Network page's "Clear Persistent Names") with a USB Ethernet adapter
// that has its MAC-based name.  The adapter is a dummy interface named as
// systemd names one (enx<mac>), added to the player by a sibling container
// with NET_ADMIN.  The receiving end is the real fppinit setupNetwork, which
// writes the systemd-networkd file for each config/interface.<name>.

test.skip(!container, 'adds an interface and runs fppinit inside the run-web.sh container');

const CONFIG = '/home/fpp/media/config';
const NETDIR = '/etc/systemd/network';
const ENX = 'enx020000aabbcc';

function cat(path: string): string {
  return inPlayer('sh', '-c', `cat '${path}' 2>/dev/null || true`);
}

test.beforeEach(() => {
  netAdmin(`ip link del ${ENX} 2>/dev/null; ip link add ${ENX} type dummy`);
});

test.afterEach(() => {
  netAdmin(`ip link del ${ENX} 2>/dev/null || true`);
  inPlayer('sh', '-c', `rm -f ${CONFIG}/interface.${ENX} ${CONFIG}/interface.eth1 ${CONFIG}/interface.eth2 ` +
    `${NETDIR}/10-${ENX}.network ${NETDIR}/10-eth1.network ${NETDIR}/10-eth2.network ` +
    `${NETDIR}/99-default.link ${NETDIR}/73-usb-net-by-mac.link ${NETDIR}/5*-fpp-*.link`);
});

test('clearing persistent names gives a USB adapter\'s settings back to an ethN name', async ({ request }) => {
  // Also 63454ffd6, 01efb5054: the route is /persistentNames (spelled right),
  // and the handler it names exists.
  // Regression: 45defae1c ("support for renaming USB ethernet adapter
  // interfaces with persistent names").  Creating persistent names renames a
  // USB adapter's config to interface.enx<mac>; clearing them brought the
  // adapter back as ethN with no config, so its static address was lost.
  writeFile(`${CONFIG}/interface.${ENX}`,
    `INTERFACE="${ENX}"\nPROTO="static"\nADDRESS="192.0.2.20"\nNETMASK="255.255.255.0"\n`);
  inPlayer('rm', '-f', `${CONFIG}/interface.eth1`, `${CONFIG}/interface.eth2`);
  const r = await request.delete('/api/network/persistentNames');
  expect(await r.json()).toEqual({ status: 'OK' });
  expect(cat(`${CONFIG}/interface.${ENX}`)).toBe('');
  expect(cat(`${CONFIG}/interface.eth1`)).toBe('INTERFACE="eth1"\nPROTO="static"\nADDRESS="192.0.2.20"\nNETMASK="255.255.255.0"\n');

  inPlayer('sh', '-c', 'timeout 120 /opt/fpp/src/fppinit setupNetwork > /dev/null 2>&1 || true');
  const net = cat(`${NETDIR}/10-eth1.network`);
  expect(net).toContain('Name=eth1');
  expect(net).toContain('Address=192.0.2.20/24');
  expect(cat(`${NETDIR}/10-${ENX}.network`)).toBe('');
});

test('the adapter takes the first ethN without settings of its own', async ({ request }) => {
  // Regression: 45defae1c: eth0 is the built-in port, and an ethN that has
  // a config already keeps it.
  writeFile(`${CONFIG}/interface.${ENX}`,
    `INTERFACE="${ENX}"\nPROTO="static"\nADDRESS="192.0.2.20"\nNETMASK="255.255.255.0"\n`);
  writeFile(`${CONFIG}/interface.eth1`, 'INTERFACE="eth1"\nPROTO="dhcp"\n');
  expect(await (await request.delete('/api/network/persistentNames')).json()).toEqual({ status: 'OK' });
  expect(cat(`${CONFIG}/interface.eth1`)).toBe('INTERFACE="eth1"\nPROTO="dhcp"\n');
  expect(cat(`${CONFIG}/interface.eth2`)).toContain('INTERFACE="eth2"\nPROTO="static"\nADDRESS="192.0.2.20"');
});

test('creating persistent names pins each interface to its MAC address', async ({ request }) => {
  // Regression: 63454ffd6, 01efb5054.  The route was renamed to
  // /persistentNames and its POST handler was named for the old spelling,
  // which no longer existed: the Network page's "Create Persistent Names"
  // got a fatal error.  The receiving end is the .link file systemd reads.
  const r = await request.post('/api/network/persistentNames');
  const body = await r.json();
  expect(body.status).toBe('OK');
  expect(body.interfaceCnt).toBeGreaterThan(0);
  const links = inPlayer('sh', '-c', `cat ${NETDIR}/5*-fpp-*.link 2>/dev/null || true`);
  expect(links).toMatch(/\[Match\]\nMACAddress=([0-9a-f]{2}:){5}[0-9a-f]{2}\n/);
  expect(links).toContain('[Link]\nNamePolicy=\nName=');
});
