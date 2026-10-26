import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { keepingFile } from './privacy-helpers';
import { putFile } from './settings-file';

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
// `installed` stands in for the player's FPP version and OS image where a
// test needs other ones.
async function openWith(page: Page, request: APIRequestContext, baseURL: string, update: object, images: object[],
  installed: { Version?: string; OSVersion?: string } = {}) {
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
    // The header polls the same status: wait for the page's own answer to
    // have been read (where the page keeps it), or the list is compared
    // without it and the badge is not redrawn when it comes.
    const read = async () => {
      await status;
      for (let i = 0; i < 50; i++) {
        if (await page.evaluate(() => !!(window as any).currentOSRelease).catch(() => true)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    await Promise.race([read(), new Promise((r) => setTimeout(r, 10_000))]);
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
    json.advancedView.OSVersion = installed.OSVersion ?? 'v2026-01 (64bit)';
    if (installed.Version) json.advancedView.Version = installed.Version;
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

test('a later image of the installed month is an OS upgrade', async ({ page, request, baseURL }) => {
  // Regression: 67b52a112 ("offer a later OS image of the same month
  // (2026-10b)").  With the version the same, only a later month counted: a
  // player on the month's first image saw "Up to Date" next to its "b"
  // rebuild, and one on the "b" next to a "c".
  const on = (OSVersion: string) => ({ Version: '98.3', OSVersion });
  const badge = page.locator('#osVersionStatusBadge');
  await openWith(page, request, baseURL!, UP_TO_DATE, [image('Pi64-98.3_2098-10b.fppos')], on('v2098-10 (64bit)'));
  await expect(badge, 'the month\'s second image was not offered over its first').toHaveText('Upgrade Available');
  await openWith(page, request, baseURL!, UP_TO_DATE, [image('Pi64-98.3_2098-10c.fppos')], on('v2098-10b (64bit)'));
  await expect(badge, 'the month\'s third image was not offered over its second').toHaveText('Upgrade Available');
  // The controls: the image installed, and an earlier one, are not.
  await openWith(page, request, baseURL!, UP_TO_DATE, [image('Pi64-98.3_2098-10b.fppos')], on('v2098-10b (64bit)'));
  await expect(badge).toHaveText('Up to Date');
  await openWith(page, request, baseURL!, UP_TO_DATE, [image('Pi64-98.3_2098-10.fppos')], on('v2098-10b (64bit)'));
  await expect(badge).toHaveText('Up to Date');
  // And the list puts the month's later images first.
  await openWith(page, request, baseURL!, UP_TO_DATE, [
    image('Pi64-98.3_2098-10b.fppos'), image('Pi64-98.3_2098-10.fppos'), image('Pi64-98.3_2098-10c.fppos'),
  ], on('v2098-10 (64bit)'));
  expect(await offered(page)).toEqual(['Pi64-98.3_2098-10c.fppos', 'Pi64-98.3_2098-10b.fppos', 'Pi64-98.3_2098-10.fppos']);
});

test('a player offered a newer release can still update the version it runs', async ({ page, request, baseURL }) => {
  // Feature: 9f67a2bcf ("let a player update its own version when a newer one
  // is offered").  With a newer release offered the card offered only that
  // release, and on a major upgrade only the disabled "Use OS Upgrade".
  const fixes = { currentBranch: 'v98.3', commitUpdateAvailable: true, remoteCommit: 'def4567890' };
  const branchUpgrade = { ...UP_TO_DATE, branchUpgradeAvailable: true, branchUpgradeTarget: 'v98.4', branchUpgradeVersion: '98.4' };
  const button = page.locator('#fppBranchUpdateButton');
  for (const [name, update] of [['a newer release', branchUpgrade], ['a newer major', MAJOR_UPGRADE]] as const) {
    // The control: with nothing new on the installed branch there is no such button.
    await openWith(page, request, baseURL!, { ...update, currentBranch: 'v98.3' }, []);
    await expect(button, name).toBeHidden();
    await openWith(page, request, baseURL!, { ...update, ...fixes }, []);
    await expect(button, `${name}: no way to update the installed version`).toBeVisible();
    await expect(button).toHaveText('Update to latest v98.3');
    await expect(page.locator('#fppCard'), `${name}: the FPP card is faded`).not.toHaveClass(/is-disabled/);
  }
  // The button runs the in-place update a commit-only update runs: no new
  // branch or version for it to move to.  (The update itself is answered
  // here; it would pull from GitHub.)
  const started: string[] = [];
  await page.route('**/manualUpdate.php*', async (route) => {
    started.push(`${route.request().method()} ${new URL(route.request().url()).search} ${route.request().postData() ?? ''}`);
    await route.fulfill({ contentType: 'text/plain', body: 'fpp-tests: the update stands in here\n' });
  });
  await button.click();
  await expect.poll(() => started).toEqual(['POST ?wrapped=1 ']);
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

test("an FPP update's dialog title says which stage it is at", async ({ page, request, baseURL }) => {
  // Feature: 2d8508db0 ("provide status in 'pop-up box' title for FPP
  // upgrades").  The update itself is answered here (a real one pulls from
  // GitHub and builds); its stage lines are the ones the tree's own
  // scripts/git_pull declares, as the real stream carries them.
  const stages = inPlayer('sh', '-c', "sed -n 's/^ *logStage \"\\(.*\\)\"$/\\1/p' /opt/fpp/scripts/git_pull")
    .split('\n').filter((l) => l).map((l) => l.replace('${GITBRANCH}', 'master'));
  expect(stages, 'the control: git_pull declares its stages').toContain('Building FPP (longest step, please wait)');
  await openWith(page, request, baseURL!, COMMIT_UPDATE, []);
  await page.route('**/manualUpdate.php*', (route) => route.fulfill({
    contentType: 'text/plain',
    body: stages.map((st) => `===== ${st} =====\nfpp-tests: working\n`).join('') + '==========\n',
  }));
  await page.locator('#fppUpdateButton').click();
  await expect(page.locator('#fppUpgrade .modal-title')).toHaveText(`FPP Upgrade — ${stages[stages.length - 1]}`, { timeout: 15_000 });
});

test("an OS upgrade's dialog title says which stage it is at", async ({ page, request, baseURL }) => {
  // Feature: a2e7ea58f ("provide status in 'pop-up box' title for FPPOS
  // upgrades").  The real upgradeOS.php runs, with its OS-writing script
  // (upgradeOS-part1.sh) stood in for by one that declares the stage the
  // real one is at during the copy and then fails, so nothing is written
  // and nothing reboots.  The image is a small local file.
  const SD = '/opt/fpp/SD';
  const IMAGE = 'Pi64-98.9_2098-11.fppos';
  inPlayer('sh', '-c', `set -e; mv ${SD} ${SD}.fpp-tests-orig; cp -aL ${SD}.fpp-tests-orig ${SD}
    printf '#!/bin/sh\\necho "===== Updating root filesystem (longest step, please wait) ====="\\nexit 1\\n' > ${SD}/upgradeOS-part1.sh
    chmod 755 ${SD}/upgradeOS-part1.sh`);
  putFile(`/home/fpp/media/upload/${IMAGE}`, 'fpp-tests image');
  try {
    await keepingFile('/home/fpp/media/logs/fpp_system_upgrades.log', async () => {
      await openWith(page, request, baseURL!, UP_TO_DATE, [image(IMAGE, { downloaded: true })]);
      const select = page.locator('#osSelect');
      await select.selectOption(await select.locator('option', { hasText: IMAGE }).getAttribute('value'));
      page.once('dialog', (d) => d.accept());
      await page.locator('#osUpgradeButton').click();
      const title = page.locator('#osUpgrade .modal-title');
      await expect(title).toHaveText('FPP OS Upgrade — Upgrade Failed', { timeout: 60_000 });
      // The stages came from upgradeOS.php and the script it ran.
      const log = await page.locator('#osUpgradeText').inputValue();
      expect(log).toContain('===== Applying OS image =====');
      expect(log).toContain('===== Updating root filesystem (longest step, please wait) =====');
    });
  } finally {
    inPlayer('sh', '-c', `rm -rf ${SD} && mv ${SD}.fpp-tests-orig ${SD}; rm -f /home/fpp/media/upload/${IMAGE} /home/fpp/media/tmp/upgradeOS-part1.sh`);
  }
});

test('an FAQ answer opens to its whole height, and opening another closes it', async ({ page, request, baseURL }) => {
  // Regression: 7098ee433 ("Fix FAQ reveal: drive max-height from JS
  // instead of grid rows").  At a phone's width the answers are tall.
  await page.setViewportSize({ width: 390, height: 900 });
  await openWith(page, request, baseURL!, UP_TO_DATE, []);
  const items = page.locator('#upgradeFaq .fpp-faq__item');
  const count = await items.count();
  expect(count, 'the control: there is an FAQ').toBeGreaterThan(1);
  const shown = (i: number) => items.nth(i).locator('.fpp-faq__answer').evaluate((a) => a.getBoundingClientRect().height);
  const full = (i: number) => items.nth(i).locator('.fpp-faq__answer-inner').evaluate((a) => a.getBoundingClientRect().height);
  for (let i = 0; i < count; i++) {
    const open = await items.nth(i).getAttribute('class');
    if (!/fpp-faq__item--open/.test(open ?? '')) await items.nth(i).locator('.fpp-faq__question').click();
    await page.waitForTimeout(600);
    expect(Math.round(await shown(i)), `answer ${i + 1} is cut short`).toBeGreaterThanOrEqual(Math.floor(await full(i)));
    for (let j = 0; j < count; j++) {
      if (j !== i) expect(await shown(j), `answer ${j + 1} stayed open`).toBe(0);
    }
  }
});

test('the OS fields shimmer until the status answers, and read "--" if it never does', async ({ page }) => {
  // Feature: 7a40e720c ("Add skeleton shimmer for async-populated version
  // fields").  The fields showed "--" while they loaded, the same as for a
  // value that is not there.
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/system/status*', async (route) => {
    await held;
    await route.fulfill({ status: 500, body: '' });
  });
  await page.route('**/api/system/updateStatus*', (route) => route.fulfill({ json: UP_TO_DATE }));
  await page.goto('/about.php');
  for (const id of ['#osVersionValue', '#osReleaseValue', '#kernelValue', '#osCurrentVersionBadge']) {
    await expect(page.locator(`${id} .fpp-skeleton`), `${id} while loading`).toHaveCount(1);
  }
  release();
  for (const id of ['#osVersionValue', '#osReleaseValue', '#kernelValue', '#osCurrentVersionBadge']) {
    await expect(page.locator(id), `${id} once the status failed`).toHaveText('--', { timeout: 15_000 });
    await expect(page.locator(`${id} .fpp-skeleton`)).toHaveCount(0);
  }
});

test('picking an OS image brings the OS card forward, and clearing it fades it again', async ({ page, request, baseURL }) => {
  // Feature: cf348d1cd ("Un-fade the OS card and button when a user selects
  // an image").  With an FPP update the recommended path, the OS card is
  // faded back; a chosen image is still the user's to apply.
  await openWith(page, request, baseURL!, COMMIT_UPDATE, [image('Pi64-99.0_2099-01.fppos')]);
  const card = page.locator('#osCard');
  const opacity = () => card.evaluate((c) => parseFloat(getComputedStyle(c).opacity));
  await expect(card).not.toHaveClass(/is-engaged/);
  const select = page.locator('#osSelect');
  await select.selectOption(await select.locator('option', { hasText: 'Pi64-99.0_2099-01.fppos' }).getAttribute('value'));
  await expect(card).toHaveClass(/is-engaged/);
  await expect.poll(opacity).toBe(1);
  await select.selectOption('');
  await expect(card).not.toHaveClass(/is-engaged/);
});

test('the installed OS image is named on the OS card', async ({ page, request, baseURL }) => {
  // Feature: a46d3b8d2 ("added current OS label to system-upgrade.php").
  await openWith(page, request, baseURL!, UP_TO_DATE, [], { OSVersion: 'v2098-07 (64bit)' });
  await expect(page.locator('#osCard #osCurrentVersionBadge')).toHaveText('v2098-07 (64bit)');
});

test("at Advanced the cards' when-to-use notes fold away, and Version Information comes first", async ({ page, request, baseURL }) => {
  // Feature: e812ac606 ("Tighten system upgrade page layout and improve
  // advanced UI", #2637).
  for (const [level, folded] of [['1', true], ['0', false]] as const) {
    await setUiLevel(request, level);
    await openWith(page, request, baseURL!, UP_TO_DATE, []);
    for (const id of ['#fppCard', '#osCard']) {
      const note = page.locator(`${id} .fpp-info-box__title`, { hasText: 'When to use' });
      if (folded) {
        await expect(page.locator(`${id} details.fpp-info-collapsible`), `${id} at uiLevel ${level}`).toHaveCount(1);
        await expect(note).toBeHidden();
        await page.locator(`${id} .fpp-info-collapsible__summary`).click();
        await expect(note).toBeVisible();
      } else {
        await expect(page.locator(`${id} details.fpp-info-collapsible`), `${id} at uiLevel ${level}`).toHaveCount(0);
        await expect(note).toBeVisible();
      }
    }
    const order = await page.evaluate(() => {
      const heads = Array.from(document.querySelectorAll('h1, h2, h3, h4')).filter((e) => /^\s*Version Information\s*$/.test(e.textContent || ''));
      const card = document.getElementById('fppCard');
      return heads.length && card ? !!(heads[0].compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) : null;
    });
    expect(order, 'Version Information is not ahead of the upgrade cards').toBe(true);
  }
});
