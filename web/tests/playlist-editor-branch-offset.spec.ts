import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The playlist editor's limits on a Branch entry's jump targets.

async function gotoPage(page: Page, path: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await page.goto(path, { waitUntil: 'commit', timeout: 5_000 });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(750);
    }
  }
  throw lastError;
}

test("a Branch's false offset can be negative", async ({ page }) => {
  // Regression: 86d7d225d.  BranchTypeChanged had the false branch's Index and
  // Offset limits swapped: an Offset got Index's 1..99, and a negative offset
  // was rewritten to 1 whenever either branch's type changed.  The true
  // branch is the control: it always had them right.
  const name = 'PlaywrightBranchOffset';
  await page.request.delete(`/api/playlist/${name}`);
  await page.request.post(`/api/playlist/${name}`, {
    data: { name, version: 4, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
  });
  try {
    await gotoPage(page, '/playlists.php');
    await page.locator('.playlistCard h3', { hasText: new RegExp(`^${name}$`) }).click();
    await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
    await page.locator('.playlistEntriesAddNewBtn').first().click();
    await page.selectOption('#pe_type', 'branch');

    for (const branch of ['true', 'false']) {
      const type = page.locator(`select.arg_${branch}NextBranchType`);
      const item = page.locator(`.arg_${branch}NextItem`);
      await type.selectOption('Offset');
      await expect(item, `the ${branch} branch's Item field`).toBeVisible();
      await item.fill('-2');
      // Any branch type change re-applies both branches' limits.
      await page.locator('select.arg_trueNextBranchType').dispatchEvent('change');
      await expect(item, `the ${branch} branch's offset`).toHaveValue('-2');
      await expect(item).toHaveAttribute('min', '-99');

      await type.selectOption('Index');
      await expect(item, `the ${branch} branch's index`).toHaveAttribute('min', '1');
      await expect(item).toHaveValue('1');
    }
  } finally {
    await page.request.delete(`/api/playlist/${name}`);
  }
});
