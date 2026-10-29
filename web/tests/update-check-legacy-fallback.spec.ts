import { test, expect } from './fixtures';

// The header's update check falls back to fppstats' list of FPP branches when
// the player's own api/system/updateStatus can't answer.  Both are the
// test's here: the API fails, and fppstats lists release branches of the
// installed major version.  The tree's branch is not a release branch, so
// the page is told it is on one (FPP_BRANCH, which the fallback compares).

test('the fallback update check offers a newer release branch of the installed version', async ({ page, request }) => {
  // Regression: b0cea2da9 ("Fix error on console related to version function
  // not available").  The fallback compared each branch with
  // getFPPVersionFloat(), a PHP function no script defines: a ReferenceError
  // in the fppstats answer's handler, and no upgrade was ever offered.
  const html = await (await request.get('/index.php')).text();
  const major = Number(/var FPP_MAJOR_VERSION = (\d+);/.exec(html)![1]);
  const branch = `v${major}.0`;
  const newer = `v${major}.99`;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((b) => {
    Object.defineProperty(window, 'FPP_BRANCH', { get: () => b, set: () => {}, configurable: false });
  }, branch);
  let asked = 0;
  await page.route('**/api/system/updateStatus**', (route) => route.fulfill({ status: 500, body: 'fpp-tests' }));
  await page.route('https://fppstats.falconchristmas.com/api/fpp_commits**', (route) => {
    asked++;
    return route.fulfill({ json: { branches: [
      { name: branch, commit: { sha: 'aaaa', date_epoch: 1 } },
      { name: newer, commit: { sha: 'bbbb', date_epoch: 2 } },
      { name: 'master', commit: { sha: 'cccc', date_epoch: 3 } },
    ] } });
  });
  await page.goto('/index.php');
  await page.waitForLoadState('load');
  await page.waitForFunction(() => !(window as any)._fppUpdateCheckInFlight, null, { timeout: 15_000 });
  await page.evaluate(() => (window as any).checkForFppUpdate(false));
  await expect.poll(() => asked, { message: 'the fallback never asked fppstats' }).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as any).FPP_UPDATE_STATE.branchUpgradeTarget), {
    message: `no upgrade to ${newer} was offered: ${errors.join('; ')}`,
  }).toBe(newer);
  expect(errors).toEqual([]);
});
