import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

// What the Channel Outputs pages write back: rows of a type the page has no
// editor for, and the universe count of rows that have none.

async function saved(request: APIRequestContext, file: string) {
  const r = await request.get(`/api/channel/output/${file}`);
  return r.ok() ? await r.json() : null;
}

async function keep(request: APIRequestContext, file: string) {
  const r = await request.get(`/api/channel/output/${file}`);
  return r.ok() ? await r.text() : null;
}

async function restore(request: APIRequestContext, file: string, before: string | null) {
  await request.post(`/api/channel/output/${file}`, {
    data: Buffer.from(before ?? '{"channelOutputs": []}'),
  });
}

test('an output the Other page has no editor for is shown on Misc and kept on save', async ({ page, request }) => {
  // Regression: dbaf08dfb.  An entry whose type the page does not know (a
  // plugin's output, say) was filed under a "Misc" category that was never
  // created, so its row never showed and Save dropped it -- and before that,
  // kept only Active, Start and Count of it.
  const before = await keep(request, 'co-other');
  try {
    const entry = {
      type: 'FppTestsPluginOutput', enabled: 0, startChannel: 11, channelCount: 22,
      someSetting: 'kept', nested: { a: 1, b: [2, 3] },
    };
    const r = await request.post('/api/channel/output/co-other', { data: { channelOutputs: [entry] } });
    expect(r.ok(), await r.text()).toBe(true);
    await page.goto('/channeloutputs.php');
    await page.locator('#tab-other-Misc-tab').click({ timeout: 15_000 });
    const row = page.locator('#tblOther-Misc tbody tr').first();
    await expect(row).toContainText('FppTestsPluginOutput');
    await row.locator('input.start').fill('12');
    await page.locator('#tab-other-Misc input[value="Save"]:not(.Zebra_Pin_Clone *)').click();
    await expect.poll(async () => (await saved(request, 'co-other'))?.channelOutputs?.[0]?.startChannel,
      { timeout: 15_000 }).toBe(12);
    const got = (await saved(request, 'co-other')).channelOutputs[0];
    expect(got.type).toBe('FppTestsPluginOutput');
    expect(got.someSetting).toBe('kept');
    expect(got.nested).toEqual({ a: 1, b: [2, 3] });
    expect(got.channelCount).toBe(22);
  } finally {
    await restore(request, 'co-other', before);
  }
});

test('a DDP row is saved with a universe count of 1, whatever its hidden field held', async ({ page, request }) => {
  // Regression: 693b2c544.  The universe-count input is hidden for DDP and
  // Twinkly rows, but its value was still read and saved, so such a row kept
  // whatever count was left in the config.
  const before = await keep(request, 'universeOutputs');
  try {
    const r = await request.post('/api/channel/output/universeOutputs', {
      data: {
        channelOutputs: [{
          type: 'universes', enabled: 1, startChannel: 1, channelCount: 150, universes: [{
            active: 1, description: 'ddp', id: 1, startChannel: 1, channelCount: 150, type: 4,
            address: '192.0.2.10', priority: 0, monitor: 0, deDuplicate: 0, universeCount: 7,
          }],
        }],
      },
    });
    expect(r.ok(), await r.text()).toBe(true);
    await page.goto('/channeloutputs.php');
    await expect(page.locator('#tblUniversesBody tr')).toHaveCount(1, { timeout: 15_000 });
    await page.locator('#btnSaveUniverses').click();
    await expect.poll(async () => (await saved(request, 'universeOutputs'))?.channelOutputs?.[0]?.universes?.[0]?.universeCount,
      { timeout: 15_000 }).toBe(1);
  } finally {
    await restore(request, 'universeOutputs', before);
  }
});
