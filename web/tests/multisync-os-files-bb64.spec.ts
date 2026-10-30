import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { SecondPlayer } from './second-player';

// MultiSync's "Copy OS Upgrade Files" for a 64-bit BeagleBone (AM62x) remote:
// a BB64-*.fppos image in this player's uploads is listed as a BB64 image and
// pushed to a remote whose Platform is "BeagleBone 64" (what FPP_Install.sh
// sets on those boards).  The remote is a second real player, which receives
// the file through its own jqupload.php; the page's view of its status is
// answered by the test, which makes it a BeagleBone 64 (the container can't
// be one).  See multisync-os-files.spec.ts for the Raspberry Pi case.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const LOCAL = '192.168.0.13';
const UPLOAD = '/home/fpp/media/upload';
const IMAGE = 'BB64-10.5_2026-10-fpptests.fppos';

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 0x47, type: 'PocketBeagle2', model: 'BeagleBoard.org PocketBeagle2',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

async function openMultisync(page: Page, remote: string) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({
    json: { systems: [system(LOCAL, 'FPPTESTLOCAL', 'M1-fpptests-local', 1), system(remote, 'fpptests-bb64', 'M1-fpptests-bb64')] },
  }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: { [remote]: {
    status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
    advancedView: {
      Platform: 'BeagleBone 64', Version: '10.x-master-1-gaaa1111bb', Branch: 'master',
      LocalGitVersion: 'aaa1111', RemoteGitVersion: 'aaa1111',
      Utilization: { CPU: 12, Memory: 34, Disk: { Media: { Free: 50e9, Total: 60e9 } } },
    },
  } } }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2, { timeout: 15_000 });
  return page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-bb64' });
}

test('a BB64 image in the uploads is offered as BB64 and copied to a BeagleBone 64 remote', async ({ page }) => {
  // Feature: 238ca0f4f.  Only BBB- and Pi- images were recognised; a BB64-
  // image was typed UNKNOWN and never listed, so it could not be copied to
  // a BeagleBone 64 remote from the MultiSync page.
  test.setTimeout(240_000);
  const peer = new SecondPlayer('os-bb64').start();
  try {
    inPlayer('sh', '-c', `head -c 4096 /dev/urandom > '${UPLOAD}/${IMAGE}'`);
    const sum = inPlayer('md5sum', `${UPLOAD}/${IMAGE}`).split(' ')[0];
    page.on('dialog', (d) => d.accept());
    const row = await openMultisync(page, peer.address);
    await expect(row).toContainText('master', { timeout: 15_000 });
    await row.locator('input.remoteCheckbox').check();
    await page.selectOption('#multiAction', 'copyOSFiles');
    const pick = page.locator('#copyOSOptionsDetails input[type=checkbox]').and(page.locator(`[id="${IMAGE}"]`));
    await expect(pick).toHaveCount(1);
    await expect(page.locator('#copyOSOptionsDetails .row', { hasText: IMAGE })).toContainText('BB64');
    await pick.check();
    await page.evaluate('performMultiAction()');
    // The remote's own upload page took it.
    await expect.poll(() => peer.sh(`md5sum '${UPLOAD}/${IMAGE}' 2>/dev/null || true`).split(' ')[0],
      { timeout: 60_000 }).toBe(sum);
  } finally {
    inPlayer('rm', '-f', `${UPLOAD}/${IMAGE}`);
    const verdict = peer.stop();
    expect.soft(verdict.ok, verdict.detail).toBe(true);
  }
});
