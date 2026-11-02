import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// Adding an output that needs a device (the Generic SPI one) on the SPI tab
// of the Channel Outputs page (co-other.php, co-other-modules.php) when the
// device list is empty.  The page offers Generic SPI only where /dev has a
// spidevN.M (a file of that name is all it looks for), so the page is served
// with that device taken back out of its SPIDevices list.  The virtual
// matrix's own message is in virtual-matrix-add-output.spec.ts.

test.skip(!container, 'adds a device node and changes the output config inside the run-web.sh container');

const NODE = '/dev/spidev7.0';
let before: string | null = null;
test.beforeEach(async ({ request }) => {
  inPlayer('touch', NODE);
  const r = await request.get('/api/channel/output/co-other');
  before = r.ok() ? await r.text() : null;
  // The SPI tab is there once an output of its category is.
  const p = await request.post('/api/channel/output/co-other', { data: { channelOutputs: [{
    type: 'GenericSPI', enabled: 0, startChannel: 1, channelCount: 3, device: 'spidev7.0', speed: 50 }] } });
  expect(p.ok(), await p.text()).toBe(true);
});
test.afterEach(async ({ request }) => {
  inPlayer('rm', '-f', NODE);
  await request.post('/api/channel/output/co-other', { data: Buffer.from(before ?? '{"channelOutputs": []}') });
});

const rows = (page: Page) => page.locator('#tblOther-SPI > tbody > tr');

async function addSPI(page: Page, withDevice: boolean) {
  const alerts: string[] = [];
  page.on('dialog', (d) => { alerts.push(d.message()); void d.accept(); });
  if (!withDevice) {
    await page.route('**/channeloutputs.php*', async (route) => {
      const r = await route.fetch();
      const html = (await r.text()).replace(/SPIDevices\['spidev7\.0'\] = 'spidev7\.0';/, '');
      await route.fulfill({ response: r, body: html });
    });
  }
  await page.goto('/channeloutputs.php');
  await expect(page.locator('#addOutputCategoryMenu')).toBeAttached({ timeout: 15_000 });
  await page.locator('#tab-other-SPI-tab').click();
  await expect(rows(page)).toHaveCount(1);
  await page.locator('#tab-other-SPI button', { hasText: 'Add' }).click();
  await page.locator('#outputType-SPI').selectOption('GenericSPI');
  return alerts;
}

test('adding an output type that has no device says so and adds no row', async ({ page }) => {
  // Regression: 59a8e988d.  An output type whose device list was empty was
  // refused silently: the Add did nothing and gave no reason.
  const alerts = await addSPI(page, false);
  await expect.poll(() => alerts, { message: 'the page explains' }).toEqual(
    ['There are no available devices for this channel output type.']);
  await expect(rows(page), 'no row is added').toHaveCount(1);
});

test('adding the same output type with a device present adds a row and no message', async ({ page }) => {
  // The control for the test above: the refusal is the empty device list's.
  const alerts = await addSPI(page, true);
  await expect(rows(page)).toHaveCount(2);
  expect(alerts).toEqual([]);
});
