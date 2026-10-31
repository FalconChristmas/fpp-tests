import { test, expect } from './fixtures';

// An entry's note in the playlist editor (playlists.php): the entry's row
// carries it as its tooltip, whatever the entry shows as its text.

const NAME = 'fpp-tests-note-tooltip';
const NOTE = "fpp-tests' note <b>here</b>";

test.afterEach(async ({ request }) => {
  await request.delete(`/api/playlist/${NAME}`);
});

test("an entry's note is its row's tooltip in the editor", async ({ page, request }) => {
  // Regression: c0bd0fceb.  A note was shown only in the "args and note"
  // display mode; otherwise the editor gave no sign of it.
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], leadOut: [], playlistInfo: {},
      mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 5, note: NOTE },
                     { type: 'pause', enabled: 1, playOnce: 0, duration: 6 }] },
  });
  expect(r.ok()).toBe(true);
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
  const rows = page.locator('#tblPlaylistMainPlaylist tr.playlistRow');
  await expect(rows).toHaveCount(2);
  // The whole note, quote and markup as text.
  await expect(rows.nth(0).locator('.psiDataSimple')).toHaveAttribute('title', NOTE);
  // An entry with no note has no tooltip.
  await expect(rows.nth(1).locator('.psiDataSimple')).not.toHaveAttribute('title');
});
