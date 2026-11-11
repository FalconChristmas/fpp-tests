import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The cape firmware page fetches a firmware URL server-side and flashes what
// it gets to the cape's EEPROM, so it takes only a public http(s) host
// (capeFirmwareUrlIsPublic(): no credentials, the scheme's own port, and every
// address the host is or resolves to public).  One URL here for each way a
// URL can name somewhere else; and public ones that must still work.  wget is
// a stand-in that downloads nothing, so no URL goes anywhere; the flash
// script is never reached (the download "comes up short").
// cape-firmware-requests.spec.ts has the first three private ranges.

test.skip(!container, 'stands in for wget inside the run-web.sh container');

const WGET = '/usr/bin/wget';
const CALLS = '/tmp/fpp-tests-ucf-wget';
test.beforeEach(() => {
  inPlayer('sh', '-c', `cp -p ${WGET} ${WGET}.fpp-tests && rm -f ${CALLS} &&
    printf '%s\\n' '#!/bin/sh' 'echo "$*" >> ${CALLS}' 'echo "wget stand-in"' 'exit 4' > ${WGET} && chmod 755 ${WGET}`);
});
test.afterEach(() => {
  inPlayer('sh', '-c', `mv -f ${WGET}.fpp-tests ${WGET}; rm -f ${CALLS} /home/fpp/media/tmp/tmp-eeprom.bin`);
});

async function upgrade(request: any, url: string) {
  return (await request.get('/upgradeCapeFirmware.php?filename=' + encodeURIComponent(url), { timeout: 90_000 })).text() as Promise<string>;
}
const wgetRan = () => inPlayer('sh', '-c', `cat ${CALLS} 2>/dev/null || true`).trim();

// Not http at all: taken as an upload's file name, which can't have a path.
test('a firmware location that is another kind of URL is refused, and not fetched', async ({ request }) => {
  for (const url of ['ftp://8.8.8.8/fw.bin', 'file:///etc/passwd', 'gopher://8.8.8.8/fw.bin']) {
    const out = await upgrade(request, url);
    expect(out, url).toContain('Invalid filename');
    expect(out, url).not.toContain('Downloading');
  }
  expect(wgetRan()).toBe('');
});

const REFUSED: [string, string][] = [
  ['http://user:pw@8.8.8.8/fw.bin', 'credentials'],
  ['http://8.8.8.8:8080/fw.bin', 'another port'],
  ['https://8.8.8.8:80/fw.bin', "http's port on https"],
  ['http://0.0.0.0/fw.bin', 'this network'],
  ['http://0/fw.bin', 'this network, as one number'],
  ['http://127.1/fw.bin', 'loopback, shortened'],
  ['http://2130706433/fw.bin', 'loopback, as one decimal number'],
  ['http://0x7f.1/fw.bin', 'loopback, in hex'],
  ['http://localhost/fw.bin', 'a name for loopback'],
  ['http://100.64.0.1/fw.bin', 'carrier NAT'],
  ['http://172.16.5.5/fw.bin', 'private 172.16/12'],
  ['http://172.31.255.254/fw.bin', 'private 172.16/12, its top'],
  ['http://192.168.1.1/fw.bin', 'private 192.168/16'],
  ['http://192.0.0.1/fw.bin', 'IETF 192.0.0/24'],
  ['http://192.0.2.1/fw.bin', 'TEST-NET-1'],
  ['http://192.88.99.1/fw.bin', '6to4 relay anycast'],
  ['http://198.18.0.1/fw.bin', 'benchmarking'],
  ['http://198.51.100.1/fw.bin', 'TEST-NET-2'],
  ['http://203.0.113.1/fw.bin', 'TEST-NET-3'],
  ['http://224.0.0.1/fw.bin', 'multicast'],
  ['http://240.0.0.1/fw.bin', 'reserved'],
  ['http://255.255.255.255/fw.bin', 'broadcast'],
  ['http://[::1]/fw.bin', 'IPv6 loopback'],
  ['http://[::]/fw.bin', 'IPv6 unspecified'],
  ['http://[fe80::1]/fw.bin', 'IPv6 link-local'],
  ['http://[fd00::1]/fw.bin', 'IPv6 unique-local'],
  ['http://[::ffff:127.0.0.1]/fw.bin', 'IPv4-mapped loopback'],
  ['http://[::ffff:7f00:1]/fw.bin', 'IPv4-mapped loopback, in hex'],
  ['http://[::ffff:10.0.0.1]/fw.bin', 'IPv4-mapped private'],
  ['http://[::127.0.0.1]/fw.bin', 'IPv4-compatible loopback'],
  ['http://fpp-tests-no-such-host.invalid/fw.bin', 'a name that does not resolve'],
];

test('a firmware URL naming anywhere but a public host is refused, and not fetched', async ({ request }) => {
  for (const [url, what] of REFUSED) {
    const out = await upgrade(request, url);
    expect(out, `${what}: ${url}`).toContain('Invalid firmware URL: host must be a public http(s) address');
  }
  expect(wgetRan(), 'wget was run for a refused URL').toBe('');
});

// The page asks the host itself (a ranged GET, to follow redirects), so the
// one public address here is the one cape-firmware-download-failed.spec.ts
// already uses.
test('a public host is fetched, on its own port or with the default named', async ({ request }) => {
  test.setTimeout(180_000);
  for (const url of ['http://8.8.8.8/fw.bin', 'http://8.8.8.8:80/fw.bin', 'https://8.8.8.8:443/fw.bin']) {
    const out = await upgrade(request, url);
    expect(out, url).not.toContain('Invalid firmware URL');
    expect(out, url).toContain(`Downloading ${url}`);
    // The download came to nothing, so nothing is flashed.
    expect(out, url).toContain('Problems downloading firmware');
  }
  expect(wgetRan().split('\n')).toHaveLength(3);
});

// IPv6 prefixes that carry an IPv4 address to a gateway are checked as IPv6
// only: NAT64's 64:ff9b::/96 and 6to4's 2002::/16 pass whatever IPv4 address
// they carry, so on a network with a NAT64 gateway (IPv6-only LANs, some
// ISPs) http://[64:ff9b::a00:1]/ reaches 10.0.0.1.  In FUTURE.md.
for (const [url, what] of [
  ['http://[64:ff9b::a00:1]/fw.bin', 'NAT64 for 10.0.0.1'],
  ['http://[2002:7f00:1::]/fw.bin', '6to4 for 127.0.0.1'],
] as const) {
  test(`${what} is refused like the address it carries`, async ({ request }) => {
    const out = await upgrade(request, url);
    test.fail(true, 'NAT64 and 6to4 addresses are not checked as the IPv4 they carry (FUTURE.md)');
    expect(out).toContain('Invalid firmware URL');
  });
}
