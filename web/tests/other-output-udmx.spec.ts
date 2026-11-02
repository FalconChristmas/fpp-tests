import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';

// The uDMX output on the Other page (co-other.php / co-other-modules.php):
// it is offered in the DMX/Serial type list, its row has a description and a
// device choice, and it saves as the type fppd's uDMX output reads
// (scenarios/test_udmx_output.py drives that end).

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

test('uDMX is offered as a DMX/Serial output and saves as type UDMX', async ({ page, request }) => {
  // Regression: 3fadb7305.  The uDMX output was added to the page's
  // output_modules; without that entry the type list had no uDMX, so the
  // output could be configured only by writing co-other.json by hand.
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await expect(page.locator('#addOutputCategoryMenu')).toBeAttached({ timeout: 15_000 });
  await page.locator('#tab-other-DMXSerial-tab').click();
  await page.locator('#tab-other-DMXSerial button', { hasText: 'Add' }).click();
  const type = page.locator('#outputType-DMXSerial');
  await expect(type.locator('option', { hasText: /^uDMX$/ })).toHaveCount(1);
  await type.selectOption('UDMX');
  const row = page.locator('#tblOther-DMXSerial > tbody > tr').last();
  await expect(row.locator('input.description')).toBeVisible();
  await expect(row.locator('select.device')).toBeVisible();
  await row.locator('input.start').fill('1');
  await row.locator('input.count').fill('16');
  await page.locator('#tab-other-DMXSerial input[value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await expect(page.locator('#jGrowl')).toContainText('Channel Output Configuration Saved');
  const saved = await (await request.get('/api/channel/output/co-other')).json();
  const out = saved.channelOutputs.find((o: any) => o.type === 'UDMX');
  expect(out, JSON.stringify(saved)).toBeTruthy();
  expect(out.startChannel).toBe(1);
  expect(out.channelCount).toBe(16);
  expect(out).toHaveProperty('description');
});
