import { test, expect } from './fixtures';
import { container } from './container';
import { StandIn, answerUpdateCheck } from './standin-http';

// A Falcon controller on the MultiSync page: the controller answers no
// cross-origin request, so the page does not ask it.  It asks this player
// (/api/system/status?type=FV3 / type=FV4), which reads the controller's own
// status.xml (V3 and earlier) or POSTs its JSON query to /api (V4) and hands
// the answer back.  The controllers are stand-ins on hosts of their own next
// to the player, answering as the firmware does; only the systems list is
// answered by the test.
//
// Regression: d284f88f3 ("Update to handle CORS with Falcon controllers").
// The page had fetched /status.xml and /api from the controller itself, from
// the browser, which fails cross-origin; the player now makes both requests.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const LOCAL = '192.168.0.13';

function system(address: string, hostname: string, typeId: number, extra: Record<string, unknown> = {}) {
  return {
    address, hostname, local: 0, fppMode: 1, fppModeString: 'bridge',
    typeId, type: 'Falcon', model: 'F16V4', version: '2.0', majorVersion: 2, minorVersion: 0, uuid: '',
    channelRanges: '', multiSyncCapable: 0, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
    ...extra,
  };
}

test('a Falcon V3 and a V4 are polled by the player and show what they reported', async ({ page }) => {
  const v3 = StandIn.sibling('falcon-v3', {
    '/status.xml': { body: '<?xml version="1.0"?><response><u>3 days fv3up</u><v1>12.1</v1><v2>5.2</v2></response>', contentType: 'text/xml' },
  });
  const v4 = StandIn.sibling('falcon-v4', {
    // Uptime 100 s, 30.0 C on both sensors against a 60 C threshold.
    '/api': { json: { T: 'R', status_name: 'idle', P: { BS: 60, T1: 300, T2: 300, V1: 124, V2: 50, TS: 0, U: 100, BR: 16 } } },
  });
  try {
    v3.start();
    v4.start();
    const browserAsked: string[] = [];
    page.on('request', (req) => {
      const host = new URL(req.url()).hostname;
      if (host === v3.address || host === v4.address) browserAsked.push(req.url());
    });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await answerUpdateCheck(page);
    await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: [
      system(LOCAL, 'FPPTESTLOCAL', 13, { local: 1, fppMode: 2, fppModeString: 'player', uuid: 'M1-fpptests-local', multiSyncCapable: 1, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B' }),
      system(v3.address, 'FPPTESTFV3', 0x80),
      system(v4.address, 'FPPTESTFV4', 0x88),
    ] } }));
    await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
    await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
    await page.goto('/multisync.php');

    const row3 = page.locator('#fppSystems tr.systemRow', { hasText: 'FPPTESTFV3' });
    const row4 = page.locator('#fppSystems tr.systemRow', { hasText: 'FPPTESTFV4' });
    await expect(row3).toContainText('3 days fv3up', { timeout: 20_000 });
    await expect(row3).toContainText('12.1');
    await expect(row4).toContainText('TEMP: 30C', { timeout: 20_000 });
    await expect(row4).toContainText('12.4v');

    // The player made the requests, as the firmware expects them; the browser
    // made none of its own.
    expect(v3.requests().map((q) => `${q.method} ${q.path}`)).toContain('GET /status.xml');
    const query = v4.requests().find((q) => q.path === '/api');
    expect(query, 'the V4 was never queried').toBeTruthy();
    expect(query!.method).toBe('POST');
    expect(JSON.parse(query!.body)).toMatchObject({ T: 'Q', M: 'ST' });
    expect(browserAsked).toEqual([]);
  } finally {
    v3.stop();
    v4.stop();
  }
});
