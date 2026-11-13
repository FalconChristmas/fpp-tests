import { test, expect } from './fixtures';
import { devices } from '@playwright/test';
import type { Page } from '@playwright/test';

// A phone, which is how many people start and stop their show from the
// yard: the status page's player controls are on screen, not covered, and
// a tap starts the playlist picked; the collapsed menu opens and goes to
// a page; and the pages people use most do not scroll sideways.  The start
// command is answered here, so nothing plays.

const { defaultBrowserType, ...phone } = devices['iPhone 13'];
test.use({ ...phone });

const NAME = 'fpp-tests-phone';

test.beforeEach(async ({ request }) => {
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], leadOut: [], playlistInfo: {},
            mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 30 }] },
  });
  expect(r.ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
  await request.delete(`/api/playlist/${NAME}`);
});

// The element a tap at the centre of `sel` lands on is `sel` or inside it.
async function tappable(page: Page, sel: string) {
  const el = page.locator(sel);
  await el.scrollIntoViewIfNeeded();
  const box = (await el.boundingBox())!;
  const vw = page.viewportSize()!.width;
  expect(box.x, `${sel} starts off the left of the screen`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${sel} runs off the right of the screen`).toBeLessThanOrEqual(vw + 1);
  // A disabled Bootstrap button takes no pointer events (Stop while idle):
  // on screen is all that can be asked of it.
  if (await el.isDisabled()) return;
  const hit = await page.evaluate(([s, x, y]) => {
    const target = document.querySelector(s as string)!;
    const at = document.elementFromPoint(x as number, y as number);
    if (at && (at === target || target.contains(at))) return '';
    return at ? at.outerHTML.slice(0, 160) : 'nothing';
  }, [sel, box.x + box.width / 2, box.y + box.height / 2]);
  expect(hit, `${sel} is covered by`).toBe('');
}

test('the player controls are on screen and a tap on Play starts the playlist picked', async ({ page }) => {
  const sent: any[] = [];
  await page.route('**/api/command', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    sent.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({ json: { status: 'OK' } });
  });
  await page.goto('/index.php');
  const select = page.locator('#playlistSelect');
  await expect(select.locator(`option[value="${NAME}"]`)).toHaveCount(1, { timeout: 15_000 });
  await select.selectOption(NAME);
  for (const b of ['#playlistSelect', '#btnPlay', '#btnStopGracefully', '#btnStopNow']) await tappable(page, b);
  await page.locator('#btnPlay').tap();
  await expect.poll(() => sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ command: 'Start Playlist At Item', args: [NAME, expect.anything(), false, false, expect.anything()] });
});

test('the collapsed menu opens and takes you to a page', async ({ page }) => {
  await page.goto('/index.php');
  const toggler = page.locator('.navbar-toggler').first();
  await expect(toggler).toBeVisible();
  await tappable(page, '.navbar-toggler');
  await toggler.tap();
  const content = page.locator('#navbarDropdownMenuLinkContent');
  await expect(content).toBeVisible();
  await content.tap();
  const playlists = page.locator('a[href="playlists.php"]').first();
  await expect(playlists).toBeVisible();
  await playlists.tap();
  await expect(page).toHaveURL(/playlists\.php/);
});

test('a schedule entry can be added and saved by tapping', async ({ page, request }) => {
  const before = await (await request.get('/api/schedule')).json();
  try {
    await page.goto('/scheduler.php');
    await expect(page.locator('.fppTableRowTemplate .schPlaylist option', { hasText: NAME })).toHaveCount(1);
    const rows = page.locator('#tblScheduleBody > tr');
    const n = await rows.count();
    const add = page.locator('[onclick="AddScheduleEntry();"]:visible').first();
    await tappable(page, '[onclick="AddScheduleEntry();"]');
    await add.tap();
    await expect(rows).toHaveCount(n + 1);
    const row = rows.nth(n);
    await row.locator('.schPlaylist').selectOption(NAME);
    await row.locator('.schStartTime').fill('18:30:00');
    await row.locator('.schEndTime').fill('22:00:00');
    const save = page.locator("input[value='Save'][onclick*='SaveSchedule']").first();
    await save.scrollIntoViewIfNeeded();
    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/schedule');
    await save.tap();
    expect((await posted).ok()).toBe(true);
    const saved: any[] = await (await request.get('/api/schedule')).json();
    expect(saved[n]).toMatchObject({ playlist: NAME, startTime: '18:30:00', endTime: '22:00:00' });
  } finally {
    await request.post('/api/schedule', { data: before });
    await request.post('/api/schedule/reload');
  }
});

test('a playlist entry can be added and the playlist saved by tapping', async ({ page, request }) => {
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).tap();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/, { timeout: 15_000 });
  await expect(page.locator('tr.playlistRow')).toHaveCount(1);
  const add = page.locator('.playlistEntriesAddNewBtn:visible').first();
  await add.scrollIntoViewIfNeeded();
  await add.tap();
  await page.selectOption('#pe_type', 'pause');
  const confirm = page.locator('.ui-dialog:visible button, .modal.show button', { hasText: /^Add$/ }).first();
  await expect(confirm).toBeInViewport();
  await confirm.tap();
  await expect(page.locator('tr.playlistRow')).toHaveCount(2);
  const save = page.locator('.savePlaylistBtn:visible').first();
  await save.scrollIntoViewIfNeeded();
  await save.tap();
  await expect.poll(async () => (await (await request.get(`/api/playlist/${NAME}`)).json()).mainPlaylist.length).toBe(2);
});

for (const path of ['/index.php', '/playlists.php', `/playlistEditor.php?playlist=${NAME}`, '/scheduler.php', '/filemanager.php', '/settings.php', '/about.php']) {
  test(`${path} does not scroll sideways on a phone`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(500);
    const [scroll, width] = await page.evaluate(() => [document.scrollingElement!.scrollWidth, window.innerWidth]);
    expect(scroll, `page is ${scroll}px wide on a ${width}px screen`).toBeLessThanOrEqual(width + 1);
  });
}
