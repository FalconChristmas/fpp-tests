import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';
import { FakeGitHub, StandIn, release } from './standin-http';
import { SecondPlayer } from './second-player';

// The OS image list: GET /api/git/releases/os and the OS upgrade select it
// fills.  GitHub's release list is answered by a stand-in in the player
// (standin-http.ts), and the player is made a 64-bit Raspberry Pi (Pi64
// images) by its /etc/fpp/platform for the length of each test.

test.skip(!container, 'stubs GitHub inside the run-web.sh container');

const RELEASES = '/repos/FalconChristmas/fpp/releases';
const PLATFORM = '/etc/fpp/platform';

let gh: FakeGitHub;

test.beforeEach(() => {
  inPlayer('sh', '-c', `echo 'Raspberry Pi' > ${PLATFORM}`);
  gh = new FakeGitHub();
  gh.start();
});

test.afterEach(() => {
  gh?.stop();
  inPlayer('rm', '-f', PLATFORM);
});

async function osList(request: APIRequestContext) {
  const r = await request.get('/api/git/releases/os', { timeout: 60_000 });
  expect(r.ok(), await r.text()).toBe(true);
  return r.json();
}

// The page with the OS upgrade select: system-upgrade.php while it existed
// (Apr-May 2026), about.php before and since.
async function openOSUpgrade(page: Page, baseURL: string) {
  const reworked = (await page.request.get('/system-upgrade.php')).status() === 200;
  const origin = new URL(baseURL).origin;
  // Nothing from the page leaves for the internet.
  await page.route((url) => url.origin !== origin, (route) => route.abort());
  await page.goto(reworked ? '/system-upgrade.php' : '/about.php');
  await expect(page.locator('#osSelect')).toBeAttached();
}

async function osOptions(page: Page) {
  // Filled by PopulateOSSelect() once the list answers.
  await expect.poll(() => gh.requests().some((r) => r.path.startsWith(RELEASES)), { timeout: 30_000 }).toBe(true);
  await page.waitForTimeout(1000);
  return page.locator('#osSelect option').evaluateAll((os) => os.map((o) => o.textContent!.trim()).filter((t) => /\.fppos/.test(t)));
}

test('a 64-bit Pi is offered the 64-bit Pi images, marked or not, and no 32-bit ones', async ({ page, request, baseURL }) => {
  // Regression: 0f610d496.  Images were matched on the "<OSImagePrefix>-"
  // name prefix alone, so a Pi64 player was offered a Pi64- image marked
  // 32-bit and never a Pi- image marked 64-bit.
  gh.routes({
    [RELEASES]: {
      json: [release('10.5', ['Pi64-10.5.fppos', 'Pi-10.5-arm64.fppos', 'Pi64-10.5-armhf.fppos', 'Pi-10.5.fppos', 'BBB-10.5.fppos', 'BB64-10.5.fppos'])],
    },
  });
  const list = await osList(request);
  expect(gh.requests().map((r) => r.path)).toContain(`${RELEASES}?per_page=100`);
  expect(list.files.map((f: any) => f.filename).sort()).toEqual(['Pi-10.5-arm64.fppos', 'Pi64-10.5.fppos']);
  // The receiving end: the OS upgrade select offers those two and no others.
  gh.clearLog();
  await openOSUpgrade(page, baseURL!);
  const offered = (await osOptions(page)).map((o) => o.replace(/ .*/, '')).sort();
  expect(offered).toEqual(['Pi-10.5-arm64.fppos', 'Pi64-10.5.fppos']);
});

test.describe('nightly images', () => {
  let uiLevel = '0';
  test.beforeEach(async ({ request }) => {
    uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
  });
  test.afterEach(async ({ request }) => {
    await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
  });

  test('are offered for an OS upgrade at the Developer UI level only', async ({ page, request, baseURL }) => {
    // Regression: a34258db7.  The OS upgrade select listed GitHub's nightly
    // (prerelease) images at every UI level.
    gh.routes({
      [RELEASES]: {
        json: [
          release('nightly', ['Pi64-nightly_2026-10.fppos'], { prerelease: true, name: 'FPP Nightly' }),
          release('10.5', ['Pi64-10.5.fppos']),
        ],
      },
    });
    for (const [level, nightly] of [['0', false], ['1', false], ['3', true]] as const) {
      expect((await request.put('/api/settings/uiLevel', { data: level })).ok()).toBe(true);
      gh.clearLog();
      await openOSUpgrade(page, baseURL!);
      const options = await osOptions(page);
      // The control: the release image is listed at every level.
      expect(options.some((o) => o.startsWith('Pi64-10.5.fppos')), `uiLevel ${level}: ${options}`).toBe(true);
      expect(options.some((o) => o.startsWith('Pi64-nightly')), `uiLevel ${level}: ${options}`).toBe(nightly);
    }
  });
});

test.describe('an Upgrade Source mirror', () => {
  const IMAGE = 'Pi64-10.4_2026-09.fppos';

  test('lists its OS images when GitHub is unreachable (IPv4)', async ({ request }) => {
    // Regression: 00e1f976f (#2720).  The OS list came from GitHub only: an
    // Upgrade Source mirror's images were never listed, and with GitHub
    // unreachable the list was an error.  The mirror is a second real player
    // (second-player.ts) with the images in its uploads, and the URL listed
    // for one is fetched from this player: it is that image.
    test.setTimeout(240_000);
    gh.routes({ [RELEASES]: { status: 502, json: { message: 'Bad Gateway' } } });
    const mirror = new SecondPlayer('mirror').start();
    try {
      mirror.sh(`cd /home/fpp/media/upload && printf 'fpp-tests image bytes' > ${IMAGE} && printf x > BBB-10.4_2026-09.fppos && printf x > notes.txt`);
      await keepingSettings(async () => {
        setSettingInFile('UpgradeSource', mirror.address);
        const list = await osList(request);
        expect(list.status, JSON.stringify(list)).toBe('OK');
        const url = `http://${mirror.address}/api/file/uploads/${IMAGE}`;
        expect(list.files.map((f: any) => [f.filename, f.source, f.url])).toEqual([[IMAGE, mirror.address, url]]);
        expect(inPlayer('curl', '-sf', '--max-time', '20', url)).toBe('fpp-tests image bytes');
      });
    } finally {
      const verdict = mirror.stop();
      expect.soft(verdict.ok, verdict.detail).toBe(true);
    }
  });

  test('lists its OS images when GitHub is unreachable (IPv6)', async ({ request }) => {
    // Regression: 202c1a7e4.  An IPv6 literal Upgrade Source went into the
    // mirror's URLs unbracketed (http://::1/api/...), which no client can
    // parse, so its images were never listed.  The Docker network gives a
    // container no IPv6 address, so this mirror is a stand-in on the player's
    // own ::1; it is asked for the same /api/files/uploads a real player
    // answers in the IPv4 test.
    gh.routes({ [RELEASES]: { status: 502, json: { message: 'Bad Gateway' } } });
    const mirror = new StandIn('mirror', '::1', 80, {
      '/api/files/uploads': { json: { files: [{ name: IMAGE, sizeBytes: 5 }, { name: 'BBB-10.4_2026-09.fppos', sizeBytes: 5 }, { name: 'notes.txt', sizeBytes: 1 }] } },
    });
    try {
      mirror.start();
      await keepingSettings(async () => {
        setSettingInFile('UpgradeSource', '::1');
        const list = await osList(request);
        expect(mirror.requests().map((r) => [r.host, r.path])).toContainEqual(['[::1]', '/api/files/uploads']);
        expect(list.status, JSON.stringify(list)).toBe('OK');
        expect(list.files.map((f: any) => [f.filename, f.source, f.url])).toEqual([
          [IMAGE, '::1', `http://[::1]/api/file/uploads/${IMAGE}`],
        ]);
      });
    } finally {
      mirror.stop();
    }
  });
});

test.describe('release notes', () => {
  const TAGS = '/repos/FalconChristmas/fpp/releases/tags';

  test('are fetched through this player, for the release the image belongs to', async ({ page, request, baseURL }) => {
    // Regression: bef7170d7.  The About page fetched release notes from
    // api.github.com itself, which the UI's CSP refuses (and leaks the
    // browser's address to GitHub), and took the tag from the image's file
    // name, so a 10.5.3 image asked for a "10.5.3" release that doesn't exist
    // (GitHub tags it 10.5).  GET /api/git/releases/notes/<tag> proxies it.
    gh.routes({
      [RELEASES]: { json: [release('10.5', ['Pi64-10.5.3_2026-10.fppos'])] },
      [`${TAGS}/10.5`]: { json: { ...release('10.5', []), name: 'FPP v10.5', body: 'fpp-tests release notes for **10.5**' } },
    });

    // The page.
    const external: string[] = [];
    page.on('requestfailed', (q) => {
      if (new URL(q.url()).origin !== new URL(baseURL!).origin) external.push(q.url());
    });
    await openOSUpgrade(page, baseURL!);
    const option = page.locator('#osSelect option', { hasText: 'Pi64-10.5.3_2026-10.fppos' });
    await expect(option).toBeAttached({ timeout: 30_000 });
    await page.selectOption('#osSelect', await option.getAttribute('value'));
    gh.clearLog();
    await page.evaluate('ViewOSReleaseNotes()');
    const body = page.locator('#osReleaseNotesModal .modal-body');
    await expect(body).toContainText('fpp-tests release notes', { timeout: 15_000 });
    expect(gh.requests().map((q) => q.path)).toContain(`${TAGS}/10.5`);
    expect(external.filter((u) => u.includes('github')), external.join('\n')).toEqual([]);

    // The API: a known tag, an unknown one, and one that is no tag at all.
    let r = await request.get('/api/git/releases/notes/10.5');
    expect(r.status(), await r.text()).toBe(200);
    expect((await r.json()).body).toContain('fpp-tests release notes');
    r = await request.get('/api/git/releases/notes/9.9');
    expect(r.status()).toBe(404);
    gh.clearLog();
    r = await request.get(`/api/git/releases/notes/${encodeURIComponent('10.5;x')}`);
    expect(r.status()).toBe(400);
    expect(gh.requests().filter((q) => q.path.startsWith(TAGS))).toEqual([]);
  });
});
