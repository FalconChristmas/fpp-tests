import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// More of the playlist editor's entry modal: arguments with markup in them,
// and the sequence suggested for a media file.

const NAME = 'fpp-tests-entry-args';

async function storePlaylist(request: APIRequestContext, mainPlaylist: object[]) {
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist, leadOut: [], playlistInfo: {} },
  });
  expect(r.ok(), `storing ${NAME}: ${r.status()}`).toBe(true);
}

async function storedPlaylist(request: APIRequestContext) {
  return (await request.get(`/api/playlist/${NAME}`)).json();
}

async function openEditor(page: Page) {
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
}

function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function savePlaylist(page: Page) {
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/playlist/${NAME}`);
  await page.getByRole('button', { name: 'Save Playlist' }).click();
  expect((await saved).ok()).toBe(true);
}

// Opens the New Entry modal and waits for Bootstrap's show transition to
// end: a hide asked for while the modal is still fading in is dropped, so
// an Add clicked that early adds the entry but leaves the modal open over
// the page.
async function openNewEntry(page: Page) {
  await page.evaluate(() => {
    (window as any).fppTestsModalShown = false;
    document.addEventListener('shown.bs.modal', () => { (window as any).fppTestsModalShown = true; }, { once: true });
  });
  await page.locator('.playlistEntriesAddNewBtn').first().click();
  await page.waitForFunction(() => (window as any).fppTestsModalShown);
}

// The New Entry modal's Add: the entry goes into the list.
async function addEntry(page: Page) {
  const rows = page.locator('#tblPlaylistMainPlaylist tr.playlistRow');
  const before = await rows.count();
  await page.locator('.modal.show').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(rows).toHaveCount(before + 1);
}

test.afterEach(async ({ request }) => {
  await request.delete(`/api/playlist/${NAME}`);
});

test('a Command entry with markup in an argument keeps it through an edit and save', async ({ page, request }) => {
  // Regression: a9ab5c0ab.  The editor read the arguments back from the
  // row with .html(), which gives them as markup: "a &amp; b" came back as
  // "a &amp;amp; b" and "<c>" as "&lt;c&gt;".
  const data = 'a &amp; b <c> "d" & e';
  await storePlaylist(request, [{ type: 'command', enabled: 1, playOnce: 0, command: 'URL',
    args: ['http://127.0.0.1/hook?x=1&y=2', 'POST', data] }]);
  const errors = pageErrors(page);
  await openEditor(page);
  await page.locator('.playlistRowEditButton').first().click();
  const modal = page.locator('.modal.show');
  await expect(modal.locator('.modal-title')).toHaveText('Edit Entry');
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(modal).toBeHidden();
  await savePlaylist(page);
  expect(errors).toEqual([]);
  const entry = (await storedPlaylist(request)).mainPlaylist[0];
  expect(entry.args).toEqual(['http://127.0.0.1/hook?x=1&y=2', 'POST', data]);
});
