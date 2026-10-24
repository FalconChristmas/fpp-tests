import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { FakeGitHub, release } from './standin-http';

// GET /api/system/updateStatus, with GitHub and fppstats answered by a stand-in
// in the player (standin-http.ts).  The player builds as branch "fpp-tests" at
// a 10.x version, so a v10.5 release branch on fppstats is a branch upgrade
// candidate, and GitHub's releases/latest decides whether it is offered.

test.skip(!container, 'stubs GitHub inside the run-web.sh container');

const LATEST = '/repos/FalconChristmas/fpp/releases/latest';
const COMMITS = '/api/fpp_commits';
const PLATFORM = '/etc/fpp/platform';

// fppstats' branch list: this build's own branch at its own commit, and a
// newer release branch.
function commits(localCommit: string) {
  return {
    branches: [
      { name: 'fpp-tests', commit: { sha: localCommit, date_epoch: 1 } },
      { name: 'v10.5', commit: { sha: 'f00dfeed1', date_epoch: 1 } },
    ],
  };
}

async function updateStatus(request: APIRequestContext) {
  const r = await request.get('/api/system/updateStatus', { timeout: 60_000 });
  expect(r.ok(), await r.text()).toBe(true);
  return r.json();
}

// The page that shows the answer, the receiving end: system-upgrade.php while
// it existed (Apr-Jun 2026), about.php before and since.  Nothing it asks for
// leaves for the internet; the player's own update check goes to the stand-in.
async function openUpgradePage(page: Page, baseURL: string) {
  const origin = new URL(baseURL).origin;
  await page.route((url) => url.origin !== origin, (route) => route.abort());
  const reworked = (await page.request.get('/system-upgrade.php')).status() === 200;
  const answered = page.waitForResponse((r) => r.url().includes('/api/system/updateStatus'), { timeout: 60_000 });
  await page.goto(reworked ? '/system-upgrade.php' : '/about.php');
  await answered;
  await page.waitForTimeout(500);
}

let gh: FakeGitHub;
let localCommit = '';

test.beforeEach(() => {
  localCommit = inPlayer('sh', '-c', 'git --git-dir=/opt/fpp/.git rev-parse --short=9 HEAD 2>/dev/null || true').trim();
  gh = new FakeGitHub({ [COMMITS]: { json: commits(localCommit) } });
  gh.start();
});

test.afterEach(() => {
  gh?.stop();
  inPlayer('rm', '-f', PLATFORM);
});

test('a release branch is offered only once its release has an OS image for this device', async ({ page, request, baseURL }) => {
  // Regression: 55f32e553 (#2544).  A vX.Y branch on fppstats was offered as
  // an upgrade as soon as it existed: a published release older than the
  // branch only retargeted it, and one without an image for this device
  // (or none at all yet) still left "FPP v10.5 is available" up.
  inPlayer('sh', '-c', `echo 'Raspberry Pi' > ${PLATFORM}`);
  gh.routes({
    [COMMITS]: { json: commits(localCommit) },
    [LATEST]: { json: release('10.5', ['BBB-10.5.fppos', 'BB64-10.5.fppos']) },
  });
  let s = await updateStatus(request);
  expect(gh.requests().map((r) => r.path), 'the update check did not ask the stand-in').toContain(LATEST);
  expect(s.branchUpgradeAvailable, JSON.stringify(s)).toBe(false);
  await openUpgradePage(page, baseURL!);
  await expect(page.locator('#fppUpdateButtonText')).not.toHaveText(/v10\.5/);

  // The control: the same release with an image for this (64-bit Pi) player.
  gh.routes({
    [COMMITS]: { json: commits(localCommit) },
    [LATEST]: { json: release('10.5', ['BBB-10.5.fppos', 'Pi64-10.5.fppos']) },
  });
  inPlayer('sh', '-c', 'rm -f /tmp/cache_github_latest_release.cache');
  s = await updateStatus(request);
  expect(s.branchUpgradeAvailable, JSON.stringify(s)).toBe(true);
  expect(s.branchUpgradeTarget).toBe('v10.5');
  await openUpgradePage(page, baseURL!);
  await expect(page.locator('#fppUpdateButtonText')).toHaveText('Upgrade to v10.5');
});

test('a failed release check keeps the last good answer instead of caching an empty one', async ({ page, request, baseURL }) => {
  // Regression: c6086167c.  A releases/latest request that failed was cached
  // like an answer, an empty release, for the whole cache window: the latest
  // major version fell back to this build's own and the end-of-life notice
  // went away until it expired.
  gh.routes({
    [COMMITS]: { json: commits(localCommit) },
    [LATEST]: { json: release('11.0', ['Pi64-11.0.fppos']) },
  });
  let s = await updateStatus(request);
  expect(s.latestMajorVersion, JSON.stringify(s)).toBe(11);
  expect(s.isEndOfLife).toBe(true);

  // GitHub now fails, and the cached answer is past its window (5 minutes
  // and the minute's grace), so the next check asks again.
  gh.routes({ [COMMITS]: { json: commits(localCommit) }, [LATEST]: { status: 502, json: { message: 'Bad Gateway' } } });
  inPlayer('touch', '-d', '10 minutes ago', '/tmp/cache_github_latest_release.cache');
  gh.clearLog();
  s = await updateStatus(request);
  expect(gh.requests().map((r) => r.path), 'the expired cache was not re-checked').toContain(LATEST);
  expect(s.latestMajorVersion, JSON.stringify(s)).toBe(11);
  expect(s.isEndOfLife).toBe(true);
  // And the request after it, inside what would be a fresh window, too.
  s = await updateStatus(request);
  expect(s.latestMajorVersion, JSON.stringify(s)).toBe(11);
  // And the page still warns that this version has reached end of life.
  await openUpgradePage(page, baseURL!);
  await expect(page.locator('#eolBanner')).toBeVisible();
  await expect(page.locator('#eolLatestVersion')).toHaveText('v11');
});
