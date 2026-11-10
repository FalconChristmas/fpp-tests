import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { standInCommand } from './pw-helpers';

// The network interface choices of the audio-over-IP pages: AES67's, Opus
// RTP's and VBAN's, and the AES67 Interface setting's (/api/options).  Each
// reads `ip -o link show`, here a stand-in listing the loopback, a wired
// port, a VLAN on it and an x86 board's Wi-Fi as `ip` names them: a VLAN as
// "eth0.10@eth0" (as a container's veth is "eth0@if12"), where the
// interface's name, the one a socket binds to, is "eth0.10".

test.skip(!container, 'stands in ip inside the run-web.sh container');

const LINKS = [
  '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\\    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00',
  '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc pfifo_fast state UP mode DEFAULT group default qlen 1000\\    link/ether dc:a6:32:00:00:01 brd ff:ff:ff:ff:ff:ff',
  '3: eth0.10@eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default qlen 1000\\    link/ether dc:a6:32:00:00:01 brd ff:ff:ff:ff:ff:ff',
  '4: wlo1: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DORMANT group default qlen 1000\\    link/ether 3c:58:c2:00:00:02 brd ff:ff:ff:ff:ff:ff',
];

test.beforeEach(() => {
  standInCommand('ip', `[ "$*" = "-o link show" ] || exec /usr/sbin/ip "$@"\ncat <<'E'\n${LINKS.join('\n')}\nE`);
});
test.afterEach(() => {
  inPlayer('rm', '-f', '/usr/local/bin/ip', '/tmp/fpp-tests-ip.log');
});

test('the AES67 page offers the wired interfaces by name, not the loopback', async ({ request }) => {
  // The control for the tests below: the same listing, read right.  wlo1 is
  // not wireless here (the container has no /sys/class/net/wlo1), so it stays.
  const r = await request.get('/api/pipewire/aes67/interfaces');
  expect(r.ok()).toBe(true);
  expect(await r.json()).toEqual(['eth0', 'eth0.10', 'wlo1']);
});

// The other lists still filter with `grep -v lo`, which drops every name with
// "lo" in it, and keep ip's "@<link>" suffix, so a VLAN is offered (and saved)
// under a name no interface has: Opus RTP hands it to GStreamer's
// multicast-iface, VBAN's PwConfToken() turns it into no interface at all.
// In FUTURE.md.
for (const [what, url, expected] of [
  ['Opus RTP', '/api/pipewire/opusrtp/interfaces', ['eth0', 'eth0.10', 'wlo1']],
  ['VBAN', '/api/pipewire/vban/interfaces', ['eth0', 'eth0.10', 'wlo1']],
  ['AES67 Interface setting', '/api/options/AES67Interface', { '(Default)': '', eth0: 'eth0', 'eth0.10': 'eth0.10', wlo1: 'wlo1' }],
] as const) {
  test(`the ${what} choices name each interface as it is called, and drop only the loopback`, async ({ request }) => {
    test.fail(true, 'grep -v lo and the @<link> suffix (FUTURE.md)');
    const r = await request.get(url);
    expect(r.ok()).toBe(true);
    expect(await r.json()).toEqual(expected);
  });
}
