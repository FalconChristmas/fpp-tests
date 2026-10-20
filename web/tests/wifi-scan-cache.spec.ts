import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// GET /api/network/wifi/scan/<if> remembers its last successful scan, and when
// a scan comes back empty (or can't run: a hotspot with clients on it) answers
// with that list instead, labelled with its age.  The player has no Wi-Fi, so
// a scan of its wired interface -- which the endpoint accepts, being a
// present interface -- always comes back empty, and the remembered scan is
// written by the test.

test.skip(!container, 'writes the scan cache inside the run-web.sh container');

// The interface the player's default route uses: a real, listed one (a
// container also has tunnel devices, which the interface list leaves out).
const IFACE = container ? inPlayer('sh', '-c', "ip -o route show default | sed -n 's/.* dev \\([^ ]*\\).*/\\1/p' | head -1").trim() : '';
const CACHE = `/tmp/fpp_wifi_scan_${IFACE}.json`;

function seed(ageSeconds: number) {
  const now = parseInt(inPlayer('date', '+%s').trim(), 10);
  const cache = JSON.stringify({
    time: now - ageSeconds,
    networks: [{ SSID: 'fpp-tests-cached', freq: 2437, signal: '-61.00 dBm' }],
  });
  inPlayer('sh', '-c', `cat > ${CACHE} <<'EOF'\n${cache}\nEOF\nchmod 666 ${CACHE}`);
}

test('an empty scan falls back to the last one, but not to one from yesterday', async ({ request }) => {
  // Feature: cf3e9490b.
  try {
    seed(120);
    let r = await (await request.get(`/api/network/wifi/scan/${IFACE}`, { timeout: 60_000 })).json();
    expect(r.status, JSON.stringify(r)).toBe('Cached');
    expect(r.networks.map((n: any) => n.SSID)).toEqual(['fpp-tests-cached']);
    expect(r.message).toContain('from 2 minutes ago');

    seed(2 * 86400);
    r = await (await request.get(`/api/network/wifi/scan/${IFACE}`, { timeout: 60_000 })).json();
    expect(r.status, JSON.stringify(r)).toBe('OK');
    expect(r.networks).toEqual([]);
  } finally {
    inPlayer('rm', '-f', CACHE);
  }
});
