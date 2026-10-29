import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { FakeGitHub, release } from './standin-http';
import { keepingFile, keepingSettings, setSettingInFile } from './privacy-helpers';

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

// This build's version as a v98.1 release branch would report it, for the
// length of fn: the branch and version come from the generated fppversion.php
// (and the page's script from it, through config.php).
// php-fpm's opcache looks at a file's mtime only every few seconds, so each
// change waits until the PHP reports the branch it should.
async function onReleaseBranch<T>(request: APIRequestContext, fn: () => Promise<T>): Promise<T> {
  const file = '/opt/fpp/www/fppversion.php';
  const branch = async () => (await (await request.get('/api/system/info?simple=1')).json()).Branch;
  const was = await branch();
  try {
    return await keepingFile(file, async () => {
      inPlayer('sed', '-i', '-e', 's/return "fpp-tests";/return "v98.1";/', '-e', 's/return "[0-9]*\\.x-[^"]*";/return "98.1";/',
        '-e', 's/return 10\\.1000;/return 98.1;/', '-e', 's/return "10\\.1000";/return "98.1";/',
        '-e', 's/return "10";/return "98";/', '-e', 's/return "1000";/return "1";/', file);
      await expect.poll(branch, { message: 'the control: the stand-in version', timeout: 15_000 }).toBe('v98.1');
      return await fn();
    });
  } finally {
    await expect.poll(branch, { timeout: 15_000 }).toBe(was);
  }
}

// fppstats' branch list on a player on v98.1, after a fix went into both
// v98.1 and v98.0 when 98.2 was out: the oldest release branches have the
// newest commits.  A beta branch and a new major are newer still.
const BACKPORTED = {
  branches: [
    { name: 'v98.2', commit: { sha: 'c0ffee982', date_epoch: 1000 } },
    { name: 'v98.1', commit: { sha: 'c0ffee981', date_epoch: 3000 } },
    { name: 'v98.0', commit: { sha: 'c0ffee980', date_epoch: 3000 } },
    { name: 'v98.3-beta', commit: { sha: 'c0ffee983', date_epoch: 4000 } },
    { name: 'v99.0', commit: { sha: 'c0ffee990', date_epoch: 5000 } },
  ],
};

test('the highest release branch is offered, not the one committed to last', async ({ page, request, baseURL }) => {
  // Regression: b0c7b6876 ("offer the highest release branch, not the newest
  // commit").  The newest commit picked the branch, so a fix backported to
  // v98.1 after 98.2 was out made v98.1 the "latest" and a player on it was
  // offered nothing.
  inPlayer('sh', '-c', `echo 'Raspberry Pi' > ${PLATFORM}`);
  gh.routes({
    // (The release check would point a newer branch it found back at 98.2,
    // so the newest commits here are on the player's own branch.)
    [COMMITS]: { json: { branches: BACKPORTED.branches.filter((b) => b.commit.date_epoch <= 3000) } },
    [LATEST]: { json: release('98.2', ['Pi64-98.2_2098-10.fppos']) },
  });
  await onReleaseBranch(request, async () => {
    const s = await updateStatus(request);
    expect(s.currentBranch, 'the control: the stand-in branch').toBe('v98.1');
    expect(s.branchUpgradeAvailable, JSON.stringify(s)).toBe(true);
    expect(s.branchUpgradeTarget).toBe('v98.2');
    await openUpgradePage(page, baseURL!);
    await expect(page.locator('#fppUpdateButtonText')).toHaveText('Upgrade to v98.2');
  });
});

test('without the update API the page offers the highest release branch of its own major', async ({ page, request, baseURL }) => {
  // Regression: b0c7b6876.  The page's own fallback, which asks fppstats
  // from the browser when api/system/updateStatus fails, made the same pick
  // by newest commit, and took a suffixed branch or a new major (which may
  // need an OS image it cannot see) as well.
  await onReleaseBranch(request, async () => {
    const origin = new URL(baseURL!).origin;
    const asked: string[] = [];
    await page.route((url) => url.origin !== origin, (route) => {
      if (route.request().url().startsWith('https://fppstats.falconchristmas.com/api/fpp_commits')) {
        asked.push(route.request().url());
        return route.fulfill({ json: BACKPORTED, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
      return route.abort();
    });
    await page.route('**/api/system/updateStatus*', (route) => route.fulfill({ status: 500, body: '' }));
    await page.goto('/about.php');
    await expect.poll(() => asked.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (window as any).FPP_UPDATE_STATE?.checked)).toBe(true);
    const state = await page.evaluate(() => (window as any).FPP_UPDATE_STATE);
    expect(state.currentBranch, 'the control: the stand-in branch').toBe('v98.1');
    expect(state.branchUpgradeTarget, JSON.stringify(state)).toBe('v98.2');
    expect(state.isMajorVersionUpgrade).toBe(false);
    await expect(page.locator('#fppUpdateButtonText')).toHaveText('Upgrade to v98.2');
  });
});

test('a different commit on fppstats is an update only when it is newer than this one', async ({ request }) => {
  // Regression: 58e04313e ("don't flag an update as available when fppstats
  // hasn't caught up with the most recent commit yet").  Any sha but this
  // build's was an update, so for the minutes after a push (or an update
  // here) fppstats' older tip was offered as one.  The player has no git
  // checkout; one is made for the test, with a commit of a known date.
  const when = 1790000000;
  inPlayer('sh', '-c', `set -e; rm -rf /tmp/fpp-tests-git; git init -q -b fpp-tests /tmp/fpp-tests-git
    cd /tmp/fpp-tests-git && GIT_COMMITTER_DATE=@${when} GIT_AUTHOR_DATE=@${when} git -c user.name=t -c user.email=t@t commit -q --allow-empty -m fpp-tests
    mv /tmp/fpp-tests-git/.git /opt/fpp/.git; rm -rf /tmp/fpp-tests-git /tmp/cache_local_git_*`);
  try {
    const local = inPlayer('git', '--git-dir=/opt/fpp/.git', 'rev-parse', '--short=9', 'HEAD').trim();
    const tip = (epoch: number) => ({ branches: [{ name: 'fpp-tests', commit: { sha: 'c0ffee0123456789', date_epoch: epoch } }] });
    gh.routes({ [COMMITS]: { json: tip(when - 600) } });
    let s = await updateStatus(request);
    expect(s.localCommit, 'the control: the stand-in checkout').toBe(local);
    expect(s.remoteCommit).toBe('c0ffee0123456789');
    expect(s.commitUpdateAvailable, 'an older commit on fppstats was offered').toBe(false);
    // The control: a newer one is.
    gh.routes({ [COMMITS]: { json: tip(when + 600) } });
    inPlayer('sh', '-c', 'rm -f /tmp/cache_fppstats_*');
    s = await updateStatus(request);
    expect(s.commitUpdateAvailable, JSON.stringify(s)).toBe(true);
  } finally {
    inPlayer('sh', '-c', 'rm -rf /opt/fpp/.git /tmp/cache_local_git_*');
  }
});

test('with no version to compare the player is offered a rebuild, not an upgrade', async ({ page, request, baseURL }) => {
  // Regression: 3e7859855 ("offer a rebuild, not a bogus upgrade, when the
  // version is unknown").  A tree never built (or cleaned) has no
  // www/fppversion.php, so its version and branch read "Unknown"; every
  // release branch then looked newer, and the page offered one.
  inPlayer('sh', '-c', `echo 'Raspberry Pi' > ${PLATFORM}`);
  gh.routes({
    [COMMITS]: { json: commits(localCommit) },
    [LATEST]: { json: release('10.5', ['Pi64-10.5.fppos']) },
  });
  const file = '/opt/fpp/www/fppversion.php';
  const branch = async () => (await (await request.get('/api/system/info?simple=1')).json()).Branch;
  const was = await branch();
  await keepingFile(file, async () => {
    inPlayer('rm', '-f', file);
    // (php-fpm's opcache notices within a few seconds.)
    await expect.poll(branch, { message: 'the control: the version is unknown', timeout: 15_000 }).toBe('Unknown');
    const s = await updateStatus(request);
    expect(s.versionUnknown, JSON.stringify(s)).toBe(true);
    expect(s.branchUpgradeAvailable).toBe(false);
    expect(s.isEndOfLife).toBe(false);
    await openUpgradePage(page, baseURL!);
    await expect(page.locator('#fppUpdateButtonText')).toHaveText('Rebuild FPP');
    await expect(page.locator('#fppVersionRebuild')).toBeVisible();
  });
  await expect.poll(branch, { timeout: 15_000 }).toBe(was);
});

// fppstats' answer and this player's own caches of it and of GitHub's latest
// release, cleared so a test sees only its own stand-in answers.
function freshChecks() {
  inPlayer('sh', '-c', 'rm -f /tmp/cache_fppstats_* /tmp/cache_github_latest_release.cache /tmp/cache_git_* /tmp/cache_local_git_*');
}

// The page's own fallback check (api/system/updateStatus failing), with
// fppstats answering `branches`; the FPP_UPDATE_STATE it settles on and the
// fppstats URLs it asked.
async function fallbackCheck(page: Page, baseURL: string, branches: unknown) {
  const origin = new URL(baseURL).origin;
  const asked: string[] = [];
  await page.route((url) => url.origin !== origin, (route) => {
    if (route.request().url().startsWith('https://fppstats.falconchristmas.com/api/fpp_commits')) {
      asked.push(route.request().url());
      return route.fulfill({ json: branches, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    return route.abort();
  });
  await page.route('**/api/system/updateStatus*', (route) => route.fulfill({ status: 500, body: '' }));
  await page.goto('/about.php');
  await expect.poll(() => asked.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as any).FPP_UPDATE_STATE?.checked)).toBe(true);
  const state = await page.evaluate(() => (window as any).FPP_UPDATE_STATE);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  return { state, asked };
}

test('a player on the newest release branch is not offered that branch', async ({ page, request, baseURL }) => {
  // Regression: d9c26c8c8 ("Fix upgrade available on branch other than
  // master").  The page compared the player's branch with the literal
  // string 'latest_non_master_epoch' instead of the newest branch found, so
  // a player on any release branch was always told a release was out --
  // its own.  The update API (which came later) makes the same check.
  freshChecks();
  const branches = { branches: [
    { name: 'v98.0', commit: { sha: 'c0ffee980', date_epoch: 1000 } },
    { name: 'v98.1', commit: { sha: 'c0ffee981', date_epoch: 2000 } },
  ] };
  gh.routes({ [COMMITS]: { json: branches } });
  await onReleaseBranch(request, async () => {
    const s = await updateStatus(request);
    expect(s.currentBranch, 'the control: the stand-in branch').toBe('v98.1');
    expect(s.branchUpgradeAvailable, JSON.stringify(s)).toBe(false);

    const { state } = await fallbackCheck(page, baseURL!, branches);
    expect(state.currentBranch, 'the control: the fallback ran on the stand-in branch').toBe('v98.1');
    expect(state.branchUpgradeAvailable, JSON.stringify(state)).toBeFalsy();
    // (A commit update may still be offered: this tree has no commit to compare.)
    await expect(page.locator('#navbarUpdateAvailIcon')).not.toHaveAttribute('title', /Upgrade to/);
  });
});

test('a release branch older than this version is not offered', async ({ page, request, baseURL }) => {
  // Regression: a47a60021 ("Fix display of upgrade available when updates
  // are on older branches").  Any release branch could be the one offered,
  // so a fix committed to an older branch offered that older release as an
  // upgrade.  Here the player is at 98.1 on a branch fppstats doesn't list
  // (a local one), and the only release branch is v98.0.
  freshChecks();
  const branches = { branches: [{ name: 'v98.0', commit: { sha: 'c0ffee980', date_epoch: 9000 } }] };
  gh.routes({ [COMMITS]: { json: branches } });
  await onReleaseBranch(request, async () => {
    const s = await updateStatus(request);
    expect(s.currentBranch, 'the control: the stand-in branch').toBe('v98.1');
    expect(s.branchUpgradeAvailable, JSON.stringify(s)).toBe(false);

    const { state } = await fallbackCheck(page, baseURL!, branches);
    expect(state.currentBranch).toBe('v98.1');
    expect(state.branchUpgradeAvailable, JSON.stringify(state)).toBeFalsy();
    // The control: a newer one of the same major is offered.
    const newer = { branches: [...branches.branches, { name: 'v98.2', commit: { sha: 'c0ffee982', date_epoch: 1000 } }] };
    const again = await fallbackCheck(page, baseURL!, newer);
    expect(again.state.branchUpgradeTarget, JSON.stringify(again.state)).toBe('v98.2');
  });
});

// A git checkout at /opt/fpp for the length of fn (the served tree is an
// export, with none): one commit on branch fpp-tests, whose origin is a bare
// repository in the player with that branch at the same commit.  fn gets
// the commit's full sha.
async function inCheckout<T>(fn: (sha: string) => Promise<T>): Promise<T> {
  inPlayer('sh', '-c', `set -e; rm -rf /tmp/fpp-tests-git /tmp/fpp-tests-origin.git
    git init -q -b fpp-tests /tmp/fpp-tests-git
    cd /tmp/fpp-tests-git && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m fpp-tests
    git clone -q --bare /tmp/fpp-tests-git /tmp/fpp-tests-origin.git
    git remote add origin /tmp/fpp-tests-origin.git
    mv /tmp/fpp-tests-git/.git /opt/fpp/.git; rm -rf /tmp/fpp-tests-git /tmp/cache_local_git_* /tmp/cache_git_*`);
  try {
    return await fn(inPlayer('git', '--git-dir=/opt/fpp/.git', 'rev-parse', 'HEAD').trim());
  } finally {
    inPlayer('sh', '-c', 'rm -rf /opt/fpp/.git /tmp/fpp-tests-origin.git /tmp/cache_local_git_* /tmp/cache_git_*');
  }
}

test("the page's fallback check takes fppstats' full sha of this commit as no update", async ({ page, baseURL }) => {
  // Regression: aa2e54045 ("FIx hash compare").  fppstats gives a commit's
  // full sha and the page knows its own by a short one, and the two were
  // compared with !=, so every player was told an update was out.  The
  // request also gets a cache-busting ?v= so a cached answer isn't reused.
  freshChecks();
  await inCheckout(async (sha) => {
    const tip = (s: string) => ({ branches: [{ name: 'fpp-tests', commit: { sha: s, date_epoch: 1 } }] });
    const { state, asked } = await fallbackCheck(page, baseURL!, tip(sha));
    expect(sha.startsWith(state.localCommit), `the control: the page knows this commit (${state.localCommit})`).toBe(true);
    expect(state.commitUpdateAvailable, JSON.stringify(state)).toBeFalsy();
    expect(asked[0]).toMatch(/\/api\/fpp_commits\?v=\d{13}$/);
    // The control: another commit on fppstats is an update.
    const other = await fallbackCheck(page, baseURL!, tip('c0ffee0123456789abcdef0123456789abcdef01'));
    expect(other.state.commitUpdateAvailable, JSON.stringify(other.state)).toBe(true);
  });
});

test('local and remote commits are compared by 9-character hashes', async ({ request }) => {
  // Regression: f606c681c.  Both sides were cut to 7 characters, at which
  // fpp's history already had over 100 colliding prefixes.  The check
  // without fppstats (it is down here) asks the git remote for the branch
  // tip and compares the two prefixes as strings, so they must be cut alike.
  freshChecks();
  gh.routes({ [COMMITS]: { status: 503, json: { message: 'down' } } });
  await keepingSettings(async () => {
    // Not github.com: the remote is asked without first pinging 8.8.8.8.
    setSettingInFile('UpgradeSource', 'fpp-tests.invalid');
    await inCheckout(async (sha) => {
      const s = await updateStatus(request);
      expect(s.localCommit, JSON.stringify(s)).toBe(sha.slice(0, 9));
      expect(s.remoteCommit, "the git remote's tip, cut the same way").toBe(sha.slice(0, 9));
      expect(s.commitUpdateAvailable, JSON.stringify(s)).toBe(false);
    });
  });
});
