import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';
import { fseqV2 } from './fseq';

// The File Manager's own Play buttons, which many people use to try a
// sequence they have just uploaded: Play starts it and takes the browser to
// the status page, and Play Here starts it and stays.  Both run on the
// player's own fppd (a 6 s sequence of 3 channels, no audio), stopped after.
// Also View on the Images tab, for an image whose name has an apostrophe and
// a # in it, as names of props often do.

test.skip(!container, 'puts a sequence and an image on the run-web.sh player');

const SEQ = 'fpp-tests-fm-play.fseq';
const SEQ_PATH = `/home/fpp/media/sequences/${SEQ}`;
const IMG = "fpp-tests Santa's sleigh #1.png";
const IMG_PATH = `/home/fpp/media/images/${IMG}`;
// A 2x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8DwnwEIGAEADwYC/0Z3ofgAAAAASUVORK5CYII=', 'base64');

test.beforeAll(() => {
  putFile(SEQ_PATH, fseqV2({ stepMs: 50, channels: 3, frames: 120 }));
  inPlayer('mkdir', '-p', '/home/fpp/media/images');
  // putFile quotes the path for sh: write a plain name, then move it.
  putFile('/home/fpp/media/images/fpp-tests-fm-view.png', PNG);
  inPlayer('mv', '/home/fpp/media/images/fpp-tests-fm-view.png', IMG_PATH);
});
test.afterAll(() => inPlayer('rm', '-f', SEQ_PATH, IMG_PATH));
test.afterEach(async ({ request }) => { await request.post('/api/playlists/stop'); });

async function pick(page: Page, tab: string, table: string, name: string) {
  await page.goto(`/filemanager.php?fpp-tests=${Date.now()}#tab-${tab}`);
  await page.locator(`#tab-${tab}-tab`).click();
  const row = page.locator(`#tbl${table} tbody tr`).filter({ has: page.locator('td', { hasText: name }) }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(row).toHaveClass(/selectedEntry/);
  return page.locator(`#tab-${tab}`);
}
const playing = async (page: Page) => (await (await page.request.get('/api/fppd/status')).json()).current_sequence;

test('Play starts the sequence picked and goes to the status page', async ({ page }) => {
  const pane = await pick(page, 'sequence', 'Sequences', SEQ);
  await pane.locator('input[value="Play"]').click();
  await expect(page).toHaveURL(/index\.php/, { timeout: 10_000 });
  await expect.poll(() => playing(page), { timeout: 10_000 }).toBe(SEQ);
  await expect(page.locator('#txtPlayerStatus')).toContainText(/playing/i, { timeout: 10_000 });
});

test('Play Here starts the sequence picked and stays in the File Manager', async ({ page }) => {
  const pane = await pick(page, 'sequence', 'Sequences', SEQ);
  await pane.locator('input[value="Play Here"]').click();
  await expect.poll(() => playing(page), { timeout: 10_000 }).toBe(SEQ);
  await expect(page.locator('.jGrowl-notification', { hasText: 'Playlist Started' })).toBeVisible();
  await expect(page).toHaveURL(/filemanager\.php/);
  await expect(pane.locator('tr.selectedEntry')).toHaveCount(1);
});

test("View shows an image whose name has an apostrophe and a #", async ({ page }) => {
  const pane = await pick(page, 'images', 'Images', IMG);
  await pane.locator('input[value="View"]').click();
  const img = page.locator('.modal.show img, .ui-dialog:visible img').first();
  await expect(img).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth), { timeout: 10_000 }).toBe(2);
  // The link to full size opens the same image.
  const href = await img.locator('xpath=ancestor::a[1]').getAttribute('href');
  const r = await page.request.get(href!);
  expect(r.ok()).toBe(true);
  expect(r.headers()['content-type']).toContain('image/png');
});
