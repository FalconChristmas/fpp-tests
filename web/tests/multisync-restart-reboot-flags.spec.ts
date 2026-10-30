import { test, expect } from './fixtures';
import { container } from './container';
import { answerUpdateCheck } from './standin-http';
import { SecondPlayer } from './second-player';

// A remote player that needs fppd restarted or the device rebooted says so
// in its status (restartFlag, rebootFlag), and the MultiSync page shows it in
// the remote's status cell.  The remote is a second real player whose flags
// are set through its own settings API; its status reaches the page through
// this player's /api/system/status, as on a real network.  Only the systems
// list is answered by the test.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const LOCAL = '192.168.0.13';

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

test('a remote that needs a restart and a reboot is flagged with both, each with its icon', async ({ page }) => {
  // Feature: 3f56005f7 (the status cell shows a remote's rebootFlag and
  // restartFlag; before it neither was shown), eb8f1aedd (each warning has a
  // warning-triangle icon, red for the reboot, orange -- now text-warning --
  // for the restart), 383cc0e61 (the wording says what is needed: "Device
  // Reboot Required", "FPPD Restart Required", not a bare "Reboot/Restart
  // Required").
  test.setTimeout(240_000);
  const peer = new SecondPlayer('flags').start();
  try {
    const put = (name: string, value: string) => peer.sh(
      `curl -s -X PUT -H 'Content-Type: text/plain' --data '${value}' http://127.0.0.1/api/settings/${name}`);
    put('restartFlag', '1');
    put('rebootFlag', '1');
    // The control: the remote's own status carries both.
    const own = peer.get('/api/system/status');
    expect([own.restartFlag, own.rebootFlag]).toEqual([1, 1]);

    await page.setViewportSize({ width: 1600, height: 1000 });
    await answerUpdateCheck(page);
    await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({
      json: { systems: [system(LOCAL, 'FPPTESTLOCAL', 'M1-fpptests-local', 1), system(peer.address, 'fpptests-flagged', 'M1-fpptests-flagged')] },
    }));
    await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
    await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
    await page.goto('/multisync.php');
    const row = page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-flagged' });
    await expect(row).toHaveCount(1, { timeout: 15_000 });

    const reboot = row.locator('.warning-text', { hasText: 'Reboot Required' });
    const restart = row.locator('.warning-text', { hasText: 'Restart Required' });
    await expect(reboot).toHaveText('Device Reboot Required', { timeout: 20_000 });
    await expect(restart).toHaveText('FPPD Restart Required');
    // The icon right before each warning.
    await expect(row.locator('i.fa-exclamation-triangle.text-danger + .warning-text')).toHaveText('Device Reboot Required');
    await expect(row.locator('i.fa-exclamation-triangle.text-warning + .warning-text')).toHaveText('FPPD Restart Required');

    // Cleared on the remote, the warnings go with the next status refresh.
    put('restartFlag', '0');
    put('rebootFlag', '0');
    await page.reload();
    const again = page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-flagged' });
    await expect(again).toHaveCount(1, { timeout: 15_000 });
    // Its status has arrived ...
    await expect(again).toContainText(/idle/i, { timeout: 20_000 });
    // ... with no warning in it.
    await expect(again.locator('.warning-text')).toHaveCount(0);
  } finally {
    const verdict = peer.stop();
    expect.soft(verdict.ok, verdict.detail).toBe(true);
  }
});
