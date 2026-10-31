import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The "Other" channel outputs (co-other.json), which Channel Outputs shows as
// one tab per category of output (DMX / Serial, Virtuals, Control Signal...),
// added from the Add Output Group menu.  fppd reloads its outputs whenever
// co-other.json is written, so what it loads from the saved file is the
// receiving end: its log says which outputs it started, and on which channels.

test.skip(!container, 'reads fppd\'s log inside the run-web.sh container');

const LOG = '/home/fpp/media/logs/fppd.log';

async function keep(request: APIRequestContext) {
  const r = await request.get('/api/channel/output/co-other');
  return r.ok() ? await r.text() : null;
}

async function put(request: APIRequestContext, outputs: object[]) {
  const r = await request.post('/api/channel/output/co-other', { data: { channelOutputs: outputs } });
  expect(r.ok(), await r.text()).toBe(true);
}

async function saved(request: APIRequestContext) {
  return (await (await request.get('/api/channel/output/co-other')).json()).channelOutputs as any[];
}

let before: string | null = null;

test.beforeEach(async ({ request }) => {
  before = await keep(request);
});

test.afterEach(async ({ request }) => {
  await request.post('/api/channel/output/co-other', { data: Buffer.from(before ?? '{"channelOutputs": []}') });
});

// fppd's log lines from here on.
function logMark(): number {
  return parseInt(inPlayer('sh', '-c', `wc -c < ${LOG}`).trim(), 10);
}

function logSince(mark: number): string {
  return inPlayer('sh', '-c', `tail -c +${mark + 1} ${LOG}`);
}

const udp = (address: string, start: number) => ({
  type: 'GenericUDP', enabled: 1, startChannel: start, channelCount: 3, address, port: 9999,
  tokenData: '{data}', description: '',
});
const vmatrix = { type: 'VirtualMatrix', enabled: 0, startChannel: 1, channelCount: 4608, width: 32, height: 16,
                  layout: '32x16', colorOrder: 'RGB', invert: 0, device: 'fb0', scaling: 'Hardware', modelName: '' };
const control = { type: 'ControlChannel', enabled: 0, startChannel: 40, channelCount: 1, presets: [] };

const tab = (page: Page, cat: string) => page.locator(`#tab-other-${cat}-tab`);
const rows = (page: Page, cat: string) => page.locator(`#tblOther-${cat} > tbody > tr`);

async function open(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await expect(page.locator('#addOutputCategoryMenu')).toBeAttached({ timeout: 15_000 });
}

test('each category of Other output has its own tab, and an output added in one is saved and loaded', async ({ page, request }) => {
  // Also 03fbc510b: co-other.php asks for the saved outputs when the page is
  // ready (its own page-load hooks are never called on this tab).
  // Feature: 24b46caa3 (#1467).  The single "Other" tab became one tab per
  // category, each with its own table, Add and Save.
  await put(request, [udp('127.0.0.1', 1), vmatrix, control]);
  await open(page);
  await expect(tab(page, 'DMXSerial')).toHaveText('DMX / Serial');
  await expect(tab(page, 'VirtualDisplay')).toBeAttached();
  await expect(tab(page, 'ControlSignal')).toBeAttached();
  await expect(tab(page, 'GPIO'), 'a category with no outputs gets no tab').toHaveCount(0);
  await tab(page, 'DMXSerial').click();
  await expect(rows(page, 'DMXSerial')).toHaveCount(1);
  await expect(rows(page, 'DMXSerial').first()).toContainText('Generic UDP');
  await tab(page, 'VirtualDisplay').click();
  await expect(rows(page, 'VirtualDisplay')).toHaveCount(1);

  // Add a second UDP output in the DMX / Serial tab.
  await tab(page, 'DMXSerial').click();
  await page.locator('#tab-other-DMXSerial button', { hasText: 'Add' }).click();
  await page.locator('#outputType-DMXSerial').selectOption('GenericUDP');
  const added = rows(page, 'DMXSerial').nth(1);
  await added.locator('input.act').check();
  await added.locator('input.start').fill('20');
  await added.locator('input.count').fill('3');
  await added.locator('input.address').fill('127.0.0.2');
  const mark = logMark();
  await page.locator('#tab-other-DMXSerial input[value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await expect.poll(async () => (await saved(request)).length, { timeout: 15_000 }).toBe(4);
  const got = await saved(request);
  expect(got.filter((o) => o.type === 'GenericUDP').map((o) => [o.address, o.startChannel]).sort())
    .toEqual([['127.0.0.1', 1], ['127.0.0.2', 20]]);
  expect(got.map((o) => o.type).sort(), 'the other tabs\' outputs are saved too')
    .toEqual(['ControlChannel', 'GenericUDP', 'GenericUDP', 'VirtualMatrix']);

  // fppd reloads the file and starts the added output on its channels
  // (0-based 19-21).
  await expect.poll(() => logSince(mark), { timeout: 15_000 })
    .toMatch(/GenericUDPOutput: Determined range needed 19 - 21/);

  // And the page reads it back into the same tabs.
  await page.reload();
  await expect(tab(page, 'DMXSerial')).toBeAttached({ timeout: 15_000 });
  await tab(page, 'DMXSerial').click();
  await expect(rows(page, 'DMXSerial')).toHaveCount(2);
});

test('Add Output Group offers only the groups that have no tab yet', async ({ page, request }) => {
  // Regression: 322eefd87.  The menu listed every group, those already
  // showing a tab included, and was not updated as groups were added.
  await put(request, [udp('127.0.0.1', 1)]);
  await open(page);
  const menu = page.locator('#addOutputCategoryMenu');
  const items = () => menu.locator('a.dropdown-item').allInnerTexts();
  expect(await items()).not.toContain('DMX / Serial');
  expect(await items()).toContain('Virtuals');
  // Each group added leaves the menu.
  while ((await items()).length > 0) {
    const next = (await items())[0];
    await page.locator('#tab-other-add, [data-bs-toggle="dropdown"]').filter({ hasText: 'Add Output Group' }).click();
    await menu.locator('a.dropdown-item', { hasText: next }).click();
    await expect.poll(items).not.toContain(next);
  }
  await expect(menu).toContainText('All groups already added');
});

test('a Virtual Display row is drawn with its pixel size select filled in', async ({ page, request }) => {
  // Regression: 9696ed402 (#2636).  The pixel size loop assigned an
  // undeclared "i" inside a class method, which is strict code: a
  // ReferenceError, and the row was never drawn.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await put(request, [{ type: 'VirtualDisplay', enabled: 0, startChannel: 1, channelCount: 150, modelName: '',
                        pixelSize: 3, description: '' }]);
  await open(page);
  await tab(page, 'VirtualDisplay').click();
  await expect(rows(page, 'VirtualDisplay')).toHaveCount(1);
  const size = rows(page, 'VirtualDisplay').first().locator('select.pixelSize');
  await expect(size.locator('option')).toHaveCount(10);
  await expect(size).toHaveValue('3');
  expect(errors).toEqual([]);
});
