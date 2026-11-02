import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// An entry's Display Mode (the playlist editor's entry modal): whether its
// row in the playlist shows the entry's arguments, its note, or both.  The
// mode is saved with the entry; fppd ignores it and still runs the playlist.

const NAME = 'fpp-tests-display-mode';

const pause = (note: string, displayMode?: string) => ({
  type: 'pause', enabled: 1, playOnce: 0, duration: 7, note, ...(displayMode ? { displayMode } : {}),
});

async function storePlaylist(request: APIRequestContext, mainPlaylist: object[]) {
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist, leadOut: [], playlistInfo: {} },
  });
  expect(r.ok(), `storing ${NAME}: ${r.status()}`).toBe(true);
}

async function openEditor(page: Page) {
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
}

// What each row of the main section shows in the (non-verbose) list.
const rowText = (page: Page) => page.locator('#tblPlaylistMainPlaylist tr.playlistRow .psiDataSimple')
  .allInnerTexts().then((t) => t.map((s) => s.replace(/\s+/g, ' ').trim()));

test.afterEach(async ({ request }) => {
  await request.post('/api/playlists/stop');
  await request.delete(`/api/playlist/${NAME}`);
});

test('an entry row shows its arguments, its note, or both, as its Display Mode says', async ({ page, request }) => {
  // Feature: fca5b22d6 (#2480).  A row showed only the entry's arguments;
  // a note was only in the row's tooltip.
  // Also 4e11b121b: a row's pause duration is a number in the JSON, which the
  // row builder escaped as text, so no row with a pause could be drawn.
  await storePlaylist(request, [
    pause('fpp-tests args only'),
    pause('fpp-tests both', 'argsAndNote'),
    pause('fpp-tests just the note', 'justNote'),
  ]);
  await openEditor(page);
  await expect(page.locator('#tblPlaylistMainPlaylist tr.playlistRow')).toHaveCount(3);
  const [argsOnly, both, justNote] = await rowText(page);
  expect(argsOnly).toMatch(/7/);
  expect(argsOnly).not.toContain('fpp-tests args only');
  expect(both).toMatch(/7/);
  expect(both).toContain('Note: fpp-tests both');
  expect(justNote).toBe('Note: fpp-tests just the note');
});

test('the Display Mode chosen in the entry editor is saved and shown, and fppd still plays the playlist', async ({ page, request }) => {
  // Feature: fca5b22d6.  The entry editor offers Display Mode (Args Only,
  // Args and Note, Just Note); the choice is saved with the entry.
  await storePlaylist(request, [pause('fpp-tests edited')]);
  await openEditor(page);
  await page.locator('.playlistRowEditButton').first().click();
  const modal = page.locator('.modal.show');
  await expect(modal.locator('.modal-title')).toHaveText('Edit Entry');
  const mode = modal.locator('select.arg_displayMode');
  await expect(mode).toHaveValue('argsOnly');
  expect(await mode.locator('option').allInnerTexts()).toEqual(['Args Only', 'Args and Note', 'Just Note']);
  await mode.selectOption('justNote');
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(modal).toBeHidden();
  await expect.poll(() => rowText(page)).toEqual(['Note: fpp-tests edited']);

  const saved = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/playlist/${NAME}`);
  await page.getByRole('button', { name: 'Save Playlist' }).click();
  expect((await saved).ok()).toBe(true);
  const entry = (await (await request.get(`/api/playlist/${NAME}`)).json()).mainPlaylist[0];
  expect(entry).toMatchObject({ type: 'pause', duration: 7, note: 'fpp-tests edited', displayMode: 'justNote' });

  await openEditor(page);
  await expect.poll(() => rowText(page)).toEqual(['Note: fpp-tests edited']);

  // fppd takes the entry as an ordinary pause.
  const start = await request.post('/api/command', { data: { command: 'Start Playlist', args: [NAME, 'false', 'false'] } });
  expect(start.ok()).toBe(true);
  await expect.poll(async () => {
    const s = await (await request.get('/api/fppd/status')).json();
    return [s.current_playlist?.playlist, s.current_playlist?.type];
  }, { timeout: 10_000 }).toEqual([NAME, 'pause']);
});

test('a note with markup and quotes is shown as written, and its markup does not run', async ({ page, request }) => {
  // Regression: fpp 90f216f64.  The row put the note into its HTML and its
  // title attribute as it was: a ' ended the title early, and markup in the
  // note was parsed (an <img onerror> ran).
  const note = `fpp-tests <b>bold</b> it's <img src=x onerror="window.fppTestsRan=1"> & done`;
  await storePlaylist(request, [pause(note, 'argsAndNote'), pause(note, 'justNote')]);
  await openEditor(page);
  await expect(page.locator('#tblPlaylistMainPlaylist tr.playlistRow')).toHaveCount(2);
  const simple = page.locator('#tblPlaylistMainPlaylist tr.playlistRow .psiDataSimple');
  await expect(simple.nth(0)).toContainText(`Note: ${note}`);
  await expect(simple.nth(1)).toHaveText(`Note: ${note}`);
  for (const i of [0, 1]) {
    await expect(simple.nth(i)).toHaveAttribute('title', note);
    await expect(simple.nth(i).locator('b, img')).toHaveCount(0);
  }
  expect(await page.evaluate(() => (window as any).fppTestsRan)).toBeUndefined();

  // Saved from the page, the note is still what was written.
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/playlist/${NAME}`);
  await page.getByRole('button', { name: 'Save Playlist' }).click();
  expect((await saved).ok()).toBe(true);
  const entries = (await (await request.get(`/api/playlist/${NAME}`)).json()).mainPlaylist;
  expect(entries.map((e: any) => e.note)).toEqual([note, note]);
});
