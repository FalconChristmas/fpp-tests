import { test, expect } from './fixtures';
import { container } from './container';
import { StandIn, answerUpdateCheck } from './standin-http';

// A Genius controller (type id 0xA0) and a WLED (0xFB) on the MultiSync page.
// The page asks this player for their status (/api/system/status?type=Genius
// and type=WLED) and the player reads each device's own API: a browser asking
// the device straight would be refused by its missing CORS headers.  Each
// device is a stand-in on a host of its own next to the player, answering as
// the firmware does; only the systems list is answered by the test.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const LOCAL = '192.168.0.13';

function system(address: string, hostname: string, extra: Record<string, unknown> = {}) {
  return {
    address, hostname, local: 0, fppMode: 1, fppModeString: 'bridge',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid: '',
    channelRanges: '', multiSyncCapable: 0, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
    ...extra,
  };
}

test('a Genius and a WLED show the uptime the player read from the device itself', async ({ page }) => {
  // Feature: c500e69c1.  The Genius's uptime was not shown, and the Genius
  // and WLED status were fetched by the browser straight from the device
  // (refused over CORS) instead of through this player.  90061 s is 1d 1h.
  const genius = StandIn.sibling('genius', {
    '/api/state': { json: { system: { uptime_seconds: 90061, friendly_name: 'fpptests-genius-porch' }, status_name: 'idle' } },
  });
  const wled = StandIn.sibling('wled', {
    '/json/info': { json: { name: 'fpptests-wled-eaves', uptime: 90061, wifi: { rssi: -60, signal: 80 } } },
  });
  try {
    genius.start();
    wled.start();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await answerUpdateCheck(page);
    await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: [
      system(LOCAL, 'FPPTESTLOCAL', { local: 1, fppMode: 2, fppModeString: 'player', uuid: 'M1-fpptests-local', multiSyncCapable: 1 }),
      system(genius.address, 'fpptests-genius', { typeId: 0xa0, type: 'Genius', model: 'Genius', version: '1.0', majorVersion: 1, uuid: 'MAC:246F28AABB02' }),
      system(wled.address, 'fpptests-wled', { typeId: 0xfb, type: 'WLED', model: 'WLED', version: '0.15', majorVersion: 0, minorVersion: 15, uuid: 'MAC:246F28AABB03' }),
    ] } }));
    await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
    await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
    await page.goto('/multisync.php');
    for (const [name, reads] of [['fpptests-genius', '/api/state'], ['fpptests-wled', '/json/info']]) {
      const row = page.locator('#fppSystems tr.systemRow', { hasText: name });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await expect(row).toContainText('UP:', { timeout: 20_000 });
      await expect(row).toContainText('1d 1h');
      // The player asked the device itself.
      expect((name.includes('genius') ? genius : wled).requests().map((q) => q.path)).toContain(reads);
    }
  } finally {
    genius.stop();
    wled.stop();
  }
});
