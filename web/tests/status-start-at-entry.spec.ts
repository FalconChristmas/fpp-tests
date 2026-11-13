import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// The status page's "start from here": a click on a row of the playlist's
// details picks it, and Play starts the playlist at that entry (Start
// Playlist At Item).  fppd counts the entries from the first lead-in, so
// the row picked has to be the entry fppd plays, after a lead-in and deep
// into a long playlist.  The entries are pauses: nothing is shown or heard,
// and the playlist is stopped after.

const NAME = 'fpp-tests-start-at';
const pause = (duration: number) => ({ type: 'pause', enabled: 1, playOnce: 0, duration });

async function store(request: APIRequestContext, leadIn: object[], main: object[], leadOut: object[] = []) {
  const r = await request.post(`/api/playlist/${NAME}`, { data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0,
    leadIn, mainPlaylist: main, leadOut, playlistInfo: {} } });
  expect(r.ok()).toBe(true);
}
test.afterEach(async ({ request }) => {
  await request.post('/api/playlists/stop');
  await request.delete(`/api/playlist/${NAME}`);
});

const playing = async (request: APIRequestContext) =>
  (await (await request.get('/api/fppd/status')).json()).current_playlist as { playlist: string; index: string; count: string };

async function startAt(page: Page, request: APIRequestContext, row: number) {
  await page.goto('/index.php');
  await expect(page.locator(`#playlistSelect option[value="${NAME}"]`)).toHaveCount(1, { timeout: 15_000 });
  await page.selectOption('#playlistSelect', NAME);
  const r = page.locator(`#tblPlaylistDetails #playlistRow${row}`);
  await expect(r).toBeVisible({ timeout: 15_000 });
  await r.scrollIntoViewIfNeeded();
  await r.click();
  await expect(r).toHaveClass(/playlistSelectedEntry/);
  await page.locator('#btnPlay').click();
  await expect.poll(async () => (await playing(request)).playlist, { timeout: 15_000 }).toBe(NAME);
  return playing(request);
}

test('the main entry picked after a lead-in is the one fppd plays', async ({ page, request }) => {
  // Durations tell the entries apart in the rows: 101, 102, 103 s in the main section.
  await store(request, [pause(100)], [pause(101), pause(102), pause(103)], [pause(104)]);
  // Row 3 is the second main entry (lead-in 1, main 2, 3, 4).
  const now = await startAt(page, request, 3);
  expect(now.index).toBe('3');
  await expect(page.locator('#playlistRow3')).toHaveClass(/PlaylistRowPlaying/, { timeout: 10_000 });
});

test('entry 110 of a 120-entry playlist is the one fppd plays', async ({ page, request }) => {
  await store(request, [], Array.from({ length: 120 }, (_, i) => pause(200 + i)));
  const now = await startAt(page, request, 110);
  expect(now).toMatchObject({ index: '110', count: '120' });
});
