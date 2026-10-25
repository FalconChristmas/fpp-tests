import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { keepingFile } from './privacy-helpers';

// The About page's OS upgrade card: which images the select offers and in
// what order, and what the page makes of them -- the OS status badge, the
// "OS upgrade available" banner, the upgrade buttons' state.  The OS image
// list and the update check are answered by the test (os-image-list.spec.ts
// has the API that fills the list), and nothing leaves for the internet.  The
// player is made a 64-bit Raspberry Pi (Pi64 images) by its /etc/fpp/platform.
// This player is a master build, so its version reads "10.x-master-...".

test.skip(!container, 'makes the run-web.sh container a Pi');

const PLATFORM = '/etc/fpp/platform';
const SETUP = '/api/settings/initialSetup-02';
let setupWas: string | undefined;
let uiLevel = '0';

test.beforeEach(async ({ request }) => {
  inPlayer('sh', '-c', `echo 'Raspberry Pi' > ${PLATFORM}`);
  setupWas = String((await (await request.get(SETUP)).json()).value ?? '');
  if (setupWas !== '1') expect((await request.put(SETUP, { data: '1' })).ok()).toBe(true);
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
});

test.afterEach(async ({ request }) => {
  inPlayer('rm', '-f', PLATFORM);
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
  if (setupWas !== undefined && setupWas !== '1') await request.put(SETUP, { data: setupWas || '0' });
});

async function setUiLevel(request: APIRequestContext, level: string) {
  expect((await request.put('/api/settings/uiLevel', { data: level })).ok()).toBe(true);
}

// The page with the upgrade cards: system-upgrade.php while it existed
// (Apr-Jun 2026), about.php before and since.
async function upgradePage(request: APIRequestContext) {
  return (await request.get('/system-upgrade.php')).status() === 200 ? '/system-upgrade.php' : '/about.php';
}

let assetId = 4242;
function image(filename: string, extra: Record<string, unknown> = {}) {
  const tag = filename.replace(/^[A-Za-z0-9]+-/, '').replace(/[_].*$/, '');
  return {
    tag, release_name: tag, filename, asset_id: ++assetId,
    url: `https://github.com/FalconChristmas/fpp/releases/download/${tag}/${filename}`,
    downloaded: false, size: 1, prerelease: false, ...extra,
  };
}

const UP_TO_DATE = {
  status: 'OK', branchUpgradeAvailable: false, branchUpgradeTarget: '', branchUpgradeVersion: '',
  isMajorVersionUpgrade: false, commitUpdateAvailable: false, remoteCommit: '', currentBranch: 'master',
  localCommit: 'abc1234567', versionUnknown: false, isEndOfLife: false, latestMajorVersion: 10, checked: true,
};
const COMMIT_UPDATE = { ...UP_TO_DATE, commitUpdateAvailable: true, remoteCommit: 'def4567890' };
const MAJOR_UPGRADE = {
  ...UP_TO_DATE, branchUpgradeAvailable: true, isMajorVersionUpgrade: true,
  branchUpgradeTarget: 'v11.0', branchUpgradeVersion: '11.0', latestMajorVersion: 11,
};

// Opens the upgrade page with the update check answered by `update` and the
// OS image list by `images`, and waits until the select has been filled.
async function openWith(page: Page, request: APIRequestContext, baseURL: string, update: object, images: object[]) {
  const origin = new URL(baseURL).origin;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route((url) => url.origin !== origin, (route) => route.abort());
  await page.route('**/api/system/updateStatus*', (route) => route.fulfill({ json: update }));
  // The list is answered once the page knows the installed version (the
  // status below), so the page compares the images against it rather than
  // guessing without it.
  let statusAnswered: () => void = () => undefined;
  const status = new Promise<void>((resolve) => { statusAnswered = resolve; });
  let listed = false;
  await page.route('**/api/git/releases/os*', async (route) => {
    await Promise.race([status, new Promise((r) => setTimeout(r, 10_000))]);
    await route.fulfill({ json: { status: 'OK', downloaded: [], files: images } }).catch(() => undefined);
    listed = true;
  });
  await page.route('**/api/git/originLog*', (route) => route.fulfill({ json: { rows: [] } }));
  // The installed OS image, which a container doesn't have: one from early
  // 2026, as a player shows it.
  await page.route('**/api/system/status*', async (route) => {
    // (A fetch can be cut off, as when the test moves on to the next page.)
    let response = null;
    for (let i = 0; i < 3 && !response; i++) response = await route.fetch().catch(() => null);
    if (!response) return route.abort().catch(() => undefined);
    const json = await response.json().catch(() => null);
    if (!json?.advancedView) return route.fulfill({ response });
    json.advancedView.OSVersion = 'v2026-01 (64bit)';
    await route.fulfill({ response, json });
    statusAnswered();
  });
  await page.goto(await upgradePage(request));
  await expect.poll(() => listed, { timeout: 30_000 }).toBe(true);
  // The list's handler fills the select and re-renders the cards in one go;
  // the update check's answer re-renders them again.
  await expect(page.locator('#fppVersionStatusBadge')).not.toHaveText('', { timeout: 30_000 });
  await page.waitForTimeout(500);
}

async function offered(page: Page): Promise<string[]> {
  return page.locator('#osSelect option').evaluateAll((os) =>
    os.filter((o) => (o as HTMLOptionElement).value !== '').map((o) => o.textContent!.trim().replace(/ \(download\).*$/, '')));
}

test('a nightly image on a master build is no OS upgrade, a newer release is', async ({ page, request, baseURL }) => {
  // Regression: f696ca9ff ("exclude nightly fppos from indicating os upgrade
  // available in dev ui mode").  A master build's version ("10.x-master-...")
  // did not parse, and the fallback took any listed image -- a nightly, at
  // the Developer level that lists them -- for an OS upgrade.
  // Regression: 13f0fdf3b ("Skip nightly-tagged options in checkForNewerOS()
  // so the banner only fires for stable releases").
  await setUiLevel(request, '3');
  const version = (await (await request.get('/api/system/status')).json()).advancedView.Version;
  expect(version, 'the control: a master build').toMatch(/^\d+\.x-/);
  await openWith(page, request, baseURL!, UP_TO_DATE, [image('Pi64-nightly_2099-12.fppos', { prerelease: true })]);
  expect(await offered(page)).toEqual(['Pi64-nightly_2099-12.fppos']);
  await expect(page.locator('#osVersionStatusBadge')).toHaveText('Up to Date');
  await expect(page.locator('#osUpdateBanner'), 'a nightly was taken for an OS upgrade').toBeHidden();
  // The control: a newer major's image is one.
  await openWith(page, request, baseURL!, UP_TO_DATE, [image('Pi64-nightly_2099-12.fppos', { prerelease: true }), image('Pi64-99.0_2099-01.fppos')]);
  await expect(page.locator('#osVersionStatusBadge')).toHaveText('Upgrade Available');
  await expect(page.locator('#osUpdateBanner')).toBeVisible();
});

test('the OS version badge reads the upgrade state', async ({ page, request, baseURL }) => {
  // Regression: d0df7320d ("sync OS version badge with detected upgrade
  // state", #2648).  The badge said "Up to Date" whatever the page had found.
  await openWith(page, request, baseURL!, MAJOR_UPGRADE, [image('Pi64-99.0_2099-01.fppos')]);
  await expect(page.locator('#osVersionStatusBadge')).toHaveText('Upgrade Required');
  await openWith(page, request, baseURL!, UP_TO_DATE, [image('Pi64-99.0_2099-01.fppos')]);
  await expect(page.locator('#osVersionStatusBadge')).toHaveText('Upgrade Available');
  await openWith(page, request, baseURL!, UP_TO_DATE, []);
  await expect(page.locator('#osVersionStatusBadge')).toHaveText('Up to Date');
});

test('the upgrade buttons are amber only when there is an upgrade to make', async ({ page, request, baseURL }) => {
  // Regression: c31685333 ("align upgrade button and pill colors with update
  // state").  The FPP button was always green and the OS button always amber,
  // up to date or not.  (Its current-OS pill colouring was dropped later: the
  // pill is neutral now.)
  const fpp = page.locator('#fppUpdateButton');
  const os = page.locator('#osUpgradeButton');
  await openWith(page, request, baseURL!, UP_TO_DATE, []);
  await expect(fpp).toHaveClass(/fpp-btn--secondary/);
  await expect(os).toHaveClass(/fpp-btn--secondary/);
  await expect(fpp).not.toHaveClass(/fpp-btn--(success|warning)/);
  await expect(os).not.toHaveClass(/fpp-btn--(success|warning)/);
  await openWith(page, request, baseURL!, COMMIT_UPDATE, []);
  await expect(fpp).toHaveClass(/fpp-btn--warning/);
  await expect(os).toHaveClass(/fpp-btn--secondary/);
  await openWith(page, request, baseURL!, UP_TO_DATE, [image('Pi64-99.0_2099-01.fppos')]);
  await expect(os).toHaveClass(/fpp-btn--warning/);
  await expect(fpp).toHaveClass(/fpp-btn--secondary/);
});

test('a beta image is offered from the Advanced level, a nightly only at Developer', async ({ page, request, baseURL }) => {
  // Regression: a9c5e89e4 ("Gate nightly and other prereleases separately in
  // OS image list").  Every GitHub prerelease was taken for a nightly, so a
  // beta was hidden below the Developer level too.
  const images = [
    image('Pi64-99.0_2099-01.fppos'),
    image('Pi64-99.1-beta1_2099-02.fppos', { prerelease: true }),
    image('Pi64-nightly_2099-12.fppos', { prerelease: true }),
  ];
  for (const [level, want] of [
    ['0', ['Pi64-99.0_2099-01.fppos']],
    ['1', ['Pi64-99.1-beta1_2099-02.fppos', 'Pi64-99.0_2099-01.fppos']],
    ['3', ['Pi64-nightly_2099-12.fppos', 'Pi64-99.1-beta1_2099-02.fppos', 'Pi64-99.0_2099-01.fppos']],
  ] as const) {
    await setUiLevel(request, level);
    await openWith(page, request, baseURL!, UP_TO_DATE, images);
    expect((await offered(page)).sort(), `uiLevel ${level}`).toEqual([...want].sort());
  }
});

test('with no image for this board the OS card says so', async ({ page, request, baseURL }) => {
  // Regression: 7f229d359 ("Show an empty-state note when no OS image matches
  // the platform").  The select held only its placeholder, with no word why.
  await openWith(page, request, baseURL!, UP_TO_DATE, [image('Pi64-nightly_2099-12.fppos', { prerelease: true })]);
  expect(await offered(page)).toEqual([]);
  await expect(page.locator('#osNoImages')).toBeVisible();
  await expect(page.locator('#osNoImages')).toContainText('No compatible OS image');
  await openWith(page, request, baseURL!, UP_TO_DATE, [image('Pi64-99.0_2099-01.fppos')]);
  await expect(page.locator('#osNoImages')).toBeHidden();
});

test('the OS images are listed newest first, and one for another board cannot be applied', async ({ page, request, baseURL }) => {
  // Regression: 4fa919d29 ("Enhance OS filename parsing and device
  // compatibility checks", #2725).  The select kept the order the list came
  // in, and any image picked from it -- one for another board, from "Show All
  // Platforms" -- could be applied.
  await setUiLevel(request, '1');
  await openWith(page, request, baseURL!, UP_TO_DATE, [
    image('Pi64-98.5_2098-09.fppos'),
    image('Pi64-99.0-beta2_2098-12.fppos', { prerelease: true }),
    image('Pi64-98.5.2_2098-11.fppos'),
    image('Pi64-99.0_2099-01.fppos'),
    image('BBB-99.0_2099-01.fppos'),
  ]);
  expect(await offered(page)).toEqual([
    'Pi64-99.0_2099-01.fppos', 'BBB-99.0_2099-01.fppos', 'Pi64-99.0-beta2_2098-12.fppos',
    'Pi64-98.5.2_2098-11.fppos', 'Pi64-98.5_2098-09.fppos',
  ]);
  const select = page.locator('#osSelect');
  const value = (name: string) => select.locator('option', { hasText: name }).getAttribute('value');
  // The control: an image for this board can be applied.
  await select.selectOption(await value('Pi64-99.0_2099-01.fppos'));
  await expect(page.locator('#osUpgradeButton')).toBeEnabled();
  await select.selectOption(await value('BBB-99.0_2099-01.fppos'));
  await expect(page.locator('#osUpgradeButton'), 'a BeagleBone image could be applied to a Pi').toBeDisabled();
});

test('the upgrade page is about.php, and every page that sends you back links there', async ({ request }) => {
  // Regression: 0228d0de0 ("Revert to about.php to fix multisync older
  // FPPs").  The upgrade page had moved to system-upgrade.php, and older
  // players' MultiSync pages link to about.php.
  const about = await request.get('/about.php');
  expect(about.status()).toBe(200);
  const html = await about.text();
  expect(html).toContain('id="osSelect"');
  // The header's version link and update icon, and the Help menu entry.
  expect(html.match(/href=['"]about\.php['"]/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  expect(html).not.toContain('system-upgrade.php');
  // The OS upgrade's own page links back there too (an image that is not
  // there ends it early; the upgrade log it writes is put back).
  await keepingFile('/home/fpp/media/logs/fpp_system_upgrades.log', async () => {
    const back = await (await request.post('/upgradeOS.php?os=fpp-tests-missing.fppos', { timeout: 60_000 })).text();
    expect(back).toContain('File does not exist');
    expect(back).toContain("<a href='about.php'>");
    expect(back).not.toContain('system-upgrade.php');
  });
});

test('the About page loads when its caches cannot be written', async ({ request }) => {
  // Regression: ece480e86 ("Fix which causes about.php to fail if remote cache
  // can not be read").  file_cache() went on with the false fopen() gave it
  // for a cache's lock or file: a fatal flock(false) on a page that had to
  // recompute one.  Every cache the tree's PHP names is left uncomputed, with
  // a directory where its lock goes.
  const names = inPlayer('sh', '-c', 'cd /opt/fpp/www && cat *.php api/controllers/*.php | ' +
    `sed -n -e "s/.*file_cache('\\([A-Za-z0-9_]*\\)'.*/\\1/p" -e 's/.*cachefile_name = "\\([A-Za-z0-9_]*\\)".*/\\1/p'; ` +
    'ls /tmp | sed -n "s/^cache_\\(.*\\)\\.cache$/\\1/p"').split('\n').filter((n) => n);
  const all = [...new Set(names)];
  // The control: the caches the page reads are among them.
  expect(all).toEqual(expect.arrayContaining(['local_git_version', 'kernel_version']));
  inPlayer('sh', '-c', all.map((n) => `rm -f /tmp/cache_${n}.cache; mkdir -p /tmp/cache_${n}.cache_recalc`).join('; '));
  try {
    for (const url of ['/about.php', await upgradePage(request)]) {
      const r = await request.get(url);
      const body = await r.text();
      expect(body, url).not.toMatch(/Fatal error|Uncaught/);
      expect(body.trimEnd(), `${url} stopped part way`).toMatch(/<\/html>$/i);
    }
    // The version rows' API answers too.
    const status = await request.get('/api/system/status');
    expect(status.ok()).toBe(true);
    expect((await status.json()).advancedView?.Version).toMatch(/\d+\./);
  } finally {
    inPlayer('sh', '-c', all.map((n) => `rmdir /tmp/cache_${n}.cache_recalc 2>/dev/null`).join('; ') + '; true');
  }
});
