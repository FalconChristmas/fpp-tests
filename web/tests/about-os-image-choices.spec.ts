import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile, setSettingInFile, snapshotSettings } from './settings-file';

// The About page's OS upgrade card, for what it offers beside GitHub's list:
// images already downloaded to the player, which prereleases each UI level
// sees, the options under the select, and the Upgrade Source picker.  The
// image list is answered by the test, as about-os-upgrade-states.spec.ts
// does, and the player is made a 64-bit Raspberry Pi by /etc/fpp/platform.

test.skip(!container, 'makes the run-web.sh container a Pi and seeds its uploads');

const PLATFORM = '/etc/fpp/platform';
const UPLOAD = '/home/fpp/media/upload';
const LOCAL = 'Pi64-99.0_2099-01.fppos';
let restore: () => void = () => undefined;

test.beforeEach(async ({ request }) => {
  restore = snapshotSettings();
  inPlayer('sh', '-c', `echo 'Raspberry Pi' > ${PLATFORM}`);
  setSettingInFile('initialSetup-02', '1');
  await setUiLevel(request, '0');
});

test.afterEach(() => {
  inPlayer('rm', '-f', PLATFORM, `${UPLOAD}/${LOCAL}`);
  restore();
});

async function setUiLevel(request: APIRequestContext, level: string) {
  expect((await request.put('/api/settings/uiLevel', { data: level })).ok()).toBe(true);
}

let assetId = 5150;
function image(filename: string, extra: Record<string, unknown> = {}) {
  const tag = filename.replace(/^[A-Za-z0-9]+-/, '').replace(/[_].*$/, '');
  return {
    tag, release_name: tag, filename, asset_id: ++assetId,
    url: `https://github.com/FalconChristmas/fpp/releases/download/${tag}/${filename}`,
    downloaded: false, size: 1, prerelease: false, ...extra,
  };
}

// Opens the About page with api/git/releases/os answering `list` and waits
// for the select to have been filled from it.
async function openWith(page: Page, baseURL: string, list: object) {
  const origin = new URL(baseURL).origin;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route((url) => url.origin !== origin, (route) => route.abort());
  let listed = false;
  await page.route('**/api/git/releases/os*', async (route) => {
    await route.fulfill({ json: list });
    listed = true;
  });
  await page.goto('/about.php');
  await expect.poll(() => listed, { timeout: 30_000 }).toBe(true);
  await page.waitForTimeout(1000);
}

async function offered(page: Page): Promise<string[]> {
  return page.locator('#osSelect option').evaluateAll((os) =>
    os.filter((o) => (o as HTMLOptionElement).value !== '').map((o) => o.textContent!.trim()));
}

test('an image already in the uploads is offered once, whether GitHub answers or not', async ({ page, baseURL }) => {
  // Regression: 313795901.  The select was filled from GitHub's list only
  // (fd7764166 had dropped the uploads' own images from it), so a player that
  // could not reach GitHub offered no image even with one downloaded.
  // Regression: f5c711cef.  The "is it already listed" check was a jQuery
  // object, always true, so the downloaded image was never added after all.
  putFile(`${UPLOAD}/${LOCAL}`, 'fpp-tests image');
  // What the API answers when GitHub cannot be reached.
  await openWith(page, baseURL!, { status: 'Error', message: 'Could not resolve host: api.github.com' });
  expect(await offered(page), 'the downloaded image was not offered').toEqual([LOCAL]);
  // GitHub lists it too, as downloaded: still one entry.
  await openWith(page, baseURL!, { status: 'OK', downloaded: [LOCAL], files: [image(LOCAL, { downloaded: true })] });
  expect(await offered(page)).toEqual([LOCAL]);
});

test('upgrading to an image already downloaded upgrades from the file, not the download URL', async ({ page, request, baseURL }) => {
  // Regression: 03360a8a7.  UpgradeOS() always sent GitHub's URL, so
  // upgradeOS.php downloaded an image the player already had all over again.
  putFile(`${UPLOAD}/${LOCAL}`, 'fpp-tests image');
  const listed = image(LOCAL, { downloaded: true });
  await openWith(page, baseURL!, { status: 'OK', downloaded: [LOCAL], files: [listed] });
  let sent = '';
  // (A function, not a glob: a glob's * stops at the slashes of a URL in the query.)
  await page.route((url) => url.pathname.endsWith('/upgradeOS.php'), (route) => {
    sent = route.request().url();
    return route.fulfill({ contentType: 'text/plain', body: 'fpp-tests: not upgrading\n' });
  });
  page.on('dialog', (d) => d.accept());
  await page.locator('#osSelect').selectOption(String(listed.asset_id));
  await expect(page.locator('#osUpgradeButton')).toBeEnabled();
  await page.locator('#osUpgradeButton').click();
  await expect.poll(() => sent).not.toBe('');
  expect(new URL(sent).searchParams.get('os'), 'the image was fetched again').toBe(LOCAL);
  // The receiving end: given a file name, upgradeOS.php reads the uploads
  // copy and downloads nothing.  (downloadOnly, so nothing is applied.)
  const out = await (await request.post(`/upgradeOS.php?wrapped=1&downloadOnly=1&os=${LOCAL}`)).text();
  expect(out).toContain(`Image: ${LOCAL}`);
  expect(out).not.toMatch(/Downloading OS image|wget/);
});

test('a beta image is offered from the Advanced level, even when GitHub does not flag it a prerelease', async ({ page, request, baseURL }) => {
  // Regression: fd7764166.  Alpha and beta images were offered at every UI
  // level; they are for Advanced and up.  (Not flagged a prerelease, so the
  // prerelease gate a9c5e89e4 added later does not hide it on its own.)
  const list = { status: 'OK', downloaded: [], files: [image('Pi64-99.0_2099-01.fppos'), image('Pi64-99.1-beta1_2099-02.fppos'), image('Pi64-99.2-alpha1_2099-03.fppos')] };
  await openWith(page, baseURL!, list);
  expect((await offered(page)).map((t) => t.replace(/ \(download\).*$/, '')), 'a beta was offered at Basic').toEqual(['Pi64-99.0_2099-01.fppos']);
  await setUiLevel(request, '1');
  await openWith(page, baseURL!, list);
  expect((await offered(page)).map((t) => t.replace(/ \(download\).*$/, '')).sort())
    .toEqual(['Pi64-99.0_2099-01.fppos', 'Pi64-99.1-beta1_2099-02.fppos', 'Pi64-99.2-alpha1_2099-03.fppos']);
});

test('Keep /opt/fpp is offered at the Developer level only, Show All Platforms from Advanced', async ({ page, request, baseURL }) => {
  // Regression: 36d02bcdc.  "Preserve /opt/fpp" -- an OS upgrade that leaves
  // the FPP version behind -- was shown to anyone on the master branch, at
  // any UI level.
  const list = { status: 'OK', downloaded: [], files: [image('Pi64-99.0_2099-01.fppos')] };
  for (const [level, allPlatforms, keep] of [['0', 0, 0], ['1', 1, 0], ['3', 1, 1]] as const) {
    await setUiLevel(request, level);
    await openWith(page, baseURL!, list);
    await expect(page.locator('#allPlatforms'), `uiLevel ${level}`).toHaveCount(allPlatforms);
    await expect(page.locator('#keepOptFPP'), `uiLevel ${level}`).toHaveCount(keep);
  }
});

test('an Upgrade Source that is not on the network right now is still shown as the one chosen', async ({ request }) => {
  // Regression: 347a81104 (#1626).  The picker listed github.com and the
  // MultiSync systems it could see; a chosen source that was switched off
  // was not among them, so the page showed github.com as the choice and the
  // next save of the picker replaced it.
  await setUiLevel(request, '1');
  setSettingInFile('UpgradeSource', '192.0.2.55');
  const html = await (await request.get('/about.php')).text();
  const select = /<select[^>]*id=['"]UpgradeSource['"][\s\S]*?<\/select>/.exec(html)?.[0] ?? '';
  expect(select, 'no Upgrade Source picker').not.toBe('');
  expect(select).toMatch(/<option value=['"]192\.0\.2\.55['"][^>]*selected[^>]*>\s*192\.0\.2\.55 \(Unreachable\)/);
  // The control: github.com is still there to switch back to.
  expect(select).toMatch(/<option value=['"]github\.com['"]/);
});
