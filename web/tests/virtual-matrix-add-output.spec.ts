import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container } from './container';

// Adding a Virtual Matrix output on the Virtual Display tab of the Channel
// Outputs page (co-other.php, co-other-modules.php).  The container has no
// framebuffer device and no framebuffer Pixel Overlay Model, so the page is
// served with a device added to its FBDevices list where a test needs one.

test.skip(!container, "changes the player's output config");

let before: string | null = null;
test.beforeEach(async ({ request }) => {
  const r = await request.get('/api/channel/output/co-other');
  before = r.ok() ? await r.text() : null;
  // The Virtual Display tab is there once an output of its category is.
  const p = await request.post('/api/channel/output/co-other', { data: { channelOutputs: [{
    type: 'VirtualMatrix', enabled: 0, startChannel: 1, channelCount: 4608, width: 32, height: 16,
    layout: '32x16', colorOrder: 'RGB', invert: 0, device: 'fb0', scaling: 'Hardware', modelName: '' }] } });
  expect(p.ok(), await p.text()).toBe(true);
});
test.afterEach(async ({ request }) => {
  await request.post('/api/channel/output/co-other', { data: Buffer.from(before ?? '{"channelOutputs": []}') });
});

async function open(page: Page, withFramebuffer: boolean) {
  const alerts: string[] = [];
  page.on('dialog', (d) => { alerts.push(d.message()); void d.accept(); });
  if (withFramebuffer) {
    await page.route('**/channeloutputs.php*', async (route) => {
      const r = await route.fetch();
      const html = (await r.text()).replace('var FBDevices = new Array();',
        "var FBDevices = new Array(); FBDevices['HDMI-A-1'] = 'HDMI-A-1';");
      await route.fulfill({ response: r, body: html });
    });
  }
  await page.goto('/channeloutputs.php');
  await expect(page.locator('#addOutputCategoryMenu')).toBeAttached({ timeout: 15_000 });
  await page.locator('#tab-other-VirtualDisplay-tab').click();
  return alerts;
}

const rows = (page: Page) => page.locator('#tblOther-VirtualDisplay > tbody > tr');

async function addMatrix(page: Page) {
  await expect(rows(page)).toHaveCount(1);
  await page.locator('#tab-other-VirtualDisplay button', { hasText: 'Add' }).click();
  await page.locator('#outputType-VirtualDisplay').selectOption('VirtualMatrix');
}

test('a Virtual Matrix is not added when there is no Pixel Overlay Model and no framebuffer device', async ({ page }) => {
  // Regression: 69adec2d6.  With nothing for it to draw on, a Virtual Matrix
  // row was added anyway, with no device or size; the page now says so and
  // drops the row.
  const alerts = await open(page, false);
  await addMatrix(page);
  await expect.poll(() => alerts, { message: 'the page explains' }).toEqual(
    ['There are no Pixel Overlay Models defined and no FrameBuffer devices available.']);
  await expect(rows(page), 'the new row is dropped').toHaveCount(1);
});

test('a new Virtual Matrix with no model to draw on starts at the default size', async ({ page }) => {
  // Regression: 69adec2d6.  A new row has no device in its config; the
  // device and size were read from it anyway (undefined), and the row's
  // fields were not drawn, instead of the default size.
  const alerts = await open(page, true);
  await addMatrix(page);
  await expect(rows(page)).toHaveCount(2);
  const row = rows(page).nth(1);
  await expect(row.locator('input.width')).toHaveValue('192');
  await expect(row.locator('input.height')).toHaveValue('108');
  expect(alerts).toEqual([]);
});

test('a new Virtual Matrix with no model to draw on starts with channels for its default size', async ({ page }) => {
  // Regression: 6b610f3c5.  The channel count of a new Virtual Matrix or
  // Display output was left as it was instead of width x height x 3.
  await open(page, true);
  await addMatrix(page);
  const row = rows(page).nth(1);
  await expect(row.locator('input.count')).toHaveValue(String(192 * 108 * 3));
});
