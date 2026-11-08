import { test, expect } from './fixtures';
import type { APIRequestContext, Locator, Page } from '@playwright/test';

// The playlist editor's entries are moved by dragging them (jQuery UI
// sortable, one list per section, connected): up and down a section, and
// between Lead In, Main Playlist and Lead Out.  A row's Delete button takes it
// out.  Nothing is saved until Save Playlist; what Save stores is each
// section's rows in their order, with the per-section counts and lengths.
// Pauses of different lengths tell the entries apart.
// (playlist-entry-insert.spec.ts: where New Entry puts an entry.)

const NAME = 'fpp-tests-move';
const pause = (duration: number) => ({ type: 'pause', enabled: 1, playOnce: 0, duration });

async function put(request: APIRequestContext, leadIn: number[], main: number[], leadOut: number[]) {
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, playlistInfo: {},
      leadIn: leadIn.map(pause), mainPlaylist: main.map(pause), leadOut: leadOut.map(pause) },
  });
  expect(r.ok()).toBe(true);
}
test.afterEach(async ({ request }) => { await request.delete(`/api/playlist/${NAME}`); });

const section = (page: Page, s: 'LeadIn' | 'MainPlaylist' | 'LeadOut') => page.locator(`#tblPlaylist${s} tr.playlistRow`);

async function open(page: Page) {
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
}

async function stored(page: Page, request: APIRequestContext) {
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/playlist/${NAME}`);
  await page.locator('.savePlaylistBtn').first().click();
  expect((await saved).ok()).toBe(true);
  const pl = await (await request.get(`/api/playlist/${NAME}`)).json();
  const d = (es: any[]) => es.map((e) => Number(e.duration));
  return { leadIn: d(pl.leadIn), main: d(pl.mainPlaylist), leadOut: d(pl.leadOut), info: pl.playlistInfo };
}

// Drags row `from` to just above (or below) `to`, which may be another
// section's row or its empty placeholder.  The sortable starts a drag only
// once the pointer has moved a few pixels, and picks the drop from where the
// pointer passes, so the move is made in small steps.
async function drag(page: Page, from: Locator, to: Locator, where: 'above' | 'below' = 'above') {
  const a = (await from.boundingBox())!;
  await page.mouse.move(a.x + 30, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 30, a.y + a.height / 2 + 8, { steps: 4 });
  // Measured once the drag has begun: lifting the row out of its section
  // moves the rows after it.
  const b = (await to.boundingBox())!;
  const y = where === 'above' ? b.y + 3 : b.y + b.height - 3;
  await page.mouse.move(b.x + 30, y, { steps: 15 });
  // The sortable places the item by the way the pointer is moving, so the
  // last nudge keeps going the way the drag went.
  const down = b.y > a.y;
  await page.mouse.move(b.x + 30, y + (down ? 1 : -1), { steps: 2 });
  await page.mouse.up();
}

test('an entry dragged up its section is saved in its new place', async ({ page, request }) => {
  await put(request, [], [1, 2, 3], []);
  await open(page);
  const main = section(page, 'MainPlaylist');
  await expect(main).toHaveCount(3);
  await drag(page, main.nth(2), main.nth(0));
  await expect(page.locator('.savePlaylistBtnHasChange')).toBeVisible();
  const s = await stored(page, request);
  expect(s.main).toEqual([3, 1, 2]);
  expect(s.info).toMatchObject({ mainPlaylist_items: 3, total_items: 3 });
});

test('an entry dragged from Lead In to Main Playlist is saved there, and Lead In saved empty', async ({ page, request }) => {
  await put(request, [4], [1, 2], [8]);
  await open(page);
  // Dropped between Main Playlist's two entries.
  await drag(page, section(page, 'LeadIn').nth(0), section(page, 'MainPlaylist').nth(1));
  await expect(section(page, 'LeadIn')).toHaveCount(0);
  await expect(section(page, 'MainPlaylist')).toHaveCount(3);
  const s = await stored(page, request);
  expect(s).toMatchObject({ leadIn: [], main: [1, 4, 2], leadOut: [8] });
  expect(s.info).toMatchObject({ leadIn_items: 0, leadIn_duration: 0, mainPlaylist_items: 3, mainPlaylist_duration: 7,
    leadOut_items: 1, total_items: 4, total_duration: 15 });
});

test('an entry can be dragged into an empty section', async ({ page, request }) => {
  // An emptied section keeps a placeholder row to drop on.
  await put(request, [], [1, 2], []);
  await open(page);
  await drag(page, section(page, 'MainPlaylist').nth(1), page.locator('#tblPlaylistLeadOutPlaceHolder'));
  await expect(section(page, 'LeadOut')).toHaveCount(1);
  await expect(page.locator('#tblPlaylistLeadOutPlaceHolder')).toHaveCount(0);
  const s = await stored(page, request);
  expect(s).toMatchObject({ leadIn: [], main: [1], leadOut: [2] });
});

test('an entry moved out of a section and back leaves no empty row behind', async ({ page, request }) => {
  // While its only entry is dragged out, a section gets a placeholder row to
  // drop on again; one that ends up holding the entry keeps none.
  await put(request, [4], [1], []);
  await open(page);
  const leadIn = section(page, 'LeadIn');
  await drag(page, leadIn.nth(0), section(page, 'MainPlaylist').nth(0), 'below');
  await expect(leadIn).toHaveCount(0);
  await drag(page, section(page, 'MainPlaylist').nth(1), page.locator('#tblPlaylistLeadInPlaceHolder'));
  await expect(leadIn).toHaveCount(1);
  await expect(page.locator('#tblPlaylistLeadIn > tr:not(.playlistRow)')).toHaveCount(0);
  await expect(page.locator('#tblPlaylistMainPlaylist > tr:not(.playlistRow)')).toHaveCount(0);
  const s = await stored(page, request);
  expect(s).toMatchObject({ leadIn: [4], main: [1], leadOut: [] });
});

test("a row's Delete button takes out that entry only, and the lengths follow", async ({ page, request }) => {
  await put(request, [], [1, 2, 3], []);
  await open(page);
  const main = section(page, 'MainPlaylist');
  await main.nth(1).locator('.playlistRowDeleteButton').click();
  await expect(main).toHaveCount(2);
  expect((await (await request.get(`/api/playlist/${NAME}`)).json()).mainPlaylist.length, 'Delete saves nothing by itself').toBe(3);
  const s = await stored(page, request);
  expect(s.main).toEqual([1, 3]);
  expect(s.info).toMatchObject({ mainPlaylist_items: 2, mainPlaylist_duration: 4, total_duration: 4 });
});
