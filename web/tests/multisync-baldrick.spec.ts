import { test, expect } from './fixtures';
import { container } from './container';
import { StandIn, answerUpdateCheck } from './standin-http';

// A Baldrick board (type id 0xC4, ILightThat) on the MultiSync page: the page
// asks this player for its status (/api/system/status?type=Baldrick), the
// player reads the board's own /system_state, and the row shows its uptime,
// its state (Idle, Playing, Testing) and its firmware, with a warning when an
// update is available.  The board is a stand-in on a host of its own next to
// the player, answering /system_state as the firmware does; only the systems
// list is answered by the test.  How fppd detects a Baldrick is
// scenarios/test_controller_detection.py.

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

test('a Baldrick board\'s state, uptime and firmware come from its /system_state', async ({ page }) => {
  // Feature: 49c4b2e1b.  Before it a Baldrick was not polled at all: its row
  // showed only what discovery had found.
  const board = StandIn.sibling('baldrick', {
    '/system_state': { json: {
      hostname: 'fpptests-baldrick', board_model: 'Baldrick 8 Port', uptime: 90061,
      test_mode_active: true, frame_rate: 0,
      ota: { current_firmware_version: 'v3.5.4', available_firmware_version: 'v3.6.0' },
    } },
  });
  try {
    board.start();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await answerUpdateCheck(page);
    await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: [
      system(LOCAL, 'FPPTESTLOCAL', { local: 1, fppMode: 2, fppModeString: 'player', uuid: 'M1-fpptests-local', multiSyncCapable: 1 }),
      system(board.address, 'fpptests-baldrick', {
        typeId: 0xC4, type: 'Baldrick', model: 'Baldrick 8 Port', version: 'v3.5.4', majorVersion: 3, minorVersion: 5,
        uuid: 'MAC:246F28AABB01',
      }),
    ] } }));
    await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
    await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
    await page.goto('/multisync.php');
    const row = page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-baldrick' });
    await expect(row).toHaveCount(1, { timeout: 15_000 });

    // The board's test mode is its status, and the newer firmware it offers
    // is flagged on its version.
    await expect(row).toContainText('Testing', { timeout: 20_000 });
    await expect(row.locator('span.text-warning[title="Update available: v3.6.0"]')).toContainText('v3.5.4');
    // The player asked the board itself.
    expect(board.requests().map((q) => q.path)).toContain('/system_state');
  } finally {
    board.stop();
  }
});
