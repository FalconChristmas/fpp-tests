import { test, expect } from './fixtures';

// A playlist saved when "Overlay Model Text" was a command of its own still
// loads: the editor turns its entries into the Overlay Model Effect command
// that replaced it, and saving writes the new form.

const NAME = 'fpp-tests-upgrade-overlay-text';

test.afterEach(async ({ request }) => {
  await request.delete(`/api/playlist/${NAME}`);
});

test('an old Overlay Model Text entry saves as an Overlay Model Effect, its arguments moved along', async ({ page, request }) => {
  // Regression: 9f5bb2383 ("Convert old Overlay Model Text playlist entries to
  // new format").
  const old = { type: 'command', enabled: 1, playOnce: 0, command: 'Overlay Model Text', multisyncCommand: true, multisyncHosts: '',
    args: ['Matrix', '#FF0000', 'FreeSans', '24', 'true', 'Center', '10', '-1', 'hello'] };
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [old], leadOut: [], playlistInfo: {} },
  });
  expect(r.ok()).toBe(true);
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
  await expect(page.locator('#tblPlaylistMainPlaylist tr.playlistRow')).toHaveCount(1);
  const saved = page.waitForResponse((res) => res.request().method() === 'POST' && new URL(res.url()).pathname === `/api/playlist/${NAME}`);
  await page.getByRole('button', { name: 'Save Playlist' }).click();
  expect((await saved).ok()).toBe(true);
  const entry = (await (await request.get(`/api/playlist/${NAME}`)).json()).mainPlaylist[0];
  expect(entry.command).toBe('Overlay Model Effect');
  expect(entry.args).toEqual(['Matrix', 'Enabled', 'Text', '#FF0000', 'FreeSans', '24', 'true', 'Center', '10', '0', 'hello']);
  expect(entry.multisyncCommand ?? false).toBe(false);
});
