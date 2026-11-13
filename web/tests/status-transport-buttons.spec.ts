import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// The status page's player buttons, pressed against the player's own fppd:
// Next and Previous, Stop Gracefully (the entry playing finishes, then the
// lead-out plays), Stop After Loop, Stop Now and Repeat.  The entries are
// short pauses: nothing is shown or heard, and the playlist is stopped after.

const NAME = 'fpp-tests-transport';
const pause = (duration: number) => ({ type: 'pause', enabled: 1, playOnce: 0, duration });

async function store(request: APIRequestContext, main: object[], leadOut: object[] = []) {
  const r = await request.post(`/api/playlist/${NAME}`, { data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0,
    leadIn: [], mainPlaylist: main, leadOut, playlistInfo: {} } });
  expect(r.ok()).toBe(true);
}
test.afterEach(async ({ request }) => {
  await request.post('/api/playlists/stop');
  await request.delete(`/api/playlist/${NAME}`);
});

const status = async (request: APIRequestContext) => (await (await request.get('/api/fppd/status')).json());
const index = async (request: APIRequestContext) => {
  const s = await status(request);
  return s.current_playlist?.playlist === NAME ? s.current_playlist.index : 'idle';
};

// Pick the playlist and press Play, with Repeat as asked; wait for fppd.
async function play(page: Page, request: APIRequestContext, repeat = false) {
  await page.goto('/index.php');
  await expect(page.locator(`#playlistSelect option[value="${NAME}"]`)).toHaveCount(1, { timeout: 15_000 });
  await page.selectOption('#playlistSelect', NAME);
  await page.locator('#chkRepeat').setChecked(repeat);
  await page.locator('#btnPlay').click();
  await expect.poll(() => index(request), { timeout: 15_000 }).toBe('1');
}

// Every entry fppd reports, in order, until it is idle (or the time is up).
async function watch(request: APIRequestContext, ms: number) {
  const seen: string[] = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const i = await index(request);
    if (seen[seen.length - 1] !== i) seen.push(i);
    if (i === 'idle') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return seen;
}

test('Next and Previous move fppd to the next and the previous entry', async ({ page, request }) => {
  await store(request, [pause(300), pause(301), pause(302)]);
  await play(page, request);
  await page.locator('#btnNext').click();
  await expect.poll(() => index(request), { timeout: 10_000 }).toBe('2');
  await page.locator('#btnNext').click();
  await expect.poll(() => index(request), { timeout: 10_000 }).toBe('3');
  await page.locator('#btnPrev').click();
  await expect.poll(() => index(request), { timeout: 10_000 }).toBe('2');
  // The page follows: the row playing is the one fppd plays.
  await expect(page.locator('#playlistRow2')).toHaveClass(/PlaylistRowPlaying/, { timeout: 10_000 });
});

test('Stop Gracefully lets the entry playing finish, then plays the lead-out and stops', async ({ page, request }) => {
  // Main: 1 (4 s), 2 (4 s); lead-out: 3 (2 s).  Pressed during 1, entry 2 is skipped.
  await store(request, [pause(4), pause(4)], [pause(2)]);
  await play(page, request);
  await page.locator('#btnStopGracefully').click();
  // Still on entry 1 right after: it is let finish.
  await page.waitForTimeout(1000);
  expect(await index(request)).toBe('1');
  expect(await watch(request, 20_000)).toEqual(['1', '3', 'idle']);
});

test('Stop After Loop finishes the loop it is in, repeat or not, then the lead-out', async ({ page, request }) => {
  await store(request, [pause(2), pause(2)], [pause(2)]);
  await play(page, request, true);
  expect(String((await status(request)).repeat_mode), 'the control: Repeat was sent').toMatch(/^(1|true)$/);
  await page.locator('#btnStopGracefullyAfterLoop').click();
  // Pressed during entry 1: 2 still plays, then the lead-out, then no new loop.
  expect(await watch(request, 20_000)).toEqual(['1', '2', '3', 'idle']);
});

test('Repeat plays the playlist again, and unticked it stops at the end', async ({ page, request }) => {
  await store(request, [pause(2), pause(2)]);
  await play(page, request, true);
  // Through 2 and back to 1.
  await expect.poll(() => index(request), { timeout: 10_000 }).toBe('2');
  await expect.poll(() => index(request), { timeout: 10_000 }).toBe('1');
  await page.locator('#btnStopNow').click();
  await expect.poll(() => index(request), { timeout: 5_000 }).toBe('idle');

  await play(page, request, false);
  expect(await watch(request, 15_000)).toEqual(['1', '2', 'idle']);
});

test('Stop Now stops at once, in the middle of an entry', async ({ page, request }) => {
  await store(request, [pause(300)], [pause(300)]);
  await play(page, request);
  await page.locator('#btnStopNow').click();
  await expect.poll(() => index(request), { timeout: 3_000 }).toBe('idle');
  // The page shows it: Play is offered again and Stop is not.
  await expect(page.locator('#btnPlay')).toBeEnabled({ timeout: 10_000 });
});

test('a stop the player refuses is reported, not silently dropped', async ({ page, request }) => {
  // StopNow / StopGracefully / Next / Previous post with an empty .fail():
  // with fppd busy or gone, the press does nothing and the page says nothing,
  // while the show plays on.
  await store(request, [pause(300)]);
  await play(page, request);
  await page.route('**/api/playlists/stop', (r) => r.fulfill({ status: 500, body: 'fpp-tests: refused' }));
  await page.locator('#btnStopNow').click();
  await expect(page.locator('#jGrowl .jGrowl-notification, .modal.show').filter({ hasText: /stop|fail|unable/i }).first())
    .toBeVisible({ timeout: 5_000 });
});
