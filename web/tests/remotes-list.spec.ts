import { execFileSync } from 'child_process';
import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { answerUpdateCheck } from './standin-http';
import { SecondPlayer } from './second-player';

// GET /api/remotes, the MultiSync hosts a command can be sent to, and the
// checkbox list the command editor builds from it.  The systems are put in
// fppd's own list with MultiSync pings sent to it from inside the player
// (the IP field of a ping is what fppd lists a system under).  fppd keeps a
// system for two hours, so the addresses are TEST-NET and link-local ones
// nothing answers on, under names no other test uses.

test.skip(!container, 'sends MultiSync pings inside the run-web.sh container');

const PING = `
import socket, struct, sys
def field(v, n): return v.encode()[:n].ljust(n, b"\\0")
def ping(ip, host, uuid):
    extra = bytes([4, 0, 0x01]) + struct.pack(">HH", 10, 0) + bytes([0x08]) + bytes(int(o) for o in ip.split("."))
    extra += field(host, 65) + field("10.0", 41) + field("Test", 41) + field("", 121) + bytes(14) + field(uuid, 65)
    extra = extra[:359].ljust(359, b"\\0")
    return b"FPPD" + bytes([0x04]) + struct.pack("<H", len(extra)) + extra
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
for a in sys.argv[1:]:
    ip, host, uuid = a.split(",")
    s.sendto(ping(ip, host, uuid), ("127.0.0.1", 32320))
`;

// One device at a routable address and at a link-local one; another at a
// link-local address only.
const BOTH = { host: 'fpp-tests-two-addrs', uuid: 'fpp-tests-uuid-two', routable: '192.0.2.77', apipa: '169.254.77.5' };
const ONLY = { host: 'fpp-tests-apipa-only', uuid: 'fpp-tests-uuid-apipa', apipa: '169.254.77.9' };

function sendPings() {
  execFileSync('docker', ['exec', '-i', container, 'sh', '-c', 'cat > /tmp/fpp-tests-ping.py'], { input: PING });
  inPlayer('python3', '/tmp/fpp-tests-ping.py',
    `${BOTH.apipa},${BOTH.host},${BOTH.uuid}`, `${BOTH.routable},${BOTH.host},${BOTH.uuid}`, `${ONLY.apipa},${ONLY.host},${ONLY.uuid}`);
  inPlayer('rm', '-f', '/tmp/fpp-tests-ping.py');
}

async function listed(request: import('@playwright/test').APIRequestContext) {
  return (await (await request.get('/api/fppd/multiSyncSystems')).json()).systems.map((s: any) => s.address);
}

test('the remotes list drops a link-local address a device also has a routable one for', async ({ request }) => {
  // Regression: 01ce4cc4b (#2733).  Every address fppd had heard from was
  // offered as a command target, including a device's stale 169.254 one
  // next to its real address; one that is all a device has stays.
  sendPings();
  await expect.poll(() => listed(request), { timeout: 10_000 }).toEqual(expect.arrayContaining([BOTH.routable, ONLY.apipa]));
  const remotes = await (await request.get('/api/remotes')).json();
  const addrs = Object.keys(remotes);
  expect(addrs).toContain(BOTH.routable);
  expect(addrs).toContain(ONLY.apipa);
  expect(addrs, JSON.stringify(remotes)).not.toContain(BOTH.apipa);
  expect(remotes[BOTH.routable]).toBe(`${BOTH.routable} - ${BOTH.host}`);
});

test.describe(() => {
  test.use({ bypassCSP: true });
  test('a command\'s MultiSync hosts are picked with checkboxes', async ({ page, request }) => {
    // Regression: 01ce4cc4b (#2733).  The hosts field was a text box with a
    // datalist, which offers nothing to pick on a touch screen.  Besides the
    // pinged systems, a second real player (second-player.ts) is on the
    // network, found by fppd's own discovery, and is one of the hosts picked.
    test.setTimeout(240_000);
    const peer = new SecondPlayer('remotes').start();
    const name = 'fpp-tests-remotes-list';
    try {
      sendPings();
      await expect.poll(() => listed(request), { timeout: 30_000 }).toEqual(expect.arrayContaining([BOTH.routable, peer.address]));
      await request.post(`/api/playlist/${name}`, { data: { name, version: 4, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} } });
      await answerUpdateCheck(page);
      // Picking a host makes the editor ask it, through this player's
      // /proxy/<host>/, for its playlists, at http://<server name>/ on port 80,
      // which a browser reaching the player through run-web.sh's published
      // port can't reach; and the pinged hosts never answer.  The lookups
      // aren't what this tests, so they are answered here.
      await page.route(/\/proxy\/[^/]+\//, (route) => route.fulfill({ json: [] }));
      await page.goto('/playlists.php');
      await page.locator('.playlistCard h3', { hasText: new RegExp(`^${name}$`) }).click();
      await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
      await page.locator('.playlistEntriesAddNewBtn').first().click();
      await page.selectOption('#pe_type', 'command');
      await page.selectOption('#playlistEntryOptions_arg_1', 'Start Playlist');
      await page.check('#playlistEntryCommandOptions_multisync');
      const boxes = page.locator('#playlistEntryCommandOptions_multisyncHostsSelect input.multisyncHostCheckbox');
      await expect(boxes.first()).toBeVisible();
      const values = await boxes.evaluateAll((bs) => bs.map((b) => (b as HTMLInputElement).value));
      expect(values).toEqual(expect.arrayContaining([BOTH.routable, ONLY.apipa, peer.address]));
      expect(values).not.toContain(BOTH.apipa);
      await boxes.and(page.locator(`[value="${peer.address}"]`)).check();
      await boxes.and(page.locator(`[value="${ONLY.apipa}"]`)).check();
      const hosts = page.locator('#playlistEntryCommandOptions_multisyncHosts');
      await expect.poll(async () => (await hosts.inputValue()).split(',').sort()).toEqual([peer.address, ONLY.apipa].sort());
    } finally {
      await request.delete(`/api/playlist/${name}`);
      const verdict = peer.stop();
      expect.soft(verdict.ok, verdict.detail).toBe(true);
    }
  });
});
