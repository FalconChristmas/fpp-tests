import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container } from './container';

// The E1.31 / ArtNet / DDP tab of Channel Outputs warns when universes are
// active but the output itself is switched off, since nothing would be sent.

test.skip(!container, "changes the player's output config");

const universe = (active: number) => ({
  active, description: 'fpp-tests', id: 1, startChannel: 1, universeCount: 1, channelCount: 510,
  type: 1, address: '10.0.0.5', priority: 0, monitor: 0, deDuplicate: 0,
});
const config = (enabled: number, active: number) => ({ channelOutputs: [{
  type: 'universes', enabled, interface: 'eth0', threaded: 1, startChannel: 1, channelCount: -1,
  universes: [universe(active)] }] });

let before: string | null = null;
test.beforeEach(async ({ request }) => {
  const r = await request.get('/api/channel/output/universeOutputs');
  before = r.ok() ? await r.text() : null;
});
test.afterEach(async ({ request }) => {
  await request.post('/api/channel/output/universeOutputs', {
    data: Buffer.from(before && !before.includes('File not found') ? before : '{"channelOutputs": []}') });
});

async function open(page: Page, request: APIRequestContext, enabled: number, active: number) {
  const r = await request.post('/api/channel/output/universeOutputs', { data: config(enabled, active) });
  expect(r.ok(), await r.text()).toBe(true);
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-e131-tab').click();
  await expect(page.locator('#tblUniversesBody > tr')).toHaveCount(1, { timeout: 15_000 });
}

test('active universes under a switched-off output show the warning, which goes when it is switched on', async ({ page, request }) => {
  // Regression: 23bf3298a.
  await open(page, request, 0, 1);
  await expect(page.locator('#outputOffWarning')).toBeVisible();
  await page.locator('#E131Enabled').check();
  await page.locator('input[value="Save"]:visible, button[value="Save"]:visible').first().click();
  await expect(page.locator('#outputOffWarning')).toBeHidden();
});

test('no warning when the universes are inactive or the output is on', async ({ page, request }) => {
  await open(page, request, 0, 0);
  await expect(page.locator('#outputOffWarning')).toBeHidden();
  await open(page, request, 1, 1);
  await expect(page.locator('#outputOffWarning')).toBeHidden();
});
