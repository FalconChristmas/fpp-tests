import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';

// A DDP output on the E1.31 / ArtNet / DDP tab of Channel Outputs
// (co-universes.php) is one flat run of channels, not 512-channel universes.
// Its size is limited by fppd's channel-space limit (FPPD_MAX_CHANNELS), the
// same as the other channel outputs, not by a 512000-channel constant.

test.skip(!container, "changes the player's output config");

const SIZE = 600000;
const config = () => ({ channelOutputs: [{ type: 'universes', enabled: 1, interface: 'eth0',
  threaded: 1, startChannel: 1, channelCount: -1, universes: [{ active: 1, description: 'fpp-tests ddp', id: 1,
    startChannel: 1, universeCount: 1, channelCount: SIZE, type: 5, address: '10.0.0.5', priority: 0, monitor: 0, deDuplicate: 0 }] }] });

const stored = async (request: APIRequestContext) =>
  (await (await request.get('/api/channel/output/universeOutputs')).json()).channelOutputs[0].universes[0];

let before: string | null = null;
test.beforeEach(async ({ request }) => {
  const r = await request.get('/api/channel/output/universeOutputs');
  before = r.ok() ? await r.text() : null;
});
test.afterEach(async ({ request }) => {
  await request.post('/api/channel/output/universeOutputs', {
    data: Buffer.from(before && !before.includes('File not found') ? before : '{"channelOutputs": []}'),
  });
});

test('a DDP output of more than 512000 channels is accepted and saved', async ({ page, request }) => {
  // Regression: fd83052ed.  The size field and its validation capped a DDP
  // output at 512000 channels, so a larger run could not be entered or
  // saved; the cap is now the channel-space limit.
  const r = await request.post('/api/channel/output/universeOutputs', { data: config() });
  expect(r.ok()).toBe(true);
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-e131-tab').click();
  const row = page.locator('#tblUniversesBody > tr').first();
  await expect(row.locator('input.txtIP')).toHaveValue('10.0.0.5', { timeout: 15_000 });
  const size = row.locator('input.txtSize');
  const limit = await page.evaluate(() => (window as any).FPPD_MAX_CHANNELS as number);
  expect(limit).toBeGreaterThan(SIZE);
  await expect(size).toHaveAttribute('max', String(limit));
  await size.fill(String(SIZE));
  await size.dispatchEvent('change');
  expect(await page.evaluate(() => (window as any).validateUniverseData())).toBe(true);
  await expect(size).toHaveValue(String(SIZE));

  await page.locator('#frmUniverses input[value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await expect.poll(async () => (await stored(request)).channelCount, { timeout: 5_000 }).toBe(SIZE);
});
