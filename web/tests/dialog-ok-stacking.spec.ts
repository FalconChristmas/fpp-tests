import { test, expect } from './fixtures';
import type { Locator, Page } from '@playwright/test';

// DialogOK()/DialogError() in fpp.js, the shared message box: one reused
// modal, #dialogOKPopup, often opened from inside another dialog.

// Whether a point in the middle of the element reaches it, or something
// drawn over it.
const onTop = (l: Locator) => l.evaluate((el) => {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return !!hit && (hit === el || el.contains(hit));
});
const settled = (page: Page, id: string) =>
  page.waitForFunction((i) => !(window as any).bootstrap.Modal.getInstance(document.getElementById(i))._isTransitioning, id);

// The playlists page with #dialogOKPopup made by an earlier message, then
// the Add Playlist dialog open and its empty-name error raised over it.
async function errorOverAddDialog(page: Page) {
  await page.goto('/playlists.php');
  await page.evaluate(() => (window as any).DialogOK('fpp-tests', 'fpp-tests earlier message'));
  const ok = page.locator('#dialogOKPopup');
  await expect(ok).toBeVisible();
  await ok.locator('.modal-footer button', { hasText: 'Close' }).click();
  await expect(ok).toBeHidden();

  await page.locator('.playlistAddNewBtn').first().click();
  const add = page.locator('#AddPlaylistDialog');
  await expect(add).toBeVisible();
  await settled(page, 'AddPlaylistDialog');
  await add.locator('.modal-footer button', { hasText: 'Add Playlist' }).click();

  await expect(ok).toContainText('The playlist name cannot be empty.');
  await settled(page, 'dialogOKPopup');
  return { ok, add, close: ok.locator('.modal-footer button', { hasText: 'Close' }) };
}

// Closes the error with its own Close button (not by clicking, which
// depends on what is on top: see the first test).
async function closeError(page: Page, ok: Locator) {
  await page.evaluate(() => (window as any).CloseModalDialog('dialogOKPopup'));
  await expect(ok).toBeHidden();
  await page.waitForTimeout(500);
}

test('an error raised from another dialog is drawn over it', async ({ page }) => {
  // Regression: fa0c0138c.  Every Bootstrap modal sits at the same z-index,
  // so the later one in the page wins.  #dialogOKPopup is made once, by
  // the first message, and reused: an error raised from a dialog made
  // after that (here the Add Playlist dialog's empty-name error) opened
  // underneath it, out of reach, and the page looked stuck.
  const { ok, add, close } = await errorOverAddDialog(page);
  expect(await onTop(close), 'the error is over the Add Playlist dialog').toBe(true);
  await close.click();
  await expect(ok).toBeHidden();
  // The control: the Add Playlist dialog is still there behind it.
  await expect(add).toBeVisible();
});

test('closing the error leaves the dialog under it its backdrop', async ({ page }) => {
  // Regression: fpp 804a4a7d2.  Closing the error removed every backdrop
  // on the page and the body's modal-open, so the Add Playlist dialog was
  // left open with nothing dimming or covering the page behind it.
  const { ok, add } = await errorOverAddDialog(page);
  await closeError(page, ok);
  await expect(add).toBeVisible();
  const after = await page.evaluate(() => ({
    backdrops: document.querySelectorAll('.modal-backdrop').length,
    modalOpen: document.body.classList.contains('modal-open'),
  }));
  expect(after, 'the Add Playlist dialog keeps its backdrop').toEqual({ backdrops: 1, modalOpen: true });
  // The page behind is still covered.
  expect(await page.evaluate(() => {
    const hit = document.elementFromPoint(5, window.innerHeight - 5);
    return !!hit && (hit.classList.contains('modal-backdrop') || !!hit.closest('.modal'));
  }), 'the page behind is covered').toBe(true);
});

test('after the error closes, the dialog under it is usable', async ({ page }) => {
  // Regression: fpp 0ebcbce9e.  DialogOK raised "the last backdrop" as it
  // began to show, before its own existed: that was the Add Playlist
  // dialog's, lifted over that dialog.  Once 804a4a7d2 kept it, the dialog
  // was left under its own backdrop, out of reach.
  const { ok, add } = await errorOverAddDialog(page);
  await closeError(page, ok);
  const addClose = add.locator('#modalCloseButton');
  expect(await onTop(addClose), 'the Add Playlist dialog is on top of its backdrop').toBe(true);
  // And with nothing else open, closing it leaves no backdrop behind.
  await addClose.click();
  await expect(add).toBeHidden();
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveClass(/modal-open/);
});
