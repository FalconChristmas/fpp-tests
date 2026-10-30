import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// The "empty" flag the playlist editor saves with a playlist: it follows what
// the playlist holds when it is saved.  (Bulk Add's half is in
// filemanager-bulk-add.spec.ts.)

const NAME = 'fpp-tests-empty-flag';
const pause = (duration: number) => ({ type: 'pause', enabled: 1, playOnce: 0, duration });

async function storePlaylist(request: APIRequestContext, empty: boolean, mainPlaylist: object[]) {
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, empty, leadIn: [], mainPlaylist, leadOut: [], playlistInfo: {} },
  });
  expect(r.ok(), `storing ${NAME}: ${r.status()}`).toBe(true);
}

async function stored(request: APIRequestContext) {
  return (await request.get(`/api/playlist/${NAME}`)).json();
}

async function openEditor(page: Page) {
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
}

async function savePlaylist(page: Page) {
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/playlist/${NAME}`);
  await page.getByRole('button', { name: 'Save Playlist' }).click();
  expect((await saved).ok()).toBe(true);
}

test.afterEach(async ({ request }) => {
  await request.delete(`/api/playlist/${NAME}`);
});

test('a playlist emptied in the editor is saved as empty', async ({ page, request }) => {
  // Regression: caf3b03e4.  SavePlaylistAs() set empty = false on every
  // save, whatever was left in the playlist.
  await storePlaylist(request, false, [pause(1)]);
  await openEditor(page);
  const rows = page.locator('#tblPlaylistMainPlaylist tr.playlistRow');
  await expect(rows).toHaveCount(1);
  await page.locator('.playlistSelectModeBtn').click();
  await rows.nth(0).locator('.playlistEntryCheckbox').check();
  await page.locator('#playlistSelectActionsBtn').click();
  await page.locator('.playlistSelectActionsMenu .dropdown-item', { hasText: 'Remove Selected' }).click();
  await expect(rows).toHaveCount(0);
  await savePlaylist(page);
  const pl = await stored(request);
  expect(pl.mainPlaylist).toEqual([]);
  expect(pl.empty).toBe(true);
});
