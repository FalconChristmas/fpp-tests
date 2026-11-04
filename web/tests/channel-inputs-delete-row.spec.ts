import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';

// Channel Inputs' E1.31 universe table: Delete removes the selected row.

test.skip(!container, 'changes the player\'s input config');

let before: string | null = null;
const config = async (request: APIRequestContext) => {
  const r = await request.get('/api/channel/output/universeInputs');
  return r.ok() ? r.text() : null;
};
const store = (request: APIRequestContext, body: string) =>
  request.post('/api/channel/output/universeInputs', { data: Buffer.from(body) });

test.beforeEach(async ({ request }) => { before = await config(request); });
test.afterEach(async ({ request }) => { await store(request, before ?? '{"channelInputs": []}'); });

test('Delete removes the universe row that was clicked, not the one below it', async ({ page, request }) => {
  // Regression: 78792aaf9 ("fix Channel Input selected row bug").  The
  // clicked row's index was counted among all of the table's rows, its
  // header row included, so it came out one too high and Delete removed the
  // row after the one selected.
  const universe = (id: number, startChannel: number) => ({
    active: 1, description: `fpp-tests ${id}`, id, startChannel, universeCount: 1,
    channelCount: 512, type: 0, address: '', priority: 0,
  });
  expect((await store(request, JSON.stringify({ channelInputs: [{
    type: 'universes', enabled: 1, startChannel: 1, channelCount: -1, timeout: 1000,
    universes: [universe(7201, 1), universe(7202, 513), universe(7203, 1025)],
  }] }))).ok()).toBe(true);

  await page.goto('/channelinputs.php');
  const rows = page.locator('#tblUniversesBody > tr');
  await expect(rows).toHaveCount(3, { timeout: 15_000 });
  const ids = () => rows.locator('input.txtUniverse').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  expect(await ids()).toEqual(['7201', '7202', '7203']);
  await rows.nth(1).locator('td').first().dispatchEvent('mousedown');
  await expect(rows.nth(1)).toHaveClass(/selectedEntry/);
  await page.locator('#btnDeleteUniverses').click();
  await expect(rows).toHaveCount(2);
  expect(await ids()).toEqual(['7201', '7203']);
});
