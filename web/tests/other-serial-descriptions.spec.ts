import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container } from './container';

// The DMX / Serial outputs of Channel Outputs each carry a description
// (DMX USB, Pixelnet, Generic Serial, Renard and LOR).  The saved
// co-other.json is the receiving end: the page has to read the description
// into its input and write the edited one back.

test.skip(!container, 'uses the run-web.sh container\'s co-other.json');

const base = { enabled: 0, startChannel: 1, device: '/dev/ttyUSB0' };
const OUTPUTS = [
  { ...base, type: 'DMX-Pro', channelCount: 512, description: 'dmx desc' },
  { ...base, type: 'Pixelnet-Lynx', channelCount: 4096, description: 'lynx desc' },
  { ...base, type: 'GenericSerial', channelCount: 8, speed: 9600, header: '', footer: '', description: 'generic desc' },
  { ...base, type: 'Renard', channelCount: 16, renardspeed: 57600, renardparm: '8N1', description: 'renard desc' },
  { ...base, type: 'LOR', channelCount: 16, speed: 19200, firstControllerId: 1, description: 'lor desc' },
];

async function saved(request: APIRequestContext) {
  return (await (await request.get('/api/channel/output/co-other')).json()).channelOutputs as any[];
}

let before: string | null = null;
test.beforeEach(async ({ request }) => {
  const r = await request.get('/api/channel/output/co-other');
  before = r.ok() ? await r.text() : null;
  const w = await request.post('/api/channel/output/co-other', { data: { channelOutputs: OUTPUTS } });
  expect(w.ok(), await w.text()).toBe(true);
});
test.afterEach(async ({ request }) => {
  await request.post('/api/channel/output/co-other', { data: Buffer.from(before ?? '{"channelOutputs": []}') });
});

const rows = (page: Page) => page.locator('#tblOther-DMXSerial > tbody > tr');

test('the serial outputs show their description and save an edited one', async ({ page, request }) => {
  // Regression: 97ad58e9f.  Only the device was read and written for the
  // USB DMX, Pixelnet, Generic Serial, Renard and LOR outputs, so there was
  // no description to tell two of them apart.
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await expect(page.locator('#tab-other-DMXSerial-tab')).toBeAttached({ timeout: 15_000 });
  await page.locator('#tab-other-DMXSerial-tab').click();
  await expect(rows(page)).toHaveCount(OUTPUTS.length);
  for (let i = 0; i < OUTPUTS.length; i++) {
    await expect(rows(page).nth(i).locator('input.description'), OUTPUTS[i].type).toHaveValue(OUTPUTS[i].description);
    await rows(page).nth(i).locator('input.description').fill(`edited ${OUTPUTS[i].type}`);
  }
  await page.locator('#tab-other-DMXSerial input[value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await expect.poll(async () => (await saved(request)).map((o) => o.description), { timeout: 15_000 })
    .toEqual(OUTPUTS.map((o) => `edited ${o.type}`));
  const got = await saved(request);
  expect(got.map((o) => o.type)).toEqual(OUTPUTS.map((o) => o.type));
  expect(got.map((o) => o.device), 'the device is kept').toEqual(OUTPUTS.map(() => '/dev/ttyUSB0'));
});
