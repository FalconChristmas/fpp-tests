import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The Choose File dialog on a playlist entry's file arg: opened over the entry
// modal, closed by picking a file.

const NAME = 'fpp-tests-file-chooser';
const IMAGES = ['fpp-tests-chooser-a.png', 'fpp-tests-chooser-b.png'];

async function openNewImageEntry(page: Page) {
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
  await page.evaluate(() => {
    (window as any).fppTestsModalShown = false;
    document.addEventListener('shown.bs.modal', () => { (window as any).fppTestsModalShown = true; }, { once: true });
  });
  await page.locator('.playlistEntriesAddNewBtn').first().click();
  await page.waitForFunction(() => (window as any).fppTestsModalShown);
  await page.selectOption('#pe_type', 'image');
}

async function choose(page: Page, file: string) {
  await page.locator('.arg_row_imagePath input[value="Choose File"]').click();
  const chooser = page.locator('#fileChooserPopup').first();
  await chooser.locator('#fileChooserSelect').locator(`option[value="${file}"]`).waitFor({ state: 'attached' });
  await chooser.locator('#fileChooserSelect').selectOption(file);
  return chooser;
}

// Resolves on the next Bootstrap modal event of that name.
async function armModalEvent(page: Page, name: string) {
  await page.evaluate((n) => {
    (window as any).fppTestsModalEvent = false;
    document.addEventListener(n, () => { (window as any).fppTestsModalEvent = true; }, { once: true });
  }, name);
}

async function openChooserAndClose(page: Page) {
  await armModalEvent(page, 'shown.bs.modal');
  await page.locator('.arg_row_imagePath input[value="Choose File"]').click();
  await page.waitForFunction(() => (window as any).fppTestsModalEvent);
  await armModalEvent(page, 'hidden.bs.modal');
  await page.locator('#fileChooserPopup .close').first().click();
  await page.waitForFunction(() => (window as any).fppTestsModalEvent);
}

test.beforeEach(async ({ request }) => {
  test.skip(!container, "puts files in the run-web.sh container's media");
  inPlayer('sh', '-c', IMAGES.map((f) => `echo x > /home/fpp/media/images/${f}`).join('; '));
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
  });
  expect(r.ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
  if (!container) return;
  await request.delete(`/api/playlist/${NAME}`);
  inPlayer('rm', '-f', ...IMAGES.map((f) => `/home/fpp/media/images/${f}`));
});

test('picking a file closes the chooser, and the entry modal stays open', async ({ page }) => {
  // Regression: 1ec1e46b6.  Bootstrap drops a hide asked for during the show
  // transition, so a pick then left the dialog open.  The long fade puts the
  // pick inside it every time, where the list is there that early.
  await openNewImageEntry(page);
  await page.addStyleTag({ content: '.modal.fade .modal-dialog { transition-duration: 2s !important; }' });
  const chooser = await choose(page, IMAGES[0]);
  await expect(page.locator('.arg_imagePath')).toHaveValue(IMAGES[0]);
  await expect(chooser).toBeHidden();
  await expect(page.locator('.modal.show .modal-title')).toBeVisible();
});

test('opening the chooser again reuses its dialog', async ({ page }) => {
  // Regression: 1ec1e46b6.  It looked for #fileChooser, which never exists, so
  // each open added another #fileChooserPopup to the page.
  await openNewImageEntry(page);
  await openChooserAndClose(page);
  await openChooserAndClose(page);
  await expect(page.locator('[id="fileChooserPopup"]')).toHaveCount(1);
});
