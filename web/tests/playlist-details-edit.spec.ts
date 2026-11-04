import { test, expect } from './fixtures';

// The playlist editor's Edit Playlist Details dialog: what it saves.

const NAME = 'fpp-tests-details-edit';

test.beforeEach(async ({ request }) => {
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: 'before', random: 0, repeat: 0, loopCount: 0, leadIn: [], leadOut: [], playlistInfo: {},
      mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 5 }] },
  });
  expect(r.ok()).toBe(true);
});
test.afterEach(async ({ request }) => { await request.delete(`/api/playlist/${NAME}`); });

test("a playlist's description and Randomize, changed in Edit Playlist Details, are what is saved", async ({ page, request }) => {
  // Regression: 2c9bf22ff ("fix playlist details editing").  The New
  // Playlist dialog's Randomize select had the same id as the editor's, and
  // saving read the first one in the page -- the New Playlist one -- so the
  // Randomize picked for the playlist being edited was never saved.
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
  await page.locator('.editPlaylistBtn').first().click();
  const dialog = page.locator('#EditPlaylistDetailsDialog');
  await expect(dialog.locator('#txtPlaylistDesc')).toHaveValue('before');
  await dialog.locator('#txtPlaylistDesc').fill('after');
  await dialog.locator('#randomizePlaylist').selectOption('1');
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/playlist/${NAME}`);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  const pl = await (await request.get(`/api/playlist/${NAME}`)).json();
  expect({ desc: pl.desc, random: pl.random }).toEqual({ desc: 'after', random: 1 });
});
