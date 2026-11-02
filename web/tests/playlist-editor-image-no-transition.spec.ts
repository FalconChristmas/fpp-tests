import { test, expect } from './fixtures';

// Regression: f6d8e26d3 ("Disable transition type field for
// PlaylistEntryImage").  An Image entry draws onto a Pixel Overlay Model,
// not straight to the framebuffer where the transition effects were, so its
// Transition Type field did nothing; it was taken off the entry.

test('an Image playlist entry has no Transition Type field', async ({ page, request }) => {
  const NAME = 'fpp-tests-image-entry';
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], leadOut: [], playlistInfo: {},
      mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 5 }] },
  });
  expect(r.ok(), await r.text()).toBe(true);
  try {
    await page.goto('/playlists.php');
    await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
    await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
    await page.evaluate(() => { (window as any).$('#pe_type').val('image').trigger('change'); });
    const rows = await page.evaluate(() => {
      const scope = (window as any).PlaylistEntryArgScope();
      return { image: scope.find('.arg_row_imagePath').length, transition: scope.find('.arg_row_transitionType').length };
    });
    // The control: the Image entry's own fields are drawn.
    expect(rows.image, 'Image field rows').toBeGreaterThan(0);
    expect(rows.transition, 'Transition Type rows').toBe(0);
  } finally {
    await request.delete(`/api/playlist/${NAME}`);
  }
});
