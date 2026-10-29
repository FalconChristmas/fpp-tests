import { test, expect } from './fixtures';
import type { Route } from '@playwright/test';

// The status page's playlist picker (index.php, PopulatePlaylists(true)):
// the playlists, sequences and media are asked for together and without
// blocking the page, which shows "Loading..." until they are all in.  What
// is picked is what fppd plays.

const NAME = 'fpp-tests-async-picker';

test.afterEach(async ({ request }) => {
  await request.post('/api/playlists/stop');
  await request.delete(`/api/playlist/${NAME}`);
});

test('the playlist picker loads without blocking the page, and the playlist picked is the one played', async ({ page, request }) => {
  // Feature: 5d8889c4d.  PopulatePlaylists asked for the playlists, then the
  // sequences, then the media, each with a synchronous request, so the
  // status page was frozen until all three had answered one after another.
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], leadOut: [], playlistInfo: {},
            mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 30 }] },
  });
  expect(r.ok()).toBe(true);

  const asked: string[] = [];
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    if (['/api/playlists/validate', '/api/sequence', '/api/media'].includes(path)) asked.push(path);
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  await page.route(/\/api\/playlists\/validate$/, async (route: Route) => {
    held();
    await released;
    await route.continue();
  });

  await page.goto('/index.php', { waitUntil: 'commit' });
  await holding;
  // The page runs while the playlist list is still out: a script answers,
  // and the picker says it is loading.
  const picker = await Promise.race([
    page.evaluate(() => Array.from((document.querySelector('#playlistSelect') as HTMLSelectElement)?.options ?? [])
      .map((o) => o.text)),
    new Promise<string>((resolve) => setTimeout(() => resolve('the page did not answer in 5 s'), 5_000)),
  ]);
  release();
  expect(picker, 'the picker while the playlists are still loading').toEqual(['Loading...']);
  // The sequences and media were asked for without waiting for the playlists.
  await expect.poll(() => asked.slice().sort()).toEqual(['/api/media', '/api/playlists/validate', '/api/sequence']);

  const select = page.locator('#playlistSelect');
  await expect(select.locator(`optgroup[label="Playlists"] option[value="${NAME}"]`)).toHaveCount(1);
  await expect(select.locator('optgroup[label="Sequences"]')).toHaveCount(1);
  await expect(select.locator('optgroup[label="Media"]')).toHaveCount(1);
  await expect(select).toHaveValue('');

  await select.selectOption(NAME);
  await page.locator('[onclick="StartPlaylistNow();"]').first().click();
  await expect.poll(async () => (await (await request.get('/api/fppd/status')).json()).current_playlist?.playlist,
    { timeout: 10_000 }).toBe(NAME);
});
