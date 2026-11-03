import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The SPI-WS2801 output (Raspberry Pi only) on the SPI tab of the Channel
// Outputs page (co-other.php, co-other-modules.php).  Its module passed the
// SPI device list one argument too early to OtherBaseDevice, whose arguments
// are (name, friendly name, max channels, fixed start, fixed channels,
// devices, config): the list landed in "fixed channels" (so the channel
// count was locked) and the PI36 default in "devices" (so the device select
// offered nothing, and PI36 was not a field of the saved row).  Fixed by
// 65ab5b503.

test.skip(!container, 'adds a device node, the platform file and changes the output config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const NODE = '/dev/spidev0.0';
let before: string | null = null;
test.beforeEach(async ({ request }) => {
  inPlayer('sh', '-c', `mkdir -p /etc/fpp && echo 'Raspberry Pi' > ${PLATFORM}`);
  inPlayer('touch', NODE);
  const r = await request.get('/api/channel/output/co-other');
  before = r.ok() ? await r.text() : null;
  // The SPI tab is there once an output of its category is.
  const p = await request.post('/api/channel/output/co-other', { data: { channelOutputs: [{
    type: 'GenericSPI', enabled: 0, startChannel: 1, channelCount: 3, device: 'spidev0.0', speed: 50 }] } });
  expect(p.ok(), await p.text()).toBe(true);
});
test.afterEach(async ({ request }) => {
  inPlayer('rm', '-f', NODE, PLATFORM);
  await request.post('/api/channel/output/co-other', { data: Buffer.from(before ?? '{"channelOutputs": []}') });
});

const rows = (page: Page) => page.locator('#tblOther-SPI > tbody > tr');

async function openSPI(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php?t=' + Date.now());
  await expect(page.locator('#addOutputCategoryMenu')).toBeAttached({ timeout: 15_000 });
  await page.locator('#tab-other-SPI-tab').click();
  await expect(rows(page)).toHaveCount(1);
}

test('an SPI-WS2801 output offers the SPI devices, an editable channel count and a PI36 option that is saved', async ({ page, request }) => {
  await openSPI(page);
  await page.locator('#tab-other-SPI button', { hasText: 'Add' }).click();
  await page.locator('#outputType-SPI').selectOption('SPIws2801');
  await expect(rows(page), 'the row is added').toHaveCount(2);
  const row = rows(page).last();

  // The device select offers the SPI device.
  // (A new row also carries a stray "undefined" option, selected, for the
  // device its config does not have yet -- every device output does; not
  // this test's business, so the device is chosen explicitly.)
  await expect(row.locator('select.device option[value="spidev0.0"]'), 'the SPI device is offered').toHaveCount(1);
  await expect(row.locator('select.device option[value="pi36"]'), 'the PI36 default is not a device').toHaveCount(0);
  await row.locator('select.device').selectOption('spidev0.0');
  // The channel count starts at the module's maximum and can be changed.
  await expect(row.locator('input.count')).toHaveValue('1530');
  await expect(row.locator('input.count'), 'the channel count is not fixed').toBeEnabled();
  await expect(row.locator('input.start')).toBeEnabled();
  await row.locator('input.count').fill('600');
  await expect(row.locator('input.pi36')).not.toBeChecked();
  await row.locator('input.pi36').check();

  await page.locator('#tab-other-SPI input[value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await expect(page.locator('#jGrowl')).toContainText('Channel Output Configuration Saved');
  const saved = await (await request.get('/api/channel/output/co-other')).json();
  const out = saved.channelOutputs.find((o: any) => o.type === 'SPIws2801');
  expect(out, JSON.stringify(saved)).toBeTruthy();
  expect(out.device).toBe('spidev0.0');
  expect(out.channelCount).toBe(600);
  expect(out.pi36).toBe(1);

  // It comes back from the file as it was saved.
  await page.goto('/channeloutputs.php?t=' + Date.now());
  await page.locator('#tab-other-SPI-tab').click();
  await expect(rows(page)).toHaveCount(2);
  const back = rows(page).last();
  await expect(back.locator('select.device')).toHaveValue('spidev0.0');
  await expect(back.locator('input.count')).toHaveValue('600');
  await expect(back.locator('input.count')).toBeEnabled();
  await expect(back.locator('input.pi36')).toBeChecked();
});
