import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// An Image entry in the playlist editor, and the "Image File Not Found"
// warning the editor puts under one whose file the images directory lacks.

test.skip(!container, 'seeds an image inside the run-web.sh container');

const NAME = 'fpp-tests-image-path';
const IMAGES = '/home/fpp/media/images';

async function storePlaylist(request: APIRequestContext, imagePath: string) {
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: {
      name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], leadOut: [], playlistInfo: {},
      mainPlaylist: [{ type: 'image', enabled: 1, playOnce: 0, imagePath, modelName: 'fpp-tests-model' }],
    },
  });
  expect(r.ok(), `storing ${NAME}: ${r.status()}`).toBe(true);
}

// Opens the playlist and saves its one entry through the entry editor,
// which is when the editor checks the entry's file.
async function openAndResave(page: Page) {
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
  await expect(page.locator('#tblPlaylistMainPlaylist tr.playlistRow')).toHaveCount(1);
  await page.evaluate(() => {
    (window as any).fppTestsModalShown = false;
    document.addEventListener('shown.bs.modal', () => { (window as any).fppTestsModalShown = true; }, { once: true });
  });
  await page.locator('.playlistRowEditButton').first().click();
  await page.waitForFunction(() => (window as any).fppTestsModalShown);
  const modal = page.locator('.modal.show');
  await expect(modal.locator('.modal-title')).toHaveText('Edit Entry');
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(modal).toBeHidden();
}

test.afterEach(async ({ request }) => {
  await request.delete(`/api/playlist/${NAME}`);
  inPlayer('rm', '-rf', `${IMAGES}/fpp-tests-image-path`);
});

test('an Image entry naming its file by full path is not reported missing', async ({ page, request }) => {
  // Regression: 16f8ea7ab.  The editor looked a full path up among the
  // images directory's file names, never found it, and marked the entry
  // "ERROR: Image File ... Not Found" though the file was there.
  inPlayer('sh', '-c', `mkdir -p ${IMAGES}/fpp-tests-image-path && printf x > ${IMAGES}/fpp-tests-image-path/a.png`);
  const row = page.locator('#tblPlaylistMainPlaylist tr.playlistRow');
  const full = `${IMAGES}/fpp-tests-image-path/a.png`;
  await storePlaylist(request, full);
  await openAndResave(page);
  await expect(row.locator('.field_imagePath').first()).toHaveText(full);
  await page.waitForTimeout(500);
  await expect(row, 'a full path was reported missing').not.toContainText('Not Found');
  // The control: a plain name the images directory lacks is reported.
  await storePlaylist(request, 'fpp-tests-no-such-image.png');
  await openAndResave(page);
  await expect(row).toContainText('Image File "fpp-tests-no-such-image.png" Not Found');
});
