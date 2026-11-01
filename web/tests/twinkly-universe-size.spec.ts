import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

// The E1.31 / ArtNet / DDP tab of Channel Outputs: a Twinkly row addresses a
// flat channel range, so Save must accept more than one universe's 512.

async function saved(request: APIRequestContext) {
  const r = await request.get('/api/channel/output/universeOutputs');
  return r.ok() ? await r.json() : null;
}

test('a Twinkly row of more than 512 channels saves', async ({ page, request }) => {
  // Regression: a8bec7551.  Save checked every row's size against 512 unless
  // it was DDP, so a Twinkly row (type 8) of a longer run was refused with a
  // red size box and nothing written.
  const before = await request.get('/api/channel/output/universeOutputs');
  const beforeText = before.ok() ? await before.text() : null;
  try {
    const r = await request.post('/api/channel/output/universeOutputs', {
      data: {
        channelOutputs: [{
          type: 'universes', enabled: 1, startChannel: 1, channelCount: 1500, universes: [{
            active: 1, description: 'twinkly', id: 1, startChannel: 1, channelCount: 1500, type: 8,
            address: '192.0.2.10', priority: 0, monitor: 0, deDuplicate: 0, universeCount: 1,
          }],
        }],
      },
    });
    expect(r.ok(), await r.text()).toBe(true);
    await page.goto('/channeloutputs.php');
    await expect(page.locator('#tblUniversesBody tr')).toHaveCount(1, { timeout: 15_000 });
    // A change, so a refused Save and a Save that wrote nothing differ.
    await page.locator('#tblUniversesBody tr input.txtSize').fill('1200');
    await page.locator('#btnSaveUniverses').click();
    await expect.poll(async () => (await saved(request))?.channelOutputs?.[0]?.universes?.[0]?.channelCount,
      { timeout: 15_000 }).toBe(1200);
    expect((await saved(request)).channelOutputs[0].universes[0].type).toBe(8);
  } finally {
    await request.post('/api/channel/output/universeOutputs', {
      data: Buffer.from(beforeText && !beforeText.includes('File not found') ? beforeText : '{"channelOutputs": []}'),
    });
  }
});
