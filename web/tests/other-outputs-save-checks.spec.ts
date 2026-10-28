import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// What the Other outputs tabs of Channel Outputs refuse to save.  A refused
// row leaves co-other.json as it was, so fppd, which reloads its outputs
// whenever the file is written, loads nothing new: the file and fppd's log
// are the receiving end.

test.skip(!container, 'reads fppd\'s log inside the run-web.sh container');

const LOG = '/home/fpp/media/logs/fppd.log';

const udp = { type: 'GenericUDP', enabled: 1, startChannel: 1, channelCount: 3, address: '127.0.0.1', port: 9999,
              tokenData: '{data}', description: '' };

async function stored(request: APIRequestContext): Promise<string> {
  return (await request.get('/api/channel/output/co-other')).text();
}

let before: string | null = null;
test.beforeEach(async ({ request }) => {
  const r = await request.get('/api/channel/output/co-other');
  before = r.ok() ? await r.text() : null;
  const w = await request.post('/api/channel/output/co-other', { data: { channelOutputs: [udp] } });
  expect(w.ok(), await w.text()).toBe(true);
});
test.afterEach(async ({ request }) => {
  await request.post('/api/channel/output/co-other', { data: Buffer.from(before ?? '{"channelOutputs": []}') });
});

const logMark = () => parseInt(inPlayer('sh', '-c', `wc -c < ${LOG}`).trim(), 10);
const logSince = (mark: number) => inPlayer('sh', '-c', `tail -c +${mark + 1} ${LOG}`);

async function openRow(page: Page) {
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-other-DMXSerial-tab').click();
  const row = page.locator('#tblOther-DMXSerial > tbody > tr').first();
  await expect(row).toContainText('Generic UDP', { timeout: 15_000 });
  return row;
}

for (const [field, value, message] of [
  ['count', '-3', "Invalid Channel Count '-3' on row 1"],
  ['start', '0', "Invalid Start Channel '0' on row 1"],
  ['start', '-5', "Invalid Start Channel '-5' on row 1"],
] as const) {
  test(`a ${field === 'count' ? 'channel count' : 'start channel'} of ${value} is refused, and nothing reaches fppd`, async ({ page, request }) => {
    // Regression: 8c87dd6c6.  Save checked only that both were numbers: a
    // negative count reached fppd as a count of about 4 billion, and a
    // start below 1 was saved for fppd to refuse at load time.
    const row = await openRow(page);
    await row.locator(`input.${field}`).fill(value);
    const file = await stored(request);
    const mark = logMark();
    await page.locator('#tab-other-DMXSerial input[value="Save"]:not(.Zebra_Pin_Clone *)').click();
    await expect(page.locator('#dialogOKPopup')).toContainText(message);
    // Long enough for a save and fppd's reload, had there been one.
    await page.waitForTimeout(2000);
    expect(await stored(request), 'co-other.json').toBe(file);
    expect(logSince(mark)).not.toMatch(/GenericUDPOutput/);

    // The control: a valid value saves, and fppd reloads the output.
    await page.locator('#dialogOKPopup button', { hasText: 'Close' }).click();
    await row.locator(`input.${field}`).fill(field === 'count' ? '6' : '4');
    const valid = logMark();
    await page.locator('#tab-other-DMXSerial input[value="Save"]:not(.Zebra_Pin_Clone *)').click();
    await expect.poll(() => logSince(valid), { timeout: 15_000 })
      .toMatch(field === 'count' ? /GenericUDPOutput: Determined range needed 0 - 5/ : /GenericUDPOutput: Determined range needed 3 - 5/);
  });
}

test('saving the Other outputs turns test mode off', async ({ page, request }) => {
  // Feature: 05cc45f5c.  Saving an output config ends a running test pattern.
  const row = await openRow(page);
  const t = await request.post('/api/command', { data: { command: 'Test Start', args: ['1000', 'RGB Cycle', '1-3', 'R-G-B'] } });
  expect(t.ok()).toBe(true);
  try {
    await expect.poll(async () => (await (await request.get('/api/testmode')).json()).enabled).toBe(1);
    await row.locator('input.count').fill('6');
    await page.locator('#tab-other-DMXSerial input[value="Save"]:not(.Zebra_Pin_Clone *)').click();
    await expect.poll(async () => JSON.parse(await stored(request)).channelOutputs[0].channelCount, { timeout: 15_000 }).toBe(6);
    await expect.poll(async () => (await (await request.get('/api/testmode')).json()).enabled, { timeout: 10_000 }).toBe(0);
  } finally {
    await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
  }
});
