import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// The Playlists page's card list: a copy made from the editor shows up in it
// straight away, and each card's own Delete button deletes that playlist.

const NAME = 'fpp-tests-card-a';
const COPY = 'fpp-tests-card-a-copy';

async function store(request: APIRequestContext, name: string) {
  const r = await request.post(`/api/playlist/${name}`, {
    data: { name, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], leadOut: [], playlistInfo: {},
      mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 1 }] },
  });
  expect(r.ok(), await r.text()).toBe(true);
}

async function exists(request: APIRequestContext, name: string) {
  return (await request.get(`/api/playlist/${name}`)).status() === 200;
}

const card = (page: Page, name: string) =>
  page.locator('.playlistCard', { has: page.locator('h3', { hasText: new RegExp(`^${name}$`) }) });

test.afterEach(async ({ request }) => {
  for (const n of [NAME, COPY]) await request.delete(`/api/playlist/${n}`);
});

test('a copy made in the editor is in the card list without a reload', async ({ page, request }) => {
  // Regression: 983092335 ("Refresh Playlist on Copy", #1072).  Copy saved
  // the new playlist and refreshed the playlist select, but the cards were
  // not redrawn, so the copy wasn't listed until the page was reloaded.
  await store(request, NAME);
  await page.goto('/playlists.php');
  await card(page, NAME).locator('h3').click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
  await page.evaluate(() => (window as any).CopyPlaylist());
  const dialog = page.locator('#CopyPlaylistDialog');
  await expect(dialog.locator('.newPlaylistName')).toHaveValue(`${NAME} - Copy`);
  await dialog.locator('.newPlaylistName').fill(COPY);
  await dialog.getByRole('button', { name: 'Copy' }).click();
  // The control: the copy was saved.
  await expect.poll(() => exists(request, COPY)).toBe(true);
  await expect(card(page, COPY)).toHaveCount(1);
  await expect(card(page, NAME)).toHaveCount(1);
});

test("a card's Delete button deletes that playlist, after asking", async ({ page, request }) => {
  // Regression: c44e59d79 ("Allow deleting a Playlist from the Playlist list
  // UI").  A playlist could only be deleted from its editor.
  await store(request, NAME);
  await store(request, COPY);
  await page.goto('/playlists.php');
  await expect(card(page, NAME)).toHaveCount(1);
  await card(page, NAME).hover();
  await card(page, NAME).getByRole('button', { name: 'Delete' }).click();
  const ask = page.locator('#DeletePlaylistDialog');
  await expect(ask).toContainText(NAME);
  // The button acts on its own card only: the editor was not opened.
  await expect(page.locator('#playlistEditor')).not.toHaveClass(/hasPlaylistDetailsLoaded/);
  await ask.getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => exists(request, NAME)).toBe(false);
  // The control: the other playlist is still there.
  expect(await exists(request, COPY)).toBe(true);
  await expect(card(page, NAME)).toHaveCount(0);
});
