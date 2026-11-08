import { test, expect } from './fixtures';

// Names with quotes and markup in the option lists pages build as HTML: the
// shared CreateSelect() (here a sub-model's Parent on the Pixel Overlay Models
// page) and the playlist editor's Copy to... target list.  Each option keeps
// the name as its value, and none of it is drawn.
// (schedule-playlist-user-markup.spec.ts: the Scheduler and playlist pages.)

const NAME = `fpp-tests "q" it's <b>bold`;

test("a sub-model's Parent keeps a name with quotes and markup", async ({ page }) => {
  // Regression: 34491379f.  CreateSelect() wrote values and labels as markup, in
  // value='...': the Parent was cut off at the apostrophe.
  const sub = { Name: 'fpp-tests-sub', Type: 'Sub', autoCreated: false, Width: 8, Height: 8, ChannelCount: 192,
    StartChannel: 1, Parent: NAME, XOffset: 0, YOffset: 0 };
  await page.route('**/api/overlays/models', (route) => route.fulfill({ json: [sub] }));
  await page.goto('/pixeloverlaymodels.php');
  const parent = page.locator('#channelMemMaps tbody tr select.parent');
  await expect(parent).toHaveCount(1, { timeout: 15_000 });
  await expect(parent).toHaveValue(NAME);
  await expect(parent.locator('option:checked')).toHaveText(NAME);
  await expect(page.locator('#channelMemMaps b:text-is("bold")')).toHaveCount(0);
});

test.describe('Copy to...', () => {
  const FROM = 'fpp-tests-copy-from';
  const enc = encodeURIComponent;
  const playlist = (name: string, mainPlaylist: object[] = []) => ({
    name, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist, leadOut: [], playlistInfo: {},
  });
  test.afterEach(async ({ request }) => {
    for (const n of [FROM, NAME]) await request.delete(`/api/playlist/${enc(n)}`);
  });

  test('offers a playlist whose name has quotes and markup, and copies into it', async ({ page, request }) => {
    // Regression: 34491379f.  CopySelectedToPlaylist() built the target list's
    // value="..." from the raw name: the copy went to a cut-off name.
    const pause = { type: 'pause', enabled: 1, playOnce: 0, duration: 3 };
    expect((await request.post(`/api/playlist/${enc(FROM)}`, { data: playlist(FROM, [pause]) })).ok()).toBe(true);
    expect((await request.post(`/api/playlist/${enc(NAME)}`, { data: playlist(NAME) })).ok(),
      'the control: a playlist can have this name').toBe(true);
    await page.goto('/playlists.php');
    await page.locator('.playlistCard h3', { hasText: new RegExp(`^${FROM}$`) }).click();
    await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
    await page.locator('.playlistSelectModeBtn').click();
    await page.locator('#tblPlaylistMainPlaylist tr.playlistRow').nth(0).locator('.playlistEntryCheckbox').check();
    await page.locator('#playlistSelectActionsBtn').click();
    await page.locator('.playlistSelectActionsMenu .dropdown-item', { hasText: 'Copy to...' }).click();
    const dialog = page.locator('#CopySelectedDialog');
    const option = dialog.locator('#copyTargetPlaylist option').filter({ hasText: NAME });
    await expect(option).toHaveCount(1);
    await expect(option).toHaveAttribute('value', NAME);
    await expect(dialog.locator('b:text-is("bold")')).toHaveCount(0);
    await dialog.locator('#copyTargetPlaylist').selectOption(NAME);
    await dialog.getByRole('button', { name: 'Copy' }).click();
    await expect.poll(async () => {
      const r = await request.get(`/api/playlist/${enc(NAME)}`);
      return r.ok() ? ((await r.json()).mainPlaylist ?? []).map((e: any) => e.duration) : null;
    }).toEqual([3]);
  });
});
