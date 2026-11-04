import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// An entry added in the playlist editor is measured as it goes in: its length
// comes from the file, and a file that isn't there is said so on the row.  The
// lists in the New Entry modal are read when it opens, so the way to add a
// file that is gone is the one a user has: it is deleted with the modal open.

test.skip(!container, "puts files in the run-web.sh container's media");

const NAME = 'fpp-tests-entry-file-gone';
const SEQ = 'fpp-tests-gone-seq.fseq';
const MEDIA = 'fpp-tests-gone-media.mp3';
const seqPath = `/home/fpp/media/sequences/${SEQ}`;
const mediaPath = `/home/fpp/media/music/${MEDIA}`;

test.beforeEach(async ({ page, request }) => {
  inPlayer('sh', '-c', `echo x > ${seqPath}; echo x > ${mediaPath}`);
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
  });
  expect(r.ok()).toBe(true);
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
  await page.evaluate(() => {
    (window as any).fppTestsModalShown = false;
    document.addEventListener('shown.bs.modal', () => { (window as any).fppTestsModalShown = true; }, { once: true });
  });
  await page.locator('.playlistEntriesAddNewBtn').first().click();
  await page.waitForFunction(() => (window as any).fppTestsModalShown);
});

test.afterEach(async ({ request }) => {
  inPlayer('rm', '-f', seqPath, mediaPath);
  await request.delete(`/api/playlist/${NAME}`);
});

async function addEntry(page: Page) {
  await page.locator('.modal.show').getByRole('button', { name: 'Add', exact: true }).click();
  const row = page.locator('#tblPlaylistMainPlaylist tr.playlistRow');
  await expect(row).toHaveCount(1);
  return row;
}

test('a Seq+Media entry whose sequence is gone shows no length, and says the sequence is missing', async ({ page }) => {
  // Regression: f6eac686f.  The missing sequence's duration of -1 became the
  // entry's, and the row showed it as a length.  The media's duration is the
  // test's: the file here is only a name.
  await page.route('**/api/media/*/duration', (route) => route.fulfill({ json: { [MEDIA]: { duration: 30 } } }));
  const modal = page.locator('.modal.show');
  await page.selectOption('#pe_type', 'both');
  await modal.locator('select.arg_mediaName').selectOption(MEDIA);
  await modal.locator('select.arg_sequenceName').selectOption(SEQ);
  inPlayer('rm', '-f', seqPath);
  const row = await addEntry(page);
  await expect(row).toContainText(`ERROR: Sequence "${SEQ}" Not Found`);
  await expect(row.locator('.humanDuration')).toHaveText('');
});

test('a sequence entry whose file is gone names the file', async ({ page }) => {
  // Feature: 5106ac8b7 ("Display errors in playlist UI when a media or
  // sequence file does not exist").
  const modal = page.locator('.modal.show');
  await page.selectOption('#pe_type', 'sequence');
  await modal.locator('select.arg_sequenceName').selectOption(SEQ);
  inPlayer('rm', '-f', seqPath);
  const row = await addEntry(page);
  await expect(row).toContainText(`ERROR: Sequence "${SEQ}" Not Found`);
  await expect(row.locator('.humanDuration')).toHaveText('');
});

test('a media entry whose file is gone names the file', async ({ page }) => {
  // Feature: 5106ac8b7, as above; the media API answers 404 for the file.
  const modal = page.locator('.modal.show');
  await page.selectOption('#pe_type', 'media');
  await modal.locator('select.arg_mediaName').selectOption(MEDIA);
  inPlayer('rm', '-f', mediaPath);
  const row = await addEntry(page);
  await expect(row).toContainText(`ERROR: Media File "${MEDIA}" Not Found`);
  await expect(row.locator('.humanDuration')).toHaveText('');
});
