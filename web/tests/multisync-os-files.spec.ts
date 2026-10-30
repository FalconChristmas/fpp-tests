import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { SecondPlayer } from './second-player';

// MultiSync's "Copy OS Upgrade Files": the .fppos images in this player's
// uploads are listed by type (from the name's prefix), and each picked image
// is pushed to every selected remote of the same type -- a pushFiles job in
// streamRemoteJobs.php, which uploads it to the remote's jqupload.php.  The
// remote is a second real player; the page's view of its status is answered
// by the test, which makes it a Raspberry Pi.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const LOCAL = '192.168.0.13';
const UPLOAD = '/home/fpp/media/upload';
const IMAGE = 'Pi64-10.5_2026-10-fpptests.fppos';

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

async function openMultisync(page: Page, remote: string) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({
    json: { systems: [system(LOCAL, 'FPPTESTLOCAL', 'M1-fpptests-local', 1), system(remote, 'fpptests-remote', 'M1-fpptests-remote')] },
  }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: { [remote]: {
    status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
    advancedView: {
      Platform: 'Raspberry Pi', Version: '10.x-master-1-gaaa1111bb', Branch: 'master',
      LocalGitVersion: 'aaa1111', RemoteGitVersion: 'aaa1111',
      Utilization: { CPU: 12, Memory: 34, Disk: { Media: { Free: 50e9, Total: 60e9 } } },
    },
  } } }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2, { timeout: 15_000 });
  return page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-remote' });
}

test('a Pi64 image in the uploads is offered for a Raspberry Pi remote and copied to it', async ({ page }) => {
  // Regression: 468875d87.  Only BBB-, BB64- and Pi- images were recognised;
  // a 64-bit Pi image (Pi64-...) was typed UNKNOWN and never listed, so it
  // could not be copied to a Pi remote from the MultiSync page.
  test.setTimeout(240_000);
  const peer = new SecondPlayer('os-files').start();
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
    await expect(page.locator('#copyOSOptionsDetails .row', { hasText: IMAGE })).toContainText('PI');
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
