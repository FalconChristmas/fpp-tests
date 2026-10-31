import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { inPlayer } from './container';

// Small behaviours of the "Other" channel output tabs (co-other.php,
// co-other-modules.php), each over an output the test saves first.

let before: string | null = null;

async function put(request: APIRequestContext, outputs: object[]) {
  const r = await request.post('/api/channel/output/co-other', { data: { channelOutputs: outputs } });
  expect(r.ok(), await r.text()).toBe(true);
}
async function saved(request: APIRequestContext) {
  return (await (await request.get('/api/channel/output/co-other')).json()).channelOutputs as any[];
}

test.beforeEach(async ({ request }) => {
  const r = await request.get('/api/channel/output/co-other');
  before = r.ok() ? await r.text() : null;
});
test.afterEach(async ({ request }) => {
  await request.post('/api/channel/output/co-other', { data: Buffer.from(before ?? '{"channelOutputs": []}') });
});

const tab = (page: Page, cat: string) => page.locator(`#tab-other-${cat}-tab`);
const rows = (page: Page, cat: string) => page.locator(`#tblOther-${cat} > tbody > tr`);

async function open(page: Page, cat: string) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await expect(page.locator('#addOutputCategoryMenu')).toBeAttached({ timeout: 15_000 });
  await tab(page, cat).click();
}

const udp = { type: 'GenericUDP', enabled: 1, startChannel: 1, channelCount: 3, address: '127.0.0.1', port: 9999,
  tokenData: '{data}', description: '' };
const vmatrix = { type: 'VirtualMatrix', enabled: 0, startChannel: 1, channelCount: 4608, width: 32, height: 16,
  layout: '32x16', colorOrder: 'RGB', invert: 0, device: 'fb0', scaling: 'Hardware', modelName: '' };

test('the channel count cell holds the count field and nothing else', async ({ page, request }) => {
  // Regression: d21af85a5.  The cell printed the output's count after its
  // own field, so the number showed twice.
  await put(request, [udp]);
  await open(page, 'DMXSerial');
  const cell = rows(page, 'DMXSerial').first().locator('td:has(> input.count)');
  await expect(cell).toHaveCount(1);
  expect((await cell.evaluate((td: HTMLElement) => td.textContent)) ?? '').toBe('');
});

test('changing a virtual display\'s size sets its channel count to width x height x 3', async ({ page, request }) => {
  // Regression: a6a16e8d8.  The count was divided by the pixel scaling too,
  // so a display with a scaled pixel got too few channels.
  await put(request, [{ ...vmatrix, scaling: '2' }]);
  await open(page, 'VirtualDisplay');
  const row = rows(page, 'VirtualDisplay').first();
  await row.locator('input.width').fill('10');
  await row.locator('input.height').fill('5');
  await row.locator('input.height').dispatchEvent('change');
  await expect(row.locator('input.count')).toHaveValue('150');
});

test('a Control Channel output\'s preset rows can be removed one at a time', async ({ page, request }) => {
  // Feature: 6dc4a5455.  A preset row could only be added, never taken away.
  await put(request, [{ type: 'ControlChannel', enabled: 0, startChannel: 40, channelCount: 1,
    values: [{ value: 1, preset: '' }, { value: 2, preset: '' }] }]);
  await open(page, 'ControlSignal');
  const presetRows = page.locator('#tab-other-ControlSignal .presetRow');
  await expect(presetRows).toHaveCount(2);
  await presetRows.first().locator('input[value="Remove Row"]').click();
  await expect(presetRows).toHaveCount(1);
  await page.locator('#tab-other-ControlSignal input[value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await expect.poll(async () => ((await saved(request)).find((o) => o.type === 'ControlChannel')?.values ?? []).length,
    { timeout: 15_000 }).toBe(1);
});

const pca = (ports: object[]) => ({
  type: 'PCA9685', enabled: 0, startChannel: 1, channelCount: 16, device: 'i2c-1', deviceID: 64, frequency: 50, asUsec: 1, ports,
});
const port = (extra: object) => ({ dataType: 0, zeroBehavior: 0, min: 1000, max: 2000, center: 1500, description: '', ...extra });

test('a PCA9685 port shows and saves its type, brightness and gamma', async ({ page, request }) => {
  // Feature: 71110fb41.  The PCA9685's page offered servo settings only; the
  // backend's LED mode (type, brightness, gamma) had no controls.  The
  // page offers the I2C outputs when /dev has an i2c-N; a file of that name
  // is all it looks for.
  inPlayer('touch', '/dev/i2c-1');
  try {
    await put(request, [pca([port({ type: 'LED', brightness: 50, gamma: 2.2, description: 'fpp-tests led' })])]);
    await open(page, 'PWM');
    const row = rows(page, 'PWM').first();
    await expect(row.locator('select.type0')).toHaveValue('LED');
    await expect(row.locator('select.brightness0')).toHaveValue('50');
    await expect(row.locator('input.gamma0')).toHaveValue('2.2');
    await row.locator('select.type0').selectOption('Servo');
    await row.locator('select.brightness0').selectOption('75');
    await row.locator('input.gamma0').fill('1.8');
    await page.locator('#tab-other-PWM input[value="Save"]:not(.Zebra_Pin_Clone *)').click();
    await expect.poll(async () => (await saved(request)).find((o) => o.type === 'PCA9685')?.ports?.[0]?.gamma,
      { timeout: 15_000 }).toBe(1.8);
    const p0 = (await saved(request)).find((o) => o.type === 'PCA9685').ports[0];
    expect([p0.type, p0.brightness, p0.gamma]).toEqual(['Servo', 75, 1.8]);
  } finally {
    inPlayer('rm', '-f', '/dev/i2c-1');
  }
});
