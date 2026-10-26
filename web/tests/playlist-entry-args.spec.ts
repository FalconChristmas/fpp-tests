import { test, expect } from './fixtures';

// The playlist editor's entry fields, which the shared argument renderer
// (PrintArgInputs) draws from playlistEntryTypes.json.  That file keys each
// entry type's args by name -- an object, where a command's args are an array.

test('a Playlist entry draws its fields and offers the playlists to pick from', async ({ page, request }) => {
  // Regression: bb2173530 (its page half; scenarios/test_command_preset_refs.py
  // has the Condition.cpp one).  PrintArgInputs called args.filter(), which an
  // entry type's object of args has not got: a TypeError, and the entry's
  // fields -- the playlist dropdown among them -- were never drawn.
  const host = 'fpp-tests-entry-host';
  const inner = 'fpp-tests-entry-inner';
  const empty = (name: string) => ({ name, version: 4, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} });
  for (const n of [host, inner]) await request.post(`/api/playlist/${n}`, { data: empty(n) });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto('/playlists.php');
    await page.locator('.playlistCard h3', { hasText: new RegExp(`^${host}$`) }).click();
    await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
    await page.locator('.playlistEntriesAddNewBtn').first().click();
    await page.selectOption('#pe_type', 'playlist');
    const picker = page.locator('#playlistEntryOptions select.arg_name');
    await expect(picker).toHaveCount(1);
    expect(await picker.locator('option').evaluateAll((os) => os.map((o: any) => o.value))).toContain(inner);
    expect(errors, 'page errors').toEqual([]);
  } finally {
    for (const n of [host, inner]) await request.delete(`/api/playlist/${n}`);
  }
});
