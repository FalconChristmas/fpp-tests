import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// A Branch entry's argument rows follow its Test Condition: only the rows of
// the chosen condition show, and the nested Iteration rows under Loop Test
// follow Loop Test being shown.

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

test("a new Branch entry shows only its Test Condition's rows, nested ones included", async ({ page }) => {
  // Regression: 02b0dd5bd (#1413).  PlaylistTypeChanged drew the Branch
  // fields but never applied the condition's child visibility, so choosing
  // Branch showed the rows of every condition at once (start/end time, loop
  // test, MQTT topic and message); and a nested child (Iteration Start/Count
  // under Loop Test) was decided by whether its parent row was visible at
  // that moment, not by whether the parent itself was being hidden.
  const name = 'PlaywrightBranchRows';
  await page.request.delete(`/api/playlist/${name}`);
  await page.request.post(`/api/playlist/${name}`, {
    data: { name, version: 4, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
  });
  const row = (arg: string) => page.locator(`.arg_row_${arg}`);
  const shown = async (...args: string[]) => {
    for (const a of args) await expect(row(a), `${a} row`).toBeVisible();
  };
  const hidden = async (...args: string[]) => {
    for (const a of args) await expect(row(a), `${a} row`).toBeHidden();
  };
  try {
    await gotoPage(page, '/playlists.php');
    await page.locator('.playlistCard h3', { hasText: new RegExp(`^${name}$`) }).click();
    await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
    await page.locator('.playlistEntriesAddNewBtn').first().click();
    await page.selectOption('#pe_type', 'branch');

    // Straight after choosing Branch: the default condition, Time.
    await expect(page.locator('select.arg_branchTest')).toHaveValue('Time');
    await shown('startTime', 'endTime');
    await hidden('loopTest', 'iterationStart', 'iterationCount', 'mqttTopic', 'mqttMessage');

    await page.selectOption('select.arg_branchTest', 'Loop');
    await shown('loopTest', 'iterationStart', 'iterationCount');
    await hidden('startTime', 'endTime', 'mqttTopic', 'mqttMessage');

    await page.selectOption('select.arg_branchTest', 'MQTT');
    await shown('mqttTopic', 'mqttMessage');
    await hidden('startTime', 'endTime', 'loopTest', 'iterationStart', 'iterationCount');

    // Back to Loop: the nested rows come back with their parent.
    await page.selectOption('select.arg_branchTest', 'Loop');
    await shown('loopTest', 'iterationStart', 'iterationCount');
  } finally {
    await page.request.delete(`/api/playlist/${name}`);
  }
});
