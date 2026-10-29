import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { container, inPlayer } from './container';

// The Playlists page's own actions around the editor: adding, deleting and
// exporting a playlist, the cards' totals after an edit, the browser's Back
// button, and the "hide sequences already in playlist" filter.  Each test
// stores what it needs through the API, drives the page, and reads back what
// the page saved.

const NAME = 'fpp-tests-pl-actions';
const NEW = 'fpp-tests-pl-new';

const pause = (duration: number) => ({ type: 'pause', enabled: 1, playOnce: 0, duration });

async function storePlaylist(request: APIRequestContext, name: string, sections: object) {
  const r = await request.post(`/api/playlist/${name}`, {
    data: { name, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], ...sections },
  });
  expect(r.ok(), `storing ${name}: ${r.status()}`).toBe(true);
}

const exists = async (request: APIRequestContext, name: string) =>
  ((await (await request.get('/api/playlists')).json()) as string[]).includes(name);

function card(page: Page, name: string) {
  return page.locator('.playlistCard', { has: page.locator('h3', { hasText: new RegExp(`^${name}$`) }) });
}

async function openEditor(page: Page, name = NAME) {
  await page.goto('/playlists.php');
  await card(page, name).locator('h3').click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
  await expect(page.locator('#txtPlaylistName')).toHaveValue(name);
}

// Waits for Bootstrap's show transition to end (a click that early can be dropped).
async function whenModalShown(page: Page, open: () => Promise<void>) {
  await page.evaluate(() => {
    (window as any).fppTestsModalShown = false;
    document.addEventListener('shown.bs.modal', () => { (window as any).fppTestsModalShown = true; }, { once: true });
  });
  await open();
  await page.waitForFunction(() => (window as any).fppTestsModalShown);
}

test.afterEach(async ({ request }) => {
  for (const n of [NAME, NEW]) await request.delete(`/api/playlist/${n}`);
});

test.describe('adding a playlist', () => {
  test('the name box has the focus when the Add dialog opens', async ({ page }) => {
    // Regression: 1fcb2b3ff.  The dialog opened with nothing focused; the
    // user had to click into the name before typing it.
    await page.goto('/playlists.php');
    await whenModalShown(page, () => page.locator('.playlistAddNewBtn').first().click());
    await expect(page.locator('#txtAddPlaylistName')).toBeFocused();
  });

  test('a new playlist opens in the editor under its own name', async ({ page, request }) => {
    // Regression: c168715e9.  After Add Playlist the editor opened with the
    // header still empty (or naming the last playlist shown).
    await page.goto('/playlists.php');
    await whenModalShown(page, () => page.locator('.playlistAddNewBtn').first().click());
    await page.locator('#txtAddPlaylistName').fill(NEW);
    await page.locator('.modal.show').getByRole('button', { name: 'Add Playlist' }).click();
    await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
    await expect(page.locator('.playlistEditorHeaderTitle')).toHaveText(NEW);
    await expect.poll(() => exists(request, NEW)).toBe(true);
  });

  test('adding a playlist under a name in use is refused and leaves that playlist alone', async ({ page, request }) => {
    // Regression: fa7b75c1e.  Add Playlist saved an empty playlist over an
    // existing one of the same name, losing all its entries.
    await storePlaylist(request, NAME, { mainPlaylist: [pause(5), pause(6)] });
    await page.goto('/playlists.php');
    await expect(card(page, NAME)).toHaveCount(1);
    await whenModalShown(page, () => page.locator('.playlistAddNewBtn').first().click());
    await page.locator('#txtAddPlaylistName').fill(NAME);
    await page.locator('.modal.show').getByRole('button', { name: 'Add Playlist' }).click();
    await expect(page.locator('.modal.show', { hasText: 'Playlist Name in Use' })).toBeVisible();
    const stored = await (await request.get(`/api/playlist/${NAME}`)).json();
    expect(stored.mainPlaylist).toHaveLength(2);
  });
});

test('deleting a playlist from its card asks first, and Cancel keeps it', async ({ page, request }) => {
  // Regression: a8ab37a83.  The card's Delete button deleted the playlist
  // at once, with no confirmation.
  await storePlaylist(request, NAME, { mainPlaylist: [pause(5)] });
  await page.goto('/playlists.php');
  await card(page, NAME).locator('.circularDeleteButton').click();
  const dialog = page.locator('.modal.show', { hasText: 'Delete Playlist?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(NAME);
  // The click didn't also open the editor behind the dialog.
  await expect(page.locator('#playlistEditor')).not.toHaveClass(/hasPlaylistDetailsLoaded/);
  expect(await exists(request, NAME)).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await exists(request, NAME)).toBe(true);

  await card(page, NAME).locator('.circularDeleteButton').click();
  await page.locator('.modal.show', { hasText: 'Delete Playlist?' }).getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => exists(request, NAME)).toBe(false);
});

test('Back from the editor refreshes the card with what changed meanwhile', async ({ page, request }) => {
  // Regression: 3ec78c839.  The editor's Back only hid the editor: the
  // cards still showed the totals from when the page loaded.
  await storePlaylist(request, NAME, { mainPlaylist: [pause(5)], playlistInfo: { total_items: 1, total_duration: 5 } });
  await openEditor(page);
  await expect(page.locator('#tblPlaylistMainPlaylist tr.playlistRow')).toHaveCount(1);
  // A second entry, saved through the API while the editor is open.
  await request.post(`/api/playlist/${NAME}/mainPlaylist/item`, { data: pause(70) });
  await page.locator('.playlistEditorBackButton').click();
  await expect(page.locator('#playlistEditor')).not.toHaveClass(/hasPlaylistDetailsLoaded/);
  await expect(card(page, NAME)).toContainText(/Total Items: 2\b/);
  await expect(card(page, NAME)).toContainText('Total Duration: 01:15');
});

test('the browser\'s Back from the editor returns to the playlist list', async ({ page, request }) => {
  // Regression: 859f0b282.  Opening a playlist didn't add a history entry,
  // so Back left the Playlists page for whatever came before it.
  await storePlaylist(request, NAME, { mainPlaylist: [pause(5)] });
  await page.goto('/index.php');
  await openEditor(page);
  await page.goBack();
  await expect(page).toHaveURL(/playlists\.php/);
  await expect(page.locator('#playlistEditor')).not.toHaveClass(/hasPlaylistDetailsLoaded/);
  await expect(card(page, NAME)).toBeVisible();
  // Forward opens the playlist again.
  await page.goForward();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
});

test.describe('export', () => {
  const sections = {
    leadIn: [pause(5)],
    mainPlaylist: [pause(10), { type: 'command', enabled: 1, playOnce: 0, command: 'All Lights Off', args: [] }],
    leadOut: [pause(7)],
  };

  async function exportAs(page: Page, format: string) {
    await page.locator('#playlistEditMoreButton').click();
    await whenModalShown(page, () => page.locator('.playlistEditMoreButtonMenu').getByText('Export Playlist').click());
    await page.locator('#exportFormat').selectOption(format);
    const download = page.waitForEvent('download');
    await page.locator('.modal.show').getByRole('button', { name: 'Export' }).click();
    const d = await download;
    await expect(page.locator('#ExportPlaylistDialog')).toBeHidden();
    return { name: d.suggestedFilename(), text: readFileSync(await d.path(), 'utf8') };
  }

  test('a playlist exports as JSON that stores back as the same playlist', async ({ page, request }) => {
    // Feature: 5e6ac4898.  Playlist Actions > Export Playlist downloads the
    // playlist as JSON, text or CSV.
    await storePlaylist(request, NAME, sections);
    await openEditor(page);
    const json = await exportAs(page, 'json');
    expect(json.name).toBe(`${NAME}.json`);
    const exported = JSON.parse(json.text);
    const stored = await (await request.get(`/api/playlist/${NAME}`)).json();
    expect(exported).toEqual(stored);
    // The receiving end: the export stores back through the API as a
    // playlist fppd accepts.
    const back = await request.post(`/api/playlist/${NEW}`, { data: { ...exported, name: NEW } });
    expect(back.ok()).toBe(true);
    const all = await (await request.get('/api/playlists/validate')).json();
    const again = all.find((p: { name: string }) => p.name === NEW);
    expect(again?.valid, JSON.stringify(again)).toBe(true);
    expect(again.total_items).toBe(4);
  });

  test('the text and CSV exports list every section with durations and a total', async ({ page, request }) => {
    // Regression: 9c1b4c637.  The text and CSV exports listed only the main
    // playlist, without durations or a total: lead-in and lead-out entries
    // were missing.
    await storePlaylist(request, NAME, sections);
    await openEditor(page);
    const txt = await exportAs(page, 'txt');
    expect(txt.name).toBe(`${NAME}.txt`);
    const lines = txt.text.split('\n');
    const at = (s: string) => lines.indexOf(s);
    expect(at('--- Lead In ---'), txt.text).toBeGreaterThan(-1);
    expect(at('--- Main ---'), txt.text).toBeGreaterThan(at('--- Lead In ---'));
    expect(at('--- Lead Out ---'), txt.text).toBeGreaterThan(at('--- Main ---'));
    expect(lines).toEqual(expect.arrayContaining(['1. Pause: 0:05', '2. Pause: 0:10', '3. Command: All Lights Off', '4. Pause: 0:07']));
    expect(lines).toContain('Total Time: 0:22');

    const csv = await exportAs(page, 'xls');
    expect(csv.name).toBe(`${NAME}.csv`);
    const rows = csv.text.trim().split('\n');
    expect(rows[0]).toBe('#,Section,Type,Name/Details,Duration');
    expect(rows.slice(1)).toEqual([
      '1,"Lead In","pause","Pause","0:05"',
      '2,"Main","pause","Pause","0:10"',
      '3,"Main","command","All Lights Off","0:00"',
      '4,"Lead Out","pause","Pause","0:07"',
      'Total,,,0:22',
    ]);
  });
});

test.describe('sequence filter', () => {
  test.skip(!container, 'puts sequence files inside the run-web.sh container');
  const SEQ = '/home/fpp/media/sequences';
  const USED = 'fpp-tests-used.fseq';
  const FREE = 'fpp-tests-free.fseq';
  test.beforeEach(() => inPlayer('sh', '-c', `echo x > ${SEQ}/${USED}; echo x > ${SEQ}/${FREE}`));
  test.afterEach(() => inPlayer('rm', '-f', `${SEQ}/${USED}`, `${SEQ}/${FREE}`));

  test('"Hide sequences already in playlist" leaves them out of the new entry\'s list', async ({ page, request }) => {
    // Feature: bd6c12796 (#2501).  A checkbox in the entry editor that drops
    // the sequences the playlist already has from the sequence list.
    await storePlaylist(request, NAME, { mainPlaylist: [{ type: 'sequence', enabled: 1, playOnce: 0, sequenceName: USED }] });
    await openEditor(page);
    await whenModalShown(page, () => page.locator('.playlistEntriesAddNewBtn').first().click());
    await page.selectOption('#pe_type', 'sequence');
    const list = page.locator('.modal.show select.arg_sequenceName');
    // The control: unfiltered, both are offered.
    await expect(list.locator(`option[value="${USED}"]`)).toHaveCount(1);
    await expect(list.locator(`option[value="${FREE}"]`)).toHaveCount(1);
    await page.locator('#filterUsedSequences').check();
    await expect(list.locator(`option[value="${USED}"]`)).toHaveCount(0);
    await expect(list.locator(`option[value="${FREE}"]`)).toHaveCount(1);
    await expect(list).not.toHaveValue('');
    await page.locator('#filterUsedSequences').uncheck();
    await expect(list.locator(`option[value="${USED}"]`)).toHaveCount(1);
  });
});
