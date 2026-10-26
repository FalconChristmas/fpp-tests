import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The "FPP Update complete" banner is there so the outcome of a run nobody
// watched cannot be missed.  A run watched to its end in its own dialog has
// been seen: closing that dialog dismisses the banner.
//
// The run is the update log's START and FINISH lines, which the player's
// update activity is read from (update-activity.spec.ts); the About page's
// update streams a stand-in, since a real one would pull and build here.

test.skip(!container, 'writes the update log in the run-web.sh container');

const LOG = '/home/fpp/media/logs/fpp_system_upgrades.log';

function appendLog(text: string) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  inPlayer('sh', '-c', `mkdir -p $(dirname ${LOG}) && printf '%s [fpp-update master] %s\\n' "$1" "$2" >> ${LOG}`, 'sh', now, text);
}

const COMMIT_UPDATE = {
  status: 'OK', branchUpgradeAvailable: false, branchUpgradeTarget: '', branchUpgradeVersion: '',
  isMajorVersionUpgrade: false, commitUpdateAvailable: true, remoteCommit: 'def4567890', currentBranch: 'master',
  localCommit: 'abc1234567', versionUnknown: false, isEndOfLife: false, latestMajorVersion: 10, checked: true,
};

// Starts a run on the About page and waits until the page's poll has seen
// it finish (it keeps the outcome for the banner in sessionStorage).  The
// update dialog is then done, its Close enabled.
async function watchRunToTheEnd(page: Page, baseURL: string, run: string) {
  const origin = new URL(baseURL).origin;
  await page.route((url) => url.origin !== origin, (route) => route.abort());
  await page.route('**/api/system/updateStatus*', (route) => route.fulfill({ json: COMMIT_UPDATE }));
  await page.route('**/manualUpdate.php*', (route) => route.fulfill({ contentType: 'text/plain', body: `fpp-tests: ${run}\n` }));
  await page.goto('/about.php');
  await expect(page.locator('#fppUpdateButton')).toBeEnabled();
  inPlayer('rm', '-f', LOG);
  appendLog(`===== fpp-update START: ${run} =====`);
  appendLog('===== Building FPP =====');
  await page.locator('#fppUpdateButton').click();
  await expect(page.locator('#fppUpgradeCloseButton')).toHaveText('Close', { timeout: 15_000 });
  await expect(page.locator('#updateInProgressFlag')).toBeVisible({ timeout: 15_000 });
  // The page's poll has seen the run itself (not the placeholder the click
  // put up) in progress.
  await expect.poll(() => page.evaluate(() => (window as any).fppUpdateActivity?.runId), { timeout: 15_000 })
    .toMatch(/^[0-9a-f]{32}$/);
  appendLog(`===== fpp-update FINISH: ${run} (rc=0) =====`);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('fppUpdateCompleted')), { timeout: 30_000 }).not.toBeNull();
}

test.afterEach(() => inPlayer('rm', '-f', LOG));

test('closing a finished update dialog dismisses its banner', async ({ page, baseURL }) => {
  // Regression: 4ec515dfb ("Closing a finished update dialog dismisses its
  // banner").  The poll had recorded the completion while the dialog was
  // open, and Close's page reload restored it: "FPP Update complete" was up
  // again for the run just watched.
  const flag = page.locator('#updateInProgressFlag');

  // The control: a reload with the dialog left open is not an
  // acknowledgement, and the banner tells of the outcome.
  await watchRunToTheEnd(page, baseURL!, 'fpp-tests-unclosed');
  await page.reload();
  await expect(flag).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#updateInProgressFlagText')).toHaveText('FPP Update complete');

  await watchRunToTheEnd(page, baseURL!, 'fpp-tests-closed');
  await Promise.all([page.waitForEvent('load'), page.locator('#fppUpgradeCloseButton').click()]);
  // Long enough for the activity polls after the reload to have rendered it.
  await page.waitForTimeout(6_000);
  await expect(flag, 'the run watched to the end in its dialog is still announced').toBeHidden();
});
