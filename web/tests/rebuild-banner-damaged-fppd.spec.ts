import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Every page's header offers "Rebuild required" with a Rebuild button when
// the built fppd can't run, and api/system/updateActivity carries the same
// condition (fppdBinaryExists) for the update banner to retire or re-show it
// live.  Both only asked whether src/fppd existed: a zero-filled build left
// after a failed write still exists, so such a player showed "FPPD Stopped"
// and nothing offering to rebuild.
//
// The test zero-fills src/fppd in the player.  The running fppd keeps its
// own copy (the binary is moved aside, not overwritten) and gets it back
// afterwards.

const FPPD = '/opt/fpp/src/fppd';
const SAVED = '/opt/fpp/src/fppd.fpp-tests-saved';

test('a zero-filled fppd gets the Rebuild banner and fppdBinaryExists false', async ({ page, request }) => {
  // Regression: 88a1d644c.  menu.inc and GetUpdateActivityInternal() used
  // file_exists() on src/fppd rather than fppdBinaryValid().
  test.skip(!container, 'needs the run-web.sh container');

  // The control: with the real binary there is no banner, and the flag is true.
  await page.goto('/index.php');
  await expect(page.locator('#compileFPPDBanner')).toHaveCount(0);
  expect((await (await request.get('/api/system/updateActivity')).json()).fppdBinaryExists).toBe(true);

  inPlayer('sh', '-c', `mv ${FPPD} ${SAVED} && head -c 65536 /dev/zero > ${FPPD} && chmod 755 ${FPPD}`);
  try {
    await page.goto('/index.php');
    const banner = page.locator('#compileFPPDBanner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Rebuild');
    await expect(banner.locator('input[name=btnRebuild]')).toBeVisible();

    const activity = await (await request.get('/api/system/updateActivity')).json();
    expect(activity.fppdBinaryExists).toBe(false);
  } finally {
    inPlayer('mv', '-f', SAVED, FPPD);
  }

  await page.goto('/index.php');
  await expect(page.locator('#compileFPPDBanner')).toHaveCount(0);
});
