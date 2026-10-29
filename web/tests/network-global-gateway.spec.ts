import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { writeFile } from './pw-helpers';

// The default gateway is one setting for the player (config/gateway, the
// Network page's Gateway field), no longer one per interface.  The receiving
// end is the real fppinit setupNetwork of the tree under test, which turns
// the config into systemd-networkd files: run here against made-up
// interfaces (eth8, eth9), whose .network files are read back.  Nothing
// reloads networkd in the container, so the route itself is not applied.

test.skip(!container, 'runs fppinit inside the run-web.sh container');

const CONFIG = '/home/fpp/media/config';
const NETDIR = '/etc/systemd/network';

function cat(path: string): string {
  return inPlayer('sh', '-c', `cat '${path}' 2>/dev/null || true`);
}

function setupNetwork() {
  inPlayer('sh', '-c', 'timeout 120 /opt/fpp/src/fppinit setupNetwork > /dev/null 2>&1 || true');
}

test.afterEach(() => {
  inPlayer('sh', '-c', `rm -f ${CONFIG}/gateway ${CONFIG}/interface.eth8 ${CONFIG}/interface.eth9 ` +
    `${NETDIR}/10-eth8.network ${NETDIR}/10-eth9.network`);
});

test('the saved gateway is the default route of the static interfaces only', async ({ request }) => {
  // Regression: d57649ef6 ("revamp of network settings page"), which moved
  // the gateway from each interface to /api/network/gateway: two static
  // interfaces each with a gateway gave the player two default routes, and
  // a DHCP interface's own route fought a static one.
  const saved = await request.post('/api/network/gateway', { data: { GATEWAY: '192.0.2.1' } });
  expect(await saved.json()).toEqual({ status: 'OK', GATEWAY: '192.0.2.1' });
  expect(await (await request.get('/api/network/gateway')).json()).toEqual({ GATEWAY: '192.0.2.1' });
  expect(cat(`${CONFIG}/gateway`)).toBe('GATEWAY="192.0.2.1"\n');

  writeFile(`${CONFIG}/interface.eth9`, 'INTERFACE="eth9"\nPROTO="static"\nADDRESS="192.0.2.10"\nNETMASK="255.255.255.0"\n');
  writeFile(`${CONFIG}/interface.eth8`, 'INTERFACE="eth8"\nPROTO="dhcp"\n');
  setupNetwork();
  const staticNet = cat(`${NETDIR}/10-eth9.network`);
  expect(staticNet).toContain('Address=192.0.2.10/24');
  expect(staticNet).toContain('[Route]\nGateway=192.0.2.1\n');
  const dhcpNet = cat(`${NETDIR}/10-eth8.network`);
  expect(dhcpNet).toContain('DHCP=');
  expect(dhcpNet).not.toContain('Gateway=');
});

test('a gateway saved on an interface before is moved to the player\'s', async ({ request }) => {
  // Regression: d57649ef6: fppinit carries a pre-10 interface's GATEWAY over
  // to config/gateway, takes it out of the interface's file, and routes
  // through it as before.
  writeFile(`${CONFIG}/interface.eth9`,
    'INTERFACE="eth9"\nPROTO="static"\nADDRESS="192.0.2.10"\nNETMASK="255.255.255.0"\nGATEWAY="192.0.2.254"\n');
  setupNetwork();
  expect(cat(`${CONFIG}/gateway`)).toBe('GATEWAY="192.0.2.254"\n');
  expect(cat(`${CONFIG}/interface.eth9`)).not.toContain('GATEWAY');
  expect(cat(`${NETDIR}/10-eth9.network`)).toContain('[Route]\nGateway=192.0.2.254\n');
  expect(await (await request.get('/api/network/gateway')).json()).toEqual({ GATEWAY: '192.0.2.254' });
});
