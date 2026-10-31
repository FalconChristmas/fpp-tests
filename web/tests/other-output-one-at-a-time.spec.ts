import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';

// Adding an "Other" channel output (co-other.php) puts a row with a type
// select in its category's table; the row's fields are drawn once a type is
// picked, so the page takes one new output at a time.

test.skip(!container, "changes the player's output config");

async function keep(request: APIRequestContext) {
  const r = await request.get('/api/channel/output/co-other');
  return r.ok() ? await r.text() : null;
}

let before: string | null = null;
test.beforeEach(async ({ request }) => {
  before = await keep(request);
  const r = await request.post('/api/channel/output/co-other', { data: { channelOutputs: [{
    type: 'GenericUDP', enabled: 1, startChannel: 1, channelCount: 3, address: '127.0.0.1', port: 9999,
    tokenData: '{data}', description: '' }] } });
  expect(r.ok(), await r.text()).toBe(true);
});
test.afterEach(async ({ request }) => {
  await request.post('/api/channel/output/co-other', { data: Buffer.from(before ?? '{"channelOutputs": []}') });
});

test('a second Add before the new output has a type is refused', async ({ page }) => {
  // Regression: 49f1e9ca0.  Each Add put in another row with the same type
  // select (one id for all of them), so a second Add before picking a type
  // left rows that could no longer be told apart; it now asks for the new
  // row to be configured first.
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await expect(page.locator('#addOutputCategoryMenu')).toBeAttached({ timeout: 15_000 });
  await page.locator('#tab-other-DMXSerial-tab').click();
  const rows = page.locator('#tblOther-DMXSerial > tbody > tr');
  await expect(rows).toHaveCount(1);
  const add = page.locator('#tab-other-DMXSerial button', { hasText: 'Add' });
  await add.click();
  await expect(rows).toHaveCount(2);
  await add.click();
  await expect(page.locator('.modal.show')).toContainText('Configure One Output At a Time');
  await expect(rows).toHaveCount(2);
  await expect(page.locator('#outputType-DMXSerial')).toHaveCount(1);
});
