import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// The Playlists page's Rename Playlist, Copy Playlist onto a name, and the
// select mode's "Copy to..." (selected entries appended to another
// playlist's section).  Each test stores its playlists through the API,
// drives the page, and reads back what is stored.

const A = 'fpp-tests-rn-a';
const B = 'fpp-tests-rn-b';
const C = 'fpp-tests-rn-c';

const pause = (duration: number) => ({ type: 'pause', enabled: 1, playOnce: 0, duration });

async function store(request: APIRequestContext, name: string, sections: object) {
  const r = await request.post(`/api/playlist/${name}`, {
    data: { name, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], ...sections },
  });
  expect(r.ok(), `storing ${name}: ${r.status()}`).toBe(true);
}
const names = async (request: APIRequestContext) => (await (await request.get('/api/playlists')).json()) as string[];
async function stored(request: APIRequestContext, name: string) {
  const r = await request.get(`/api/playlist/${name}`);
  return r.ok() ? r.json() : null;
}
const durations = (section: any[] = []) => section.map((e) => [e.type, e.duration]);

const card = (page: Page, name: string) =>
  page.locator('.playlistCard', { has: page.locator('h3', { hasText: new RegExp(`^${name}$`) }) });

async function openEditor(page: Page, name: string) {
  await page.goto('/playlists.php');
  await card(page, name).locator('h3').click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
  await expect(page.locator('#txtPlaylistName')).toHaveValue(name);
}

async function whenModalShown(page: Page, open: () => Promise<void>) {
  await page.evaluate(() => {
    (window as any).fppTestsModalShown = false;
    document.addEventListener('shown.bs.modal', () => { (window as any).fppTestsModalShown = true; }, { once: true });
  });
  await open();
  await page.waitForFunction(() => (window as any).fppTestsModalShown);
}

async function playlistAction(page: Page, id: string, item: string) {
  await whenModalShown(page, async () => {
    await page.locator('#playlistEditMoreButton').click();
    await page.locator('.playlistEditMoreButtonMenu a', { hasText: item }).click();
  });
  return page.locator(`#${id}`);
}
async function rename(page: Page, to: string) {
  const dlg = await playlistAction(page, 'RenamePlaylistDialog', 'Rename Playlist');
  await expect(dlg.locator('.newPlaylistName')).toHaveValue(await page.locator('#txtPlaylistName').inputValue());
  await dlg.locator('.newPlaylistName').fill(to);
  await dlg.locator('.modal-footer button', { hasText: 'Rename' }).click();
}
const errorDialog = (page: Page) => page.locator('#dialogOKPopup');

test.afterEach(async ({ request }) => {
  for (const n of [A, B, C, '']) if (n) await request.delete(`/api/playlist/${n}`);
});

test.describe('Rename Playlist', () => {
  test('moves the entries to the new name and removes the old one', async ({ page, request }) => {
    await store(request, A, { leadIn: [pause(1)], mainPlaylist: [pause(2), pause(3)], leadOut: [pause(4)], desc: 'kept' });
    await openEditor(page, A);
    await rename(page, B);
    await page.waitForLoadState('load');
    await expect.poll(() => names(request)).toContain(B);
    expect(await names(request)).not.toContain(A);
    const pl = await stored(request, B);
    expect(pl).toMatchObject({ name: B, desc: 'kept' });
    expect(durations(pl.leadIn)).toEqual([['pause', 1]]);
    expect(durations(pl.mainPlaylist)).toEqual([['pause', 2], ['pause', 3]]);
    expect(durations(pl.leadOut)).toEqual([['pause', 4]]);
    // The page reloads onto the cards; the new name has one and the old none.
    await expect(card(page, B)).toHaveCount(1);
    await expect(card(page, A)).toHaveCount(0);
  });

  test('the same name or a name with other characters is refused, and nothing is deleted', async ({ page, request }) => {
    await store(request, A, { mainPlaylist: [pause(2)] });
    await openEditor(page, A);
    for (const [to, msg] of [[A, 'Identical name given.'], ['bad/name', 'You may use only letters']] as const) {
      await rename(page, to);
      await expect(errorDialog(page)).toContainText(msg);
      await errorDialog(page).locator('.modal-footer button', { hasText: 'Close' }).click();
      await expect(errorDialog(page)).toBeHidden();
      await page.locator('#RenamePlaylistDialog .modal-footer button', { hasText: 'Cancel' }).click();
      await expect(page.locator('#RenamePlaylistDialog')).toBeHidden();
    }
    expect(durations((await stored(request, A)).mainPlaylist)).toEqual([['pause', 2]]);
    expect(await names(request)).not.toContain('bad/name');
  });

  test('a rename whose save fails keeps the playlist under its old name', async ({ page, request }) => {
    await store(request, A, { mainPlaylist: [pause(2), pause(3)] });
    await page.route(`**/api/playlist/${B}`, (r) =>
      r.request().method() === 'POST' ? r.fulfill({ status: 500, body: 'fpp-tests save refusal' }) : r.fallback());
    await openEditor(page, A);
    page.on('dialog', (d) => d.accept());
    const saved = page.waitForResponse((r) => r.url().endsWith(`/api/playlist/${B}`) && r.request().method() === 'POST');
    await rename(page, B);
    expect((await saved).status()).toBe(500);
    // The page reloads straight after, so the save's error dialog is gone too.
    await page.waitForTimeout(1500);
    expect(await names(request)).not.toContain(B);
    expect(await names(request), 'the original is gone').toContain(A);
  });

  test('a save the player could not write (answered 200 with Status Error) keeps the playlist under its old name', async ({ page, request }) => {
    await store(request, A, { mainPlaylist: [pause(2), pause(3)] });
    // What a player from before the 500 answers when file_put_contents fails.
    await page.route(`**/api/playlist/${B}`, (r) => r.request().method() === 'POST'
      ? r.fulfill({ json: { Status: 'Error', Message: 'Unable to open file for writing' } }) : r.fallback());
    await openEditor(page, A);
    await rename(page, B);
    await expect(errorDialog(page)).toContainText('Unable to open file for writing');
    await page.waitForTimeout(1500);
    expect(await names(request)).toContain(A);
    expect(durations((await stored(request, A)).mainPlaylist)).toEqual([['pause', 2], ['pause', 3]]);
  });

  test('a rename that changes only the case is refused, and the playlist stays', async ({ page, request }) => {
    // On a case-folding media drive (FAT/exFAT, macOS) the save under the new
    // name is the same file, which the delete of the old name then removes.
    await store(request, A, { mainPlaylist: [pause(2)] });
    await openEditor(page, A);
    await rename(page, A.toUpperCase());
    await expect(errorDialog(page)).toContainText('only upper/lower case');
    await page.waitForTimeout(1000);
    expect(await names(request)).toContain(A);
    expect(await names(request)).not.toContain(A.toUpperCase());
  });

  test('an empty name is refused and the playlist stays', async ({ page, request }) => {
    await store(request, A, { mainPlaylist: [pause(2)] });
    await openEditor(page, A);
    page.on('dialog', (d) => d.accept());
    await rename(page, '');
    await page.waitForTimeout(1500);
    expect(await names(request), 'the original is gone').toContain(A);
    await expect(errorDialog(page)).toContainText('cannot be empty');
  });

  test('a rename onto another playlist does not replace it unasked', async ({ page, request }) => {
    await store(request, A, { mainPlaylist: [pause(2)] });
    await store(request, B, { mainPlaylist: [pause(7), pause(8), pause(9)] });
    await openEditor(page, A);
    let asked = false;
    page.on('dialog', (d) => { asked = true; return d.dismiss(); });
    await rename(page, B);
    await page.waitForTimeout(1500);
    const b = await stored(request, B);
    expect(asked || (await errorDialog(page).isVisible()), 'nothing asked').toBe(true);
    expect(durations(b.mainPlaylist), 'the other playlist was replaced').toEqual([['pause', 7], ['pause', 8], ['pause', 9]]);
    expect(await names(request)).toContain(A);
  });
});

test.describe('Copy Playlist', () => {
  test('copies under a new name and keeps the original', async ({ page, request }) => {
    await store(request, A, { mainPlaylist: [pause(2), pause(3)] });
    await openEditor(page, A);
    const dlg = await playlistAction(page, 'CopyPlaylistDialog', 'Copy Playlist');
    await expect(dlg.locator('.newPlaylistName')).toHaveValue(`${A} - Copy`);
    await dlg.locator('.newPlaylistName').fill(B);
    await dlg.locator('.modal-footer button', { hasText: 'Copy' }).click();
    await expect.poll(() => names(request)).toContain(B);
    expect(durations((await stored(request, B)).mainPlaylist)).toEqual([['pause', 2], ['pause', 3]]);
    expect(durations((await stored(request, A)).mainPlaylist)).toEqual([['pause', 2], ['pause', 3]]);
    await expect(page.locator('#txtPlaylistName')).toHaveValue(B);
  });

  test('a copy onto another playlist does not replace it unasked', async ({ page, request }) => {
    await store(request, A, { mainPlaylist: [pause(2)] });
    await store(request, B, { mainPlaylist: [pause(7), pause(8)] });
    await openEditor(page, A);
    page.on('dialog', (d) => d.dismiss());
    const dlg = await playlistAction(page, 'CopyPlaylistDialog', 'Copy Playlist');
    await dlg.locator('.newPlaylistName').fill(B);
    await dlg.locator('.modal-footer button', { hasText: 'Copy' }).click();
    await page.waitForTimeout(1500);
    expect(durations((await stored(request, B)).mainPlaylist), 'the other playlist was replaced').toEqual([['pause', 7], ['pause', 8]]);
  });
});

test.describe('Copy selected entries to another playlist', () => {
  async function select(page: Page, rows: number[]) {
    await page.locator('.playlistSelectModeBtn').click();
    const r = page.locator('#tblPlaylistMainPlaylist tr.playlistRow');
    for (const i of rows) await r.nth(i).locator('.playlistEntryCheckbox').check();
    await whenModalShown(page, async () => {
      await page.locator('#playlistSelectActionsBtn').click();
      await page.locator('.playlistSelectActionsMenu a', { hasText: 'Copy to...' }).click();
    });
    return page.locator('#CopySelectedDialog');
  }

  test('appends the selected entries to the chosen section and keeps what was there', async ({ page, request }) => {
    await store(request, A, { mainPlaylist: [pause(2), pause(3), pause(4)] });
    await store(request, B, { leadIn: [pause(10)], mainPlaylist: [pause(11)], desc: 'target' });
    await store(request, C, {});
    await openEditor(page, A);
    const dlg = await select(page, [0, 2]);
    await expect(dlg).toContainText('Copy 2 selected items to:');
    // The playlist being edited is not offered.
    await expect(dlg.locator('#copyTargetPlaylist option', { hasText: A })).toHaveCount(0);
    await expect(dlg.locator('#copyTargetPlaylist option', { hasText: B })).toHaveText(`${B} (2 items)`);
    await dlg.locator('#copyTargetPlaylist').selectOption(B);
    await dlg.locator('input[name="copySection"][value="leadIn"]').check();
    await dlg.locator('.modal-footer button', { hasText: 'Copy' }).click();
    await expect(page.locator('.jGrowl-message', { hasText: `2 items copied to "${B}"` })).toBeVisible();
    await expect(dlg).toBeHidden();

    const b = await stored(request, B);
    expect(durations(b.leadIn)).toEqual([['pause', 10], ['pause', 2], ['pause', 4]]);
    expect(durations(b.mainPlaylist)).toEqual([['pause', 11]]);
    expect(b).toMatchObject({ name: B, desc: 'target', version: 4 });
    // The source is untouched.
    expect(durations((await stored(request, A)).mainPlaylist)).toEqual([['pause', 2], ['pause', 3], ['pause', 4]]);

    // An empty target gets the section made for it; Main is the default.
    const dlg2 = await select(page, [1]);
    await expect(dlg2).toContainText('Copy 1 selected item to:');
    await dlg2.locator('#copyTargetPlaylist').selectOption(C);
    await dlg2.locator('.modal-footer button', { hasText: 'Copy' }).click();
    await expect(dlg2).toBeHidden();
    expect(durations((await stored(request, C)).mainPlaylist)).toEqual([['pause', 3]]);
  });

  test('no target chosen, or a target that cannot be read or saved, says so and writes nothing', async ({ page, request }) => {
    await store(request, A, { mainPlaylist: [pause(2)] });
    await store(request, B, { mainPlaylist: [pause(11)] });
    await openEditor(page, A);
    const dlg = await select(page, [0]);
    const tryCopy = async (msg: string) => {
      await dlg.locator('.modal-footer button', { hasText: 'Copy' }).click();
      await expect(errorDialog(page)).toContainText(msg);
      await errorDialog(page).locator('.modal-footer button', { hasText: 'Close' }).click();
      await expect(errorDialog(page)).toBeHidden();
    };
    await tryCopy('Please select a target playlist.');

    await dlg.locator('#copyTargetPlaylist').selectOption(B);
    await page.route(`**/api/playlist/${B}`, (r) => r.request().method() === 'GET' ? r.fulfill({ status: 404, body: '' }) : r.fallback());
    await tryCopy(`Could not load target playlist "${B}".`);
    await page.unroute(`**/api/playlist/${B}`);

    await page.route(`**/api/playlist/${B}`, (r) => r.request().method() === 'POST' ? r.fulfill({ status: 500, body: '' }) : r.fallback());
    await tryCopy('Failed to save target playlist.');
    expect(durations((await stored(request, B)).mainPlaylist)).toEqual([['pause', 11]]);
  });
});
