import { test, expect } from './fixtures';

// Regression: 28acd8271 ("Avoid NAN in calculating playlist length", #1121).
// UpdatePlaylistDurations() summed each row's .psiDurationSeconds with
// parseFloat(); one row whose duration is not a number made the section's
// total NaN, and the editor showed "NaN" as the playlist's length and saved it
// as its duration.  A row that is not a number counts as 0.
//
// What still makes such a row: a pause added in the editor with its Duration
// left empty.  AddPlaylistEntry() reads the field with parseFloat(), and
// PopulatePlaylistItemDuration() puts that NaN in the row.  (Rows loaded from a
// file are not re-measured; only an entry added in the editor is.)

test('a pause added with no duration counts as 0 in the playlist length, not NaN', async ({ page, request }) => {
  const NAME = 'fpp-tests-duration-nan';
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: {
      name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], leadOut: [], playlistInfo: {},
      mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 5 }],
    },
  });
  expect(r.ok(), await r.text()).toBe(true);
  try {
    await page.goto('/playlists.php');
    await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
    await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
    const rows = page.locator('#tblPlaylistMainPlaylist tr.playlistRow');
    await expect(rows).toHaveCount(1);
    await expect(page.locator('#playlistDuration')).toHaveText('5');

    // Add a pause with the Duration field empty, as the editor's Add does.
    await page.evaluate(() => {
      const w = window as any;
      w.$('#pe_type').val('pause').trigger('change');
      w.PlaylistEntryArgScope().find('.arg_duration').val('');
      w.AddPlaylistEntry(0);
    });
    await expect(rows).toHaveCount(2);
    // The control: the new row's duration is not a number, which is what the
    // guard is for.
    const seconds = await rows.locator('.psiDurationSeconds').allTextContents();
    expect(seconds.map((s) => Number.isNaN(parseFloat(s))), JSON.stringify(seconds)).toEqual([false, true]);

    await expect(page.locator('#playlistDuration')).toHaveText('5');
    await expect(page.locator('.playlistDurationMainPlaylist').first()).not.toContainText('NaN');
  } finally {
    await request.delete(`/api/playlist/${NAME}`);
  }
});
