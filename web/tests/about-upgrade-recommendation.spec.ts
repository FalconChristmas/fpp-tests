import { test, expect } from './fixtures';

// The System Upgrade page's recommendation when both an FPP software update
// and an OS upgrade are available.  The update check and the OS image list
// are answered by the test, and nothing leaves for the internet.

// The page with the upgrade cards: system-upgrade.php while it existed
// (Apr-May 2026), about.php before and since.
async function upgradePage(request: import('@playwright/test').APIRequestContext) {
  return (await request.get('/system-upgrade.php')).status() === 200 ? '/system-upgrade.php' : '/about.php';
}

const SETUP = '/api/settings/initialSetup-02';
let setupWas: string | undefined;

test.beforeEach(async ({ request }) => {
  setupWas = String((await (await request.get(SETUP)).json()).value ?? '');
  if (setupWas !== '1') expect((await request.put(SETUP, { data: '1' })).ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
  if (setupWas !== undefined && setupWas !== '1') await request.put(SETUP, { data: setupWas || '0' });
});

test('with an FPP update and an OS upgrade both available, the OS upgrade is recommended', async ({ page, request, baseURL }) => {
  // Regression: 51c69d822 (#2648, #2613).  It recommended updating the FPP
  // software first, though the OS image carries a fresh FPP of its own.
  const origin = new URL(baseURL!).origin;
  await page.route((url) => url.origin !== origin, (route) => route.abort());
  await page.route('**/api/system/updateStatus*', (route) => route.fulfill({
    json: {
      status: 'OK', branchUpgradeAvailable: false, branchUpgradeTarget: '', branchUpgradeVersion: '',
      isMajorVersionUpgrade: false, commitUpdateAvailable: true, remoteCommit: 'def4567890',
      currentBranch: 'master', localCommit: 'abc1234567', versionUnknown: false,
      isEndOfLife: false, latestMajorVersion: 10, checked: true,
    },
  }));
  await page.route('**/api/git/releases/os*', (route) => route.fulfill({
    json: {
      status: 'OK', downloaded: [],
      files: [{
        tag: '11.0', release_name: '11.0', filename: 'Pi64-11.0_2027-01.fppos', asset_id: 4242,
        url: 'https://github.com/FalconChristmas/fpp/releases/download/11.0/Pi64-11.0_2027-01.fppos',
        downloaded: false, size: 1, prerelease: false,
      }],
    },
  }));
  await page.route('**/api/git/originLog*', (route) => route.fulfill({ json: { rows: [] } }));

  await page.goto(await upgradePage(request));
  // The control: both are offered.
  await expect(page.locator('#osSelect option', { hasText: 'Pi64-11.0_2027-01.fppos' })).toBeAttached({ timeout: 30_000 });
  await expect(page.locator('#fppVersionStatusBadge')).toHaveText(/Update Available/, { timeout: 30_000 });

  const banner = page.locator('#upgradeRecommendationBanner');
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#upgradeRecommendationTitle')).toHaveText('Recommended: Upgrade OS First');
  await expect(page.locator('#osRecommendedBadge')).toBeVisible();
  await expect(page.locator('#fppRecommendedBadge')).toBeHidden();
});
