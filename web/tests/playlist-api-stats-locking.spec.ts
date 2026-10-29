import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, docker, inPlayer } from './container';

// The playlist API's bookkeeping: the totals it keeps in playlistInfo and
// hands to the Playlists page through /api/playlists/validate, and the lock
// it takes on a playlist file while writing it.

const NAME = 'fpp-tests-api-stats';
const FILE = `/home/fpp/media/playlists/${NAME}.json`;

const pause = (duration: number) => ({ type: 'pause', enabled: 1, playOnce: 0, duration });

function playlist(extra: object = {}) {
  return { name: NAME, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], ...extra };
}

async function validated(request: APIRequestContext) {
  const all = await (await request.get('/api/playlists/validate')).json();
  const mine = all.find((p: { name: string }) => p.name === NAME);
  expect(mine, JSON.stringify(all)).toBeTruthy();
  return mine;
}

const status = async (request: APIRequestContext) => (await request.get('/api/fppd/status')).json();

test.afterEach(async ({ request }) => {
  await request.post('/api/playlists/stop');
  await request.delete(`/api/playlist/${NAME}`);
});

test('the playlists validate list carries each playlist\'s total duration and item count', async ({ page, request }) => {
  // Regression: 4ccca7e32.  /api/playlists/validate, which the Playlists
  // page builds its cards from, returned only the name, description and
  // validity: every card's Total Duration and Total Items were blank.
  const saved = await request.post(`/api/playlist/${NAME}`, {
    data: playlist({ mainPlaylist: [pause(30), pause(45)], playlistInfo: { total_duration: 75, total_items: 2 } }),
  });
  expect(saved.ok()).toBe(true);
  const mine = await validated(request);
  expect(mine).toMatchObject({ total_duration: 75, total_items: 2 });

  // The page's card shows them.
  await page.goto('/playlists.php');
  const card = page.locator('.playlistCard', { has: page.locator('h3', { hasText: new RegExp(`^${NAME}$`) }) });
  await expect(card).toContainText('Total Duration: 01:15');
  await expect(card).toContainText(/Total Items: 2\b/);
});

test('adding an item through the API keeps the playlist\'s per-section totals', async ({ page, request }) => {
  // Regression: 9db9424a7.  POST /api/playlist/<name>/<section>/item pushed
  // the entry and wrote the file back with the old playlistInfo: the
  // playlist kept its old item count and duration everywhere they show,
  // and the validate list had no per-section counts for the cards.
  const saved = await request.post(`/api/playlist/${NAME}`, {
    data: playlist({ version: 3, mainPlaylist: [pause(10)], playlistInfo: { total_duration: 10, total_items: 1 } }),
  });
  expect(saved.ok()).toBe(true);
  for (const [section, entry] of [['leadIn', pause(5)], ['mainPlaylist', pause(20)], ['leadOut', pause(7)]] as const) {
    const r = await request.post(`/api/playlist/${NAME}/${section}/item`, { data: entry });
    expect((await r.json()).Status, `adding to ${section}`).toBe('OK');
  }

  const stored = await (await request.get(`/api/playlist/${NAME}`)).json();
  expect(stored.playlistInfo).toMatchObject({
    leadIn_items: 1, leadIn_duration: 5,
    mainPlaylist_items: 2, mainPlaylist_duration: 30,
    leadOut_items: 1, leadOut_duration: 7,
    total_items: 4, total_duration: 42,
  });
  expect(stored.version).toBe(4);
  expect(await validated(request)).toMatchObject({
    total_items: 4, total_duration: 42, version: 4, leadIn_items: 1, mainPlaylist_items: 2, leadOut_items: 1,
  });

  // The card breaks the count down by section.
  await page.goto('/playlists.php');
  const card = page.locator('.playlistCard', { has: page.locator('h3', { hasText: new RegExp(`^${NAME}$`) }) });
  await expect(card).toContainText('Total Items: 4 (Lead In: 1, Main: 2, Lead Out: 1)');

  // The receiving end: fppd loads the file the API wrote and plays all of it.
  await request.post(`/api/playlist/${NAME}/start`);
  await expect.poll(async () => (await status(request)).current_playlist?.playlist, { timeout: 15_000 }).toBe(NAME);
  expect(Number((await status(request)).current_playlist.count)).toBe(4);
});

test.describe('file locking', () => {
  test.skip(!container, 'holds a lock on the playlist file inside the run-web.sh container');

  test('a playlist save waits for a lock on the file instead of rewriting it underneath', async ({ request }) => {
    // Regression: 9c5cb0f8d.  The playlist API wrote with fopen("w"), which
    // empties the file at once and takes no lock, so a reader holding the
    // file mid-read saw it empty or half written.  The save now takes an
    // exclusive lock (file_put_contents LOCK_EX) and waits for the reader.
    const old = playlist({ desc: 'before', mainPlaylist: [pause(1)] });
    expect((await request.post(`/api/playlist/${NAME}`, { data: old })).ok()).toBe(true);
    const before = inPlayer('cat', FILE);

    // A reader holds a shared lock for a few seconds.
    docker('exec', '-d', container, 'flock', '-s', FILE, 'sleep', '4');
    await expect.poll(() => {
      try { inPlayer('flock', '-n', '-x', FILE, 'true'); return 'free'; } catch { return 'held'; }
    }).toBe('held');

    const t0 = Date.now();
    const save = request.post(`/api/playlist/${NAME}`, { data: playlist({ desc: 'after', mainPlaylist: [pause(2)] }) });
    await new Promise((r) => setTimeout(r, 1500));
    // While the reader holds it, the file is what the reader started reading.
    expect(inPlayer('cat', FILE)).toBe(before);
    const r = await save;
    expect(r.ok()).toBe(true);
    expect(Date.now() - t0, 'the save returned before the reader let go').toBeGreaterThan(2000);
    const after = JSON.parse(inPlayer('cat', FILE));
    expect(after.desc).toBe('after');

    // The same for an item added to a section.
    docker('exec', '-d', container, 'flock', '-s', FILE, 'sleep', '4');
    await expect.poll(() => {
      try { inPlayer('flock', '-n', '-x', FILE, 'true'); return 'free'; } catch { return 'held'; }
    }).toBe('held');
    const held = inPlayer('cat', FILE);
    const add = request.post(`/api/playlist/${NAME}/mainPlaylist/item`, { data: pause(3) });
    await new Promise((r) => setTimeout(r, 1500));
    expect(inPlayer('cat', FILE)).toBe(held);
    expect((await (await add).json()).Status).toBe('OK');
    expect(JSON.parse(inPlayer('cat', FILE)).mainPlaylist).toHaveLength(2);
  });
});
