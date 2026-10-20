import { test, expect } from './fixtures';
import type { Route } from '@playwright/test';

// The About page said FPP was up to date before the update check had answered.
// Fixed in fpp c4022c009 ("fix(about): don't show "Up to Date" before the
// update check has actually answered").  api/system/updateStatus can take
// seconds on a cold cache, but the OS image list usually answers first, and
// its handler re-renders both cards via checkUpgradeRecommendation().  With no
// verdict yet, "no FPP update" was the default, so the FPP card read "FPP is up
// to date. No new commits or releases available." (and was faded) until the
// check came back, or for good when it never did.
//
// The update check is held back with a route while the OS list is answered
// (empty), then released with an up-to-date answer.  Nothing may leave for the
// internet: every other host is aborted, and the routed API calls are the ones
// the player would otherwise send on to GitHub and fppstats.

// The suite's setup project finishes the wizard, but the wizard at older fpp
// refs (verify-fix runs this with --no-deps) can't be driven by it; marking it
// done is all about.php needs to be shown instead of the wizard.
const SETUP = '/api/settings/initialSetup-02';
let setupWas: string | undefined;

test.beforeEach(async ({ request }) => {
  setupWas = String((await (await request.get(SETUP)).json()).value ?? '');
  if (setupWas !== '1') expect((await request.put(SETUP, { data: '1' })).ok()).toBe(true);
});

test.afterEach(async ({ page, request }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  if (setupWas !== undefined && setupWas !== '1') await request.put(SETUP, { data: setupWas || '0' });
});

test('the About page does not say "up to date" while the update check is still out', async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await page.route((url) => url.origin !== origin, (route) => route.abort());

  const held: Route[] = [];
  await page.route('**/api/system/updateStatus*', (route) => {
    held.push(route);
  });
  let osListAnswered = false;
  await page.route('**/api/git/releases/os*', async (route) => {
    await route.fulfill({ json: [] });
    osListAnswered = true;
  });
  await page.route('**/api/git/originLog*', (route) => route.fulfill({ json: { rows: [] } }));

  await page.goto('/about.php');
  await expect(page).toHaveURL(/about\.php$/);
  const fppSubtitle = page.locator('#fppCardSubtitle');
  const osSubtitle = page.locator('#osCardSubtitle');

  // The control: the check is out and held, and the OS list has answered and
  // re-rendered the cards (the OS card's subtitle is only written there).
  await expect.poll(() => held.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(() => osListAnswered, { timeout: 30_000 }).toBe(true);
  await expect(osSubtitle).toHaveText(/OS is current/);

  // The bug: with no answer yet, the FPP card already claimed "up to date".
  await expect(fppSubtitle).not.toContainText(/up to date/i);
  await expect(page.locator('#fppUpdateButtonText')).not.toHaveText(/Up to Date/);
  await expect(page.locator('#fppVersionStatusBadge')).not.toHaveText(/Up to Date/);
  await expect(page.locator('#fppCard')).not.toHaveClass(/is-disabled/);

  // Release every held check (the navbar's and the card's may be separate
  // requests) with an up-to-date answer: now the verdict is shown.
  const upToDate = {
    status: 'OK',
    branchUpgradeAvailable: false,
    branchUpgradeTarget: '',
    branchUpgradeVersion: '',
    isMajorVersionUpgrade: false,
    commitUpdateAvailable: false,
    remoteCommit: '',
    currentBranch: '',
    localCommit: '',
    versionUnknown: false,
    isEndOfLife: false,
    latestMajorVersion: 0,
    checked: true,
  };
  await page.unroute('**/api/system/updateStatus*');
  await page.route('**/api/system/updateStatus*', (route) => route.fulfill({ json: upToDate }));
  for (const route of held.splice(0)) await route.fulfill({ json: upToDate });
  await expect(fppSubtitle).toHaveText('FPP is up to date. No new commits or releases available.');
  await expect(page.locator('#fppVersionStatusBadge')).toHaveText('Up to Date');
});
