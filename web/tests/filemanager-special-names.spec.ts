import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';
import { answerUpdateCheck } from './standin-http';
import { fseqV2 } from './fseq';

// File and playlist names with characters a URL gives a meaning to: "#" (a
// fragment), "?" (a query), "+" and "%".  The File Manager put such names
// into API paths as they were, so Sequence Info, Copy, Rename, the script
// editor and Add To Playlist asked the API about a cut-off or garbled name
// and failed, mostly in silence.  Each name is now encoded on its way out
// (364fca0fd).
// (filemanager-info-buttons.spec.ts: Sequence Info with "#".)
//
// Not covered, and known (~/FUTURE.md): limonade decodes a path once more
// after PHP has, so a name that holds a valid escape ("a%41") still arrives
// changed.  The "%" names here are ones that hold no valid escape.

test.skip(!container, 'seeds sequences, scripts and playlists inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const P = 'fpp-tests-odd';

const sh = (script: string) => inPlayer('sh', '-c', script);
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const exists = (p: string) => sh(`test -e ${q(p)} && echo yes || echo no`).trim() === 'yes';

test.beforeEach(async ({ page }) => {
  await answerUpdateCheck(page);
});
test.afterEach(() => {
  sh(`rm -f ${MEDIA}/sequences/${P}* ${MEDIA}/scripts/${P}* ${MEDIA}/playlists/${P}*`);
});

function row(page: Page, table: string, name: string) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page.locator(`#tbl${table} tbody tr`).filter({ has: page.locator('td', { hasText: new RegExp(`^${esc}$`) }) });
}

// Selects a row and waits for the button it enables.  After a rename the
// listing is rebuilt and then rendered again by Bootstrap Table, and a click
// that lands in between loses its selection; select again until it holds.
async function select(page: Page, table: string, name: string, button: string) {
  const r = row(page, table, name);
  const b = page.locator(`#tab-${table.toLowerCase()} input[value="${button}"]`);
  await expect(async () => {
    if (!(await r.evaluate((e) => e.classList.contains('selectedEntry')))) await r.click();
    await expect(b).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  return b;
}

async function fileManager(page: Page, tab: string) {
  await page.goto(`/filemanager.php?fpp-tests=${Date.now()}`);
  await page.locator(`#tab-${tab}-tab`).click();
}

for (const name of [`${P} what?.fseq`, `${P} a+b.fseq`, `${P} 100% on.fseq`, `${P} &=x.fseq`]) {
  test(`Sequence Info works for "${name}"`, async ({ page }) => {
    putFile(`${MEDIA}/sequences/${name}`, fseqV2({ stepMs: 50, channels: 3, frames: 10 }));
    await fileManager(page, 'sequence');
    await row(page, 'Sequences', name).click();
    await page.locator('#tab-sequence input[value="Sequence Info"]').click();
    const dialog = page.locator('#SequenceViewer');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    expect(JSON.parse(await dialog.locator('pre').innerText()).Name).toBe(name);
  });
}

test('Sequence Info for a sequence that has gone says so instead of doing nothing', async ({ page }) => {
  const name = `${P} <b>gone.fseq`;
  putFile(`${MEDIA}/sequences/${name}`, fseqV2({ stepMs: 50, channels: 3, frames: 10 }));
  await fileManager(page, 'sequence');
  await row(page, 'Sequences', name).click();
  sh(`rm -f ${q(`${MEDIA}/sequences/${name}`)}`);
  await page.locator('#tab-sequence input[value="Sequence Info"]').click();
  const dialog = page.locator('#dialogOKPopup');
  await expect(dialog).toContainText(`Could not read the sequence info for ${name}.`);
  // The name is shown as text, not made into markup.
  await expect(dialog.locator('.modal-body b')).toHaveCount(0);
});

test('Rename and Copy work on names with # in them', async ({ page }) => {
  const name = `${P} #1.sh`;
  const renamed = `${P} #2 & more.sh`;
  const copied = `${P} #3?.sh`;
  sh(`printf 'echo hi\\n' > ${q(`${MEDIA}/scripts/${name}`)}`);
  await fileManager(page, 'scripts');

  const rename = await select(page, 'Scripts', name, 'Rename');
  page.once('dialog', (d) => d.accept(renamed));
  await rename.click();
  await expect.poll(() => exists(`${MEDIA}/scripts/${renamed}`)).toBe(true);
  expect(exists(`${MEDIA}/scripts/${name}`), 'a rename moves the original').toBe(false);

  // The listing is redrawn more than once after a rename, dropping the
  // selection under a click; open the tab afresh for the copy.
  await fileManager(page, 'scripts');

  const copy = await select(page, 'Scripts', renamed, 'Copy');
  page.once('dialog', (d) => d.accept(copied));
  await copy.click();
  await expect.poll(() => exists(`${MEDIA}/scripts/${copied}`)).toBe(true);
  expect(sh(`cat ${q(`${MEDIA}/scripts/${copied}`)}`)).toBe('echo hi\n');
  expect(exists(`${MEDIA}/scripts/${renamed}`), 'a copy keeps the original').toBe(true);
});

test('the script editor opens and saves a script with # in its name', async ({ page }) => {
  const name = `${P} #1.sh`;
  sh(`printf 'echo before\\n' > ${q(`${MEDIA}/scripts/${name}`)}`);
  await fileManager(page, 'scripts');
  await row(page, 'Scripts', name).click();
  await page.locator('#tab-scripts input[value="Edit"]').click();
  const dialog = page.locator('#scriptEditorDialog');
  const text = dialog.locator('#scriptText');
  await expect(text).toHaveValue('echo before\n');
  await text.fill('echo after\n');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#jGrowl')).toContainText('Script saved.');
  expect(sh(`cat ${q(`${MEDIA}/scripts/${name}`)}`)).toBe('echo after\n');
});

test('Add To Playlist adds a sequence with # in its name, timed, to a playlist with # in its name', async ({ page, request }) => {
  const playlist = `${P} show #1`;
  const seq = `${P} song #2.fseq`;
  const r = await request.post(`/api/playlist/${encodeURIComponent(playlist)}`, {
    data: { name: playlist, version: 3, repeat: 0, loopCount: 0, empty: true, desc: '', random: 0,
      leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: { total_duration: 0, total_items: 0 } },
  });
  expect(r.ok(), await r.text()).toBe(true);
  putFile(`${MEDIA}/sequences/${seq}`, fseqV2({ stepMs: 50, channels: 3, frames: 200 }));

  await page.goto(`/filemanager.php?fpp-tests=${Date.now()}`);
  await expect(page.locator('#tblMusic tbody tr').first()).toBeAttached();
  await page.locator('#tab-sequence-tab').click();
  await row(page, 'Sequences', seq).click();
  await page.locator('#tab-sequence input[value="Add To Playlist"]').click();
  const dialog = page.locator('#bulkAdd');
  await expect(dialog).toBeVisible();
  // The length comes from api/sequence/<name>/meta: 200 frames of 50 ms.
  await expect(dialog.locator('#bulkAddList td.file')).toHaveAttribute('duration', '10');
  await dialog.locator('#bulkAddPlaylist').selectOption(playlist);
  await dialog.locator('#bulkAddAddButton').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#jGrowl')).toContainText('Playlist updated');
  const pl = JSON.parse(sh(`cat ${q(`${MEDIA}/playlists/${playlist}.json`)}`));
  expect(pl.mainPlaylist.map((e: any) => [e.type, e.sequenceName, e.duration])).toEqual([['sequence', seq, 10]]);
});

test('the Playlists page opens a playlist with # in its name', async ({ page, request }) => {
  const playlist = `${P} show #1`;
  const r = await request.post(`/api/playlist/${encodeURIComponent(playlist)}`, {
    data: { name: playlist, version: 3, repeat: 0, loopCount: 0, empty: false, desc: 'odd one', random: 0,
      leadIn: [], mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 7 }], leadOut: [],
      playlistInfo: { total_duration: 7, total_items: 1 } },
  });
  expect(r.ok(), await r.text()).toBe(true);
  await page.goto(`/playlists.php?fpp-tests=${Date.now()}`);
  await page.locator('.playlistCard h3', { hasText: playlist }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
  await expect(page.getByText('Error loading playlist details!')).toHaveCount(0);
  await page.locator('.editPlaylistBtn').first().click();
  await expect(page.locator('#EditPlaylistDetailsDialog #txtPlaylistDesc')).toHaveValue('odd one');
});
