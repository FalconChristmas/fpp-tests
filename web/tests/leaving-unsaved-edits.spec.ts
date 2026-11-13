import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';

// Leaving a page with edits not saved yet, by the FPP menu (the usual way
// off a page).  The Playlists page asks Save / Discard / Cancel (fpp
// c2ca8ba09, fpp.spec.ts has its buttons); the scheduler and the E1.31 /
// ArtNet / DDP outputs, where the longest edits are made, go without a word
// and the edits are lost.  Nothing is saved by these tests.

test.skip(!container, 'adds a scratch playlist on the player');

const NAME = 'fpp-tests-leave';

test.beforeEach(async ({ request }) => {
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], leadOut: [], playlistInfo: {},
            mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 30 }] },
  });
  expect(r.ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
  await request.delete(`/api/playlist/${NAME}`);
});

// Click the menu's Status/Control link; return whether the page stayed put
// or asked, rather than navigating away.
async function leaveByMenu(page: Page) {
  const from = page.url();
  await page.evaluate(() => (document.querySelector('a[href="index.php"]') as HTMLAnchorElement).click());
  await page.waitForTimeout(1500);
  const asked = await page.locator('.modal.show').count();
  return { stayed: page.url() === from, asked: asked > 0 };
}

test('the Playlists page asks before the menu takes away unsaved edits', async ({ page }) => {
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/, { timeout: 15_000 });
  await page.evaluate(() => (window as any).markCurrentPlaylistModified(true));
  expect(await leaveByMenu(page)).toEqual({ stayed: true, asked: true });
  await expect(page.locator('#UnsavedPlaylistDialog')).toContainText('has changes that have not been saved');
});

test('the scheduler asks before the menu takes away an entry not saved', async ({ page }) => {
  test.fail(true, 'scheduler.php has no unsaved-edit check: the menu leaves and the new entry is lost (FUTURE.md)');
  await page.goto('/scheduler.php');
  await expect(page.locator('.fppTableRowTemplate .schPlaylist option', { hasText: NAME })).toHaveCount(1);
  const rows = page.locator('#tblScheduleBody > tr');
  const n = await rows.count();
  await page.locator('[onclick="AddScheduleEntry();"]:visible').first().click();
  await expect(rows).toHaveCount(n + 1);
  await rows.nth(n).locator('.schPlaylist').selectOption(NAME);
  expect(await leaveByMenu(page), 'left without asking').toEqual({ stayed: true, asked: true });
});

test('the E1.31 / DDP outputs ask before the menu takes away an edit not saved', async ({ page }) => {
  test.fail(true, 'co-universes.php has no unsaved-edit check: the menu leaves and the edit is lost (FUTURE.md)');
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-e131-tab').click();
  await expect(page.locator('#btnSaveUniverses')).toBeEnabled({ timeout: 15_000 });
  // A universe added with Outputs Count / Set, and not saved.
  const rows = page.locator('#tblUniversesBody > tr');
  const n = await rows.count();
  await page.locator('#txtUniverseCount').fill(String(n + 1));
  await page.locator('#btnUniverseCount').click();
  await expect(rows).toHaveCount(n + 1);
  expect(await leaveByMenu(page), 'left without asking').toEqual({ stayed: true, asked: true });
});
