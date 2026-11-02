import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { writeFile } from './pw-helpers';
import { netAdmin } from './wifi-stubs';

// Creating persistent names for a USB Ethernet adapter (POST
// /api/network/persistentNames, the Network page's "Create Persistent
// Names"): the adapter is an ethN interface whose device is on the USB bus,
// and it is pinned to the MAC-based name (enx<mac>) the way the other
// interfaces are pinned to theirs.  The container has no USB adapter: a dummy
// interface named eth1 stands in, and a `cat` stand-in on the web server's
// PATH answers for the one sysfs file that says the device is USB (its
// modalias) -- everything else goes to the real cat.

test.skip(!container, 'adds an interface and a stand-in command inside the run-web.sh container');

const CONFIG = '/home/fpp/media/config';
const NETDIR = '/etc/systemd/network';
const CAT = '/usr/local/bin/cat';
const MAC = '02:00:00:aa:bb:cc';
const ENX = 'enx020000aabbcc';

test.beforeEach(() => {
  netAdmin(`ip link del eth1 2>/dev/null; ip link add eth1 address ${MAC} type dummy`);
  writeFile(CAT, `#!/bin/sh\n[ "$1" = /sys/class/net/eth1/device/modalias ] && { echo usb:v0B95p1790d0100; exit 0; }\nexec /bin/cat "$@"\n`);
  inPlayer('chmod', '755', CAT);
});
test.afterEach(() => {
  netAdmin('ip link del eth1 2>/dev/null || true');
  inPlayer('sh', '-c', `rm -f ${CAT} ${CONFIG}/interface.eth1 ${CONFIG}/interface.${ENX} ${NETDIR}/5*-fpp-*.link ${NETDIR}/99-default.link ${NETDIR}/73-usb-net-by-mac.link`);
});

test('a USB Ethernet adapter is pinned to its MAC-based name and its settings follow the name', async ({ request }) => {
  // Regression: 31b4c3b51 ("Hopefully fix persistent network names for usb
  // ethernet devices").  Only the other interfaces had their .link file
  // written; the USB adapter's config was renamed to interface.enx<mac> but
  // nothing pinned the adapter to that name, so after a reboot its settings
  // no longer matched it.  (The default link files were also removed inside
  // the loop, before a later interface could need them.)  The receiving end
  // is the .link file systemd reads.
  writeFile(`${CONFIG}/interface.eth1`, 'INTERFACE="eth1"\nPROTO="static"\nADDRESS="192.0.2.20"\nNETMASK="255.255.255.0"\n');
  const r = await request.post('/api/network/persistentNames');
  expect((await r.json()).status).toBe('OK');
  const link = inPlayer('sh', '-c', `cat ${NETDIR}/5?-fpp-eth1.link 2>/dev/null || true`);
  expect(link).toContain(`[Match]\nMACAddress=${MAC}\n`);
  expect(link).toContain(`[Link]\nNamePolicy=\nName=${ENX}\n`);
  // The settings are kept under the new name.
  expect(inPlayer('sh', '-c', `cat ${CONFIG}/interface.${ENX} 2>/dev/null || true`)).toContain(`INTERFACE="${ENX}"\nPROTO="static"\nADDRESS="192.0.2.20"`);
});
