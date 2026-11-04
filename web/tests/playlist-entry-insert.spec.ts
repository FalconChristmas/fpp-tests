import { test, expect } from './fixtures';

// The playlist editor's New Entry dialog: Add puts the entry at the end,
// Insert puts it before or after the selected entry.

const NAME = 'fpp-tests-insert';
const pause = (duration: number) => ({ type: 'pause', enabled: 1, playOnce: 0, duration });

test.beforeEach(async ({ request }) => {
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], leadOut: [], playlistInfo: {},
      mainPlaylist: [pause(5), pause(7)] },
  });
  expect(r.ok()).toBe(true);
});
test.afterEach(async ({ request }) => { await request.delete(`/api/playlist/${NAME}`); });

test("New Entry's Insert, Before Selection, puts the entry ahead of the selected one", async ({ page, request }) => {
  // Regression: 33aa0fd09 ("Restore insert functionality in Playlist
  // Editor").  The dialog had lost its Insert choices, leaving only Add, so
  // an entry could only be added at the end of the playlist.
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
  const rows = page.locator('#tblPlaylistMainPlaylist tr.playlistRow');
  await expect(rows).toHaveCount(2);
  await rows.nth(1).dispatchEvent('mousedown');
  await expect(rows.nth(1)).toHaveClass(/playlistSelectedEntry/);

  await page.locator('.playlistEntriesAddNewBtn').first().click();
  await page.locator('#pe_type').selectOption('pause');
  await page.locator('#playlistEntryOptions input.arg_duration').fill('9');
  const footer = page.locator('.modal.show .modal-actions');
  await footer.getByRole('button', { name: 'Insert' }).click();
  await footer.getByText('Before Selection').click();
  await expect(rows).toHaveCount(3);

  const saved = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/playlist/${NAME}`);
  await page.locator('.savePlaylistBtn').first().click();
  expect((await saved).ok()).toBe(true);
  const pl = await (await request.get(`/api/playlist/${NAME}`)).json();
  expect(pl.mainPlaylist.map((e: any) => [e.type, Number(e.duration)])).toEqual([['pause', 5], ['pause', 9], ['pause', 7]]);
});
