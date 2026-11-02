import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

// The Virtual Matrix output's row on the Other Outputs page.

let before: string | null = null;
test.beforeEach(async ({ request }) => {
  const r = await request.get('/api/channel/output/co-other');
  before = r.ok() ? await r.text() : null;
});
test.afterEach(async ({ request }) => {
  await request.post('/api/channel/output/co-other', { data: Buffer.from(before ?? '{"channelOutputs": []}') });
});

async function put(request: APIRequestContext, outputs: object[]) {
  const r = await request.post('/api/channel/output/co-other', { data: { channelOutputs: outputs } });
  expect(r.ok(), await r.text()).toBe(true);
}

test('a virtual matrix output\'s start channel can be edited, its count cannot', async ({ page, request }) => {
  // Regression: a45dddec4.  The module was created with a fixed start
  // channel, so the Start Channel box was disabled and a matrix could not be
  // placed anywhere but channel 1; the count is the matrix's size and stays
  // fixed.
  await put(request, [{ type: 'VirtualMatrix', enabled: 0, startChannel: 1, channelCount: 4608, width: 32, height: 16,
    layout: '32x16', colorOrder: 'RGB', invert: 0, device: 'fb0', scaling: 'Hardware', modelName: '' }]);
  await page.goto('/channeloutputs.php');
  await expect(page.locator('#addOutputCategoryMenu')).toBeAttached({ timeout: 15_000 });
  await page.locator('#tab-other-VirtualDisplay-tab').click();
  const row = page.locator('#tblOther-VirtualDisplay > tbody > tr').first();
  await expect(row.locator('input.count')).toBeDisabled();
  await expect(row.locator('input.start')).toBeEnabled();
  await row.locator('input.start').fill('1001');
  await page.locator('#tab-other-VirtualDisplay input[value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await expect.poll(async () => {
    const o = ((await (await request.get('/api/channel/output/co-other')).json()).channelOutputs as any[]).find((x) => x.type === 'VirtualMatrix');
    return o?.startChannel;
  }, { timeout: 15_000 }).toBe(1001);
});
